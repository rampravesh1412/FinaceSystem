import { Types, type FilterQuery } from "mongoose";
import {
  applyRate,
  endOfDay,
  startOfDay,
  type CreateSavingsAccountInput,
  type SavingsAccountSummary,
  type SavingsSummary,
  type SavingsTransactionInput,
} from "@amiri/shared";
import {
  Branch,
  LedgerAccount,
  LedgerEntry,
  SavingsAccount,
  Transaction,
  nextSequence,
  type SavingsAccountDoc,
  type TransactionDoc,
} from "../../models/index.js";
import { BadRequestError, InsufficientBalanceError, NotFoundError } from "../../lib/errors.js";
import { escapeRegex, type Paging } from "../../lib/http.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as accounts from "../../services/accounts.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Bachat Khata — member savings (§13).
 *
 * The member's account is a LIABILITY on our books: the money is theirs, we hold it. That
 * classification is what makes the balance sheet come out right — a deposit increases both
 * the cash we hold (asset) and what we owe the member (liability), netting to zero effect
 * on our own worth, which is correct because none of it is ours.
 *
 *     Deposit ₹5,000     DR Cash          5,000
 *                            CR Member savings    5,000
 *
 *     Withdrawal ₹2,000  DR Member savings 2,000
 *                            CR Cash              2,000
 *
 *     Interest ₹300      DR Interest expense 300
 *                            CR Member savings      300
 */

export async function createAccount(
  input: CreateSavingsAccountInput,
  ctx: audit.AuditContext,
): Promise<SavingsAccountDoc> {
  const branch = await Branch.findById(input.branchId).select("code status").lean();
  if (!branch) throw new NotFoundError("Branch", input.branchId);
  if (branch.status !== "ACTIVE") throw new BadRequestError("That branch is not active", "branchId");

  return withTransaction(async (session) => {
    const seq = await nextSequence(`SAVINGS-${branch.code}`, 0, session);
    const accountNo = `SB-${branch.code}-${String(seq).padStart(5, "0")}`;

    const ledgerAccount = await ledger.createLedgerAccount(
      {
        code: `SAV-${branch.code}-${String(seq).padStart(4, "0")}`,
        name: `${input.memberName} (${accountNo})`,
        kind: "SAVINGS",
        branchId: input.branchId,
        refKind: "SavingsAccount",
        // A member's balance cannot go below zero — they can only withdraw what they have
        // deposited. Unlike a bank account there is no overdraft to grant.
        enforceBalance: true,
        createdBy: ctx.userId,
      },
      session,
    );

    const [account] = await SavingsAccount.create(
      [
        {
          accountNo,
          memberName: input.memberName,
          partyId: input.partyId ?? null,
          mobile: input.mobile,
          branchId: input.branchId,
          ledgerAccountId: ledgerAccount._id,
          interestRateBps: input.interestRateBps,
          notes: input.notes,
          openedAt: input.openingDate ?? new Date(),
          status: "ACTIVE",
          createdBy: ctx.userId,
        },
      ],
      { session },
    );

    if (!account) throw new Error("Savings account creation returned no document");
    await LedgerAccount.updateOne({ _id: ledgerAccount._id }, { $set: { refId: account._id } }, { session });

    await audit.record(
      { ...ctx, branchId: String(input.branchId) },
      {
        action: "CREATE",
        entity: "SavingsAccount",
        entityId: String(account._id),
        entityLabel: `${accountNo} — ${input.memberName}`,
        amount: input.openingBalance,
        newValue: { accountNo, memberName: input.memberName, openingBalance: input.openingBalance },
      },
      session,
    );

    // An opening deposit is a real posting against equity, like every other opening.
    await ledger.postOpeningBalance(
      {
        ledgerAccountId: ledgerAccount._id,
        branchId: input.branchId,
        // Expressed in the account's own terms: ₹10,000 means the member opens with
        // ₹10,000 to their name. `postOpeningBalance` picks the correct side from the
        // account class, so a credit-normal savings account is credited.
        amount: input.openingBalance,
        date: input.openingDate ?? new Date(),
        label: `${input.memberName} (${accountNo})`,
        createdBy: ctx.userId!,
      },
      session,
      { ...ctx, branchId: String(input.branchId) },
    );

    return account;
  }, { label: "savings.createAccount" });
}

/**
 * Post a deposit, withdrawal, interest credit or bonus.
 *
 * A withdrawal moves real cash, so it needs a settlement account. Interest and bonus are
 * accrued rather than paid out — they increase what we owe the member and land against an
 * expense head, with no cash movement at all.
 */
export async function postSavingsTransaction(
  input: SavingsTransactionInput,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  return withTransaction(async (session) => {
    const savings = await SavingsAccount.findById(input.savingsAccountId).session(session);
    if (!savings) throw new NotFoundError("Savings account", input.savingsAccountId);
    if (savings.status !== "ACTIVE") {
      throw new BadRequestError(`${savings.accountNo} is not active`, "savingsAccountId");
    }

    const branchId = String(savings.branchId);
    const isCashMovement = input.operation === "DEPOSIT" || input.operation === "WITHDRAWAL";

    if (isCashMovement && !input.accountId) {
      throw new BadRequestError(
        "Choose the account the money moves through",
        "accountId",
      );
    }

    const settlement = input.accountId
      ? await accounts.resolveAccount(input.accountId, session)
      : null;

    const lines: ledger.PostingLine[] = [];

    switch (input.operation) {
      case "DEPOSIT":
        lines.push(
          { ledgerAccountId: settlement!.ledgerAccountId, direction: "DEBIT", amount: input.amount },
          { ledgerAccountId: savings.ledgerAccountId, direction: "CREDIT", amount: input.amount },
        );
        break;

      case "WITHDRAWAL": {
        // Checked explicitly so the member sees their own shortfall rather than a generic
        // ledger refusal naming an internal account.
        const balance = (await LedgerAccount.findById(savings.ledgerAccountId)
          .select("cachedBalance")
          .session(session))!.cachedBalance;
        if (input.amount > balance) {
          throw new InsufficientBalanceError(
            `${savings.memberName} (${savings.accountNo})`,
            balance,
            input.amount,
          );
        }
        lines.push(
          { ledgerAccountId: savings.ledgerAccountId, direction: "DEBIT", amount: input.amount },
          { ledgerAccountId: settlement!.ledgerAccountId, direction: "CREDIT", amount: input.amount },
        );
        break;
      }

      case "INTEREST":
      case "BONUS": {
        // Our expense, their gain. No cash moves — it accrues to the member's balance.
        const expenseId = await ledger.systemAccountId("BANK_CHARGES", session);
        lines.push(
          { ledgerAccountId: expenseId, direction: "DEBIT", amount: input.amount },
          { ledgerAccountId: savings.ledgerAccountId, direction: "CREDIT", amount: input.amount },
        );
        break;
      }

      default:
        throw new BadRequestError(`Unsupported savings operation`, "operation");
    }

    const txn = await ledger.postTransaction(
      {
        type: "SAVINGS",
        date: input.date,
        branchId,
        lines,
        grossAmount: input.amount,
        paymentMode: input.paymentMode,
        referenceNo: input.referenceNo,
        narration:
          input.narration ??
          `${input.operation.charAt(0)}${input.operation.slice(1).toLowerCase()} — ${savings.memberName} (${savings.accountNo})`,
        partyId: savings.partyId ?? null,
        createdBy: ctx.userId!,
        details: {
          savingsAccountId: savings._id,
          accountNo: savings.accountNo,
          memberName: savings.memberName,
          operation: input.operation,
        },
      },
      session,
      { ...ctx, branchId },
    );

    return txn;
  }, { label: "savings.transaction" });
}

/**
 * Accrue a year's interest at the account's rate, pro-rated for the days elapsed.
 *
 * `applyRate` does the multiply in BigInt, so a large balance at a low rate is still
 * exact to the paisa.
 */
export function computeInterest(balance: number, rateBps: number, days: number): number {
  if (balance <= 0 || rateBps <= 0 || days <= 0) return 0;
  const annual = applyRate(balance, rateBps);
  return Math.round((annual * days) / 365);
}

/**
 * One savings account in the SAME shape the list returns.
 *
 * Used by the create route. The raw document has no `balance` — that lives on the linked
 * ledger account — so a caller opening an account with a ₹5,000 deposit got `undefined`
 * back for the one figure they wanted to confirm.
 */
export async function getAccountSummary(id: string): Promise<SavingsAccountSummary> {
  const { items } = await listAccounts(
    { _id: new Types.ObjectId(id) },
    {},
    { skip: 0, limit: 1, sort: { _id: 1 } } as never,
  );
  const found = items[0];
  if (!found) throw new NotFoundError("Savings account", id);
  return found;
}

export async function listAccounts(
  scopeFilter: Record<string, unknown>,
  filters: { q?: string; status?: string },
  page: Paging,
): Promise<{ items: SavingsAccountSummary[]; total: number; summary: SavingsSummary }> {
  const filter: FilterQuery<SavingsAccountDoc> = { ...scopeFilter };
  if (filters.status) filter.status = filters.status;
  if (filters.q?.trim()) {
    const rx = new RegExp(escapeRegex(filters.q.trim()), "i");
    filter.$or = [{ memberName: rx }, { accountNo: rx }, { mobile: rx }];
  }

  const [docs, total] = await Promise.all([
    SavingsAccount.find(filter)
      .sort(page.sort)
      .skip(page.skip)
      .limit(page.limit)
      .populate<{ branchId: { _id: Types.ObjectId; name: string; code: string } }>("branchId", "name code")
      .populate<{ ledgerAccountId: { _id: Types.ObjectId; cachedBalance: number } }>(
        "ledgerAccountId",
        "cachedBalance",
      )
      .lean(),
    SavingsAccount.countDocuments(filter),
  ]);

  // Totals across the whole scoped set, not the page.
  const allAccounts = await SavingsAccount.find({ ...scopeFilter }).select("ledgerAccountId status").lean();
  const allLedgerIds = allAccounts.map((a) => a.ledgerAccountId);
  const allBalances = await LedgerAccount.find({ _id: { $in: allLedgerIds } })
    .select("cachedBalance")
    .lean();

  const today = new Date();
  const [movement] = await LedgerEntry.aggregate<{ deposits: number; withdrawals: number }>([
    {
      $match: {
        ledgerAccountId: { $in: allLedgerIds },
        date: { $gte: startOfDay(today), $lte: endOfDay(today) },
      },
    },
    {
      $group: {
        _id: null,
        // A savings account is credit-normal: a CREDIT is money coming in from the member.
        deposits: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
        withdrawals: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
      },
    },
  ]);

  const lastTxn = await LedgerEntry.aggregate<{ _id: Types.ObjectId; last: Date }>([
    { $match: { ledgerAccountId: { $in: docs.map((d) => d.ledgerAccountId._id) } } },
    { $group: { _id: "$ledgerAccountId", last: { $max: "$date" } } },
  ]);
  const lastById = new Map(lastTxn.map((l) => [String(l._id), l.last]));

  return {
    items: docs.map((d) => ({
      id: String(d._id),
      accountNo: d.accountNo,
      memberName: d.memberName,
      mobile: d.mobile,
      branch: { id: String(d.branchId._id), name: d.branchId.name, code: d.branchId.code },
      balance: d.ledgerAccountId?.cachedBalance ?? 0,
      interestRateBps: d.interestRateBps,
      ledgerAccountId: String(d.ledgerAccountId._id),
      status: d.status,
      lastTransactionAt: lastById.get(String(d.ledgerAccountId._id))?.toISOString() ?? null,
      openedAt: d.openedAt.toISOString(),
    })),
    total,
    summary: {
      totalSavings: allBalances.reduce((s, b) => s + b.cachedBalance, 0),
      todayCollection: movement?.deposits ?? 0,
      todayWithdrawal: movement?.withdrawals ?? 0,
      memberCount: allAccounts.length,
      activeCount: allAccounts.filter((a) => a.status === "ACTIVE").length,
    },
  };
}

export async function getPassbook(
  savingsAccountId: string,
  scopeFilter: Record<string, unknown>,
  limit = 200,
) {
  const account = await SavingsAccount.findOne({ _id: savingsAccountId, ...scopeFilter })
    .populate<{ branchId: { name: string; code: string } }>("branchId", "name code")
    .populate<{ ledgerAccountId: { _id: Types.ObjectId; cachedBalance: number } }>(
      "ledgerAccountId",
      "cachedBalance",
    )
    .lean();

  if (!account) throw new NotFoundError("Savings account", savingsAccountId);

  const entries = await LedgerEntry.find({ ledgerAccountId: account.ledgerAccountId._id })
    .sort({ date: 1, _id: 1 })
    .limit(limit)
    .lean();

  const txnIds = [...new Set(entries.map((e) => String(e.transactionId)))];
  const txns = await Transaction.find({ _id: { $in: txnIds } }).select("status narration").lean();
  const byId = new Map(txns.map((t) => [String(t._id), t]));

  let running = 0;
  const rows = entries.map((e) => {
    const deposit = e.direction === "CREDIT" ? e.amount : 0;
    const withdrawal = e.direction === "DEBIT" ? e.amount : 0;
    running += deposit - withdrawal;
    return {
      id: String(e._id),
      date: e.date.toISOString(),
      txnNo: e.txnNo,
      narration: e.narration ?? byId.get(String(e.transactionId))?.narration,
      deposit,
      withdrawal,
      balance: running,
      isReversed: byId.get(String(e.transactionId))?.status === "REVERSED",
    };
  });

  return {
    account: {
      id: String(account._id),
      accountNo: account.accountNo,
      memberName: account.memberName,
      mobile: account.mobile,
      branch: account.branchId,
      balance: account.ledgerAccountId.cachedBalance,
      interestRateBps: account.interestRateBps,
      status: account.status,
      openedAt: account.openedAt.toISOString(),
    },
    entries: rows,
  };
}
