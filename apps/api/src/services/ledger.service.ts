import { Types, type ClientSession } from "mongoose";
import {
  ACCOUNT_KIND_CLASS,
  NORMAL_SIDE,
  TXN_PREFIX,
  fiscalYearOf,
  formatDocumentNumber,
  signFor,
  type AccountClass,
  type AccountKind,
  type Direction,
  type TransactionType,
} from "@amiri/shared";
import { LedgerAccount, SYSTEM_ACCOUNTS, type LedgerAccountDoc } from "../models/LedgerAccount.js";
import { LedgerEntry } from "../models/LedgerEntry.js";
import { Transaction, type TransactionDoc } from "../models/Transaction.js";
import { nextSequence } from "../models/Counter.js";
import { FinancialPeriod, type FinancialPeriodDoc } from "../models/FinancialPeriod.js";
import {
  InactiveAccountError,
  InsufficientBalanceError,
  NotFoundError,
  PeriodClosedError,
  UnbalancedEntryError,
} from "../lib/errors.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import * as audit from "./audit.service.js";

/**
 * THE LEDGER ENGINE.
 *
 * Every rupee that moves in this system moves through `postTransaction`. Nothing else
 * writes to `ledgerentries`, and nothing writes a single entry on its own.
 *
 * The guarantees this file exists to provide:
 *
 *   1. Debits equal credits, checked before anything is written. An unbalanced posting
 *      throws and the transaction rolls back with zero entries on the books.
 *   2. Balances are computed from entries, never assigned. The cached balance on a
 *      ledger account is a denormalisation updated in the same database transaction, and
 *      `verifyBalance` can prove it against a full replay at any time.
 *   3. Nothing posts against a closed period, an inactive account, or an account without
 *      the funds — checked inside the transaction, so a concurrent posting cannot slip
 *      between the check and the write.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** One side of a posting. `amount` is always positive; `direction` carries the sign. */
export interface PostingLine {
  ledgerAccountId: Types.ObjectId | string;
  direction: Direction;
  amount: number;
  narration?: string;
}

export interface PostTransactionInput {
  type: TransactionType;
  date: Date;
  branchId: Types.ObjectId | string;
  lines: PostingLine[];

  grossAmount: number;
  chargeAmount?: number;

  paymentMode?: string;
  referenceNo?: string;
  narration?: string;
  partyId?: Types.ObjectId | string | null;

  /** Explicit voucher number. Omit to reserve the next one in the sequence. */
  txnNo?: string;
  /** Present on a reversal, pointing at the transaction being cancelled. */
  reversalOf?: Types.ObjectId | string | null;

  /**
   * Discriminator fields for this transaction type — account labels, expense items,
   * transfer endpoints.
   *
   * Passed in and written with the header in ONE `create`, rather than patched on
   * afterwards. Mongoose routes the write through the discriminator schema based on
   * `type`, so its required fields are genuinely validated. An earlier version created a
   * bare base document and updated it a moment later, which meant a BANK_TRANSFER could
   * exist with no source or destination for the width of that gap — and the schema's
   * `required` flags were never enforced at all.
   */
  details?: Record<string, unknown>;

  attachments?: unknown[];
  notes?: unknown[];

  createdBy: Types.ObjectId | string;
  /** Skip the balance check. Only opening balances and approved adjustments may. */
  allowOverdraft?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Balance mathematics                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How much an entry changes an account's balance, signed against its normal side.
 *
 * An ASSET grows on the debit side, so `DEBIT 500` on a bank account is `+500`. A
 * LIABILITY grows on the credit side, so `CREDIT 500` on a savings account is also `+500`
 * — the balance is "how much we hold for them", and it went up. Getting this table right
 * is what makes the balance sheet balance without per-type special cases.
 */
export function signedDelta(accountClass: AccountClass, direction: Direction, amount: number): number {
  return signFor(accountClass, direction) * amount;
}

/**
 * Assert that a set of lines balances.
 *
 * The single most important check in the codebase. It runs BEFORE any write, so a
 * posting rule with a bug produces an error and an empty ledger rather than a
 * half-recorded transfer where money left one account and never arrived at the other.
 */
export function assertBalanced(lines: PostingLine[]): { debit: number; credit: number } {
  if (lines.length < 2) {
    throw new UnbalancedEntryError(0, 0);
  }

  let debit = 0;
  let credit = 0;

  for (const line of lines) {
    if (!Number.isInteger(line.amount)) {
      throw new Error(
        `Posting amount ${line.amount} is not a whole number of paise — a float reached the ledger.`,
      );
    }
    if (line.amount <= 0) {
      throw new Error(
        "Posting amounts must be positive. Direction is carried by DEBIT/CREDIT, never by a negative amount.",
      );
    }
    if (line.direction === "DEBIT") debit += line.amount;
    else credit += line.amount;
  }

  if (debit !== credit) throw new UnbalancedEntryError(debit, credit);
  if (debit === 0) throw new UnbalancedEntryError(0, 0);

  return { debit, credit };
}

/**
 * The authoritative balance: a full aggregation over the entries.
 *
 * Slower than reading `cachedBalance`, and always correct. Used by the integrity check,
 * by reports that must not depend on a cache, and by `verifyBalance`.
 */
export async function computeBalance(
  ledgerAccountId: Types.ObjectId | string,
  options: { asOf?: Date; session?: ClientSession } = {},
): Promise<{ balance: number; debit: number; credit: number; count: number }> {
  const account = await LedgerAccount.findById(ledgerAccountId)
    .select("accountClass")
    .session(options.session ?? null)
    .lean();
  if (!account) throw new NotFoundError("Ledger account", String(ledgerAccountId));

  const match: Record<string, unknown> = { ledgerAccountId: new Types.ObjectId(String(ledgerAccountId)) };
  if (options.asOf) match.date = { $lte: options.asOf };

  const [result] = await LedgerEntry.aggregate<{ debit: number; credit: number; count: number }>([
    { $match: match },
    {
      $group: {
        _id: null,
        // Integer paise summed as integers — exact, with no floating-point drift even
        // across millions of entries.
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
        count: { $sum: 1 },
      },
    },
  ]).session(options.session ?? null);

  const debit = result?.debit ?? 0;
  const credit = result?.credit ?? 0;
  const normal = signFor(account.accountClass, "DEBIT");

  return {
    balance: normal === 1 ? debit - credit : credit - debit,
    debit,
    credit,
    count: result?.count ?? 0,
  };
}

/**
 * Compare the cached balance against a full replay.
 *
 * §62 in code: on a mismatch this REPORTS the difference. It does not write the computed
 * value over the cache, because a drifting cache means something else is wrong and
 * quietly papering over it destroys the only evidence.
 */
export async function verifyBalance(ledgerAccountId: Types.ObjectId | string): Promise<{
  matches: boolean;
  cached: number;
  computed: number;
  difference: number;
}> {
  const account = await LedgerAccount.findById(ledgerAccountId).select("cachedBalance").lean();
  if (!account) throw new NotFoundError("Ledger account", String(ledgerAccountId));

  const { balance } = await computeBalance(ledgerAccountId);
  const difference = account.cachedBalance - balance;

  if (difference !== 0) {
    logger.error(
      { ledgerAccountId: String(ledgerAccountId), cached: account.cachedBalance, computed: balance, difference },
      "LEDGER INTEGRITY: cached balance disagrees with the entries",
    );
  }

  return { matches: difference === 0, cached: account.cachedBalance, computed: balance, difference };
}

/* -------------------------------------------------------------------------- */
/* Account provisioning                                                       */
/* -------------------------------------------------------------------------- */

export interface CreateLedgerAccountInput {
  code: string;
  name: string;
  kind: AccountKind;
  branchId?: Types.ObjectId | string | null;
  refKind?: string;
  refId?: Types.ObjectId | string;
  overdraftLimit?: number;
  enforceBalance?: boolean;
  isSystem?: boolean;
  createdBy?: Types.ObjectId | string;
}

/**
 * Create the ledger account for a master record.
 *
 * Always called inside the same transaction that creates the master, so a bank account
 * without a ledger account — or the reverse — is not a state the database can reach.
 */
export async function createLedgerAccount(
  input: CreateLedgerAccountInput,
  session: ClientSession,
): Promise<LedgerAccountDoc> {
  const [account] = await LedgerAccount.create(
    [
      {
        code: input.code,
        name: input.name,
        kind: input.kind,
        accountClass: ACCOUNT_KIND_CLASS[input.kind],
        branchId: input.branchId ?? null,
        refKind: input.refKind,
        refId: input.refId,
        overdraftLimit: input.overdraftLimit ?? 0,
        enforceBalance: input.enforceBalance ?? false,
        isSystem: input.isSystem ?? false,
        cachedBalance: 0,
        cachedEntryCount: 0,
        createdBy: input.createdBy,
      },
    ],
    { session },
  );

  if (!account) throw new Error(`Failed to create the ledger account ${input.code}`);
  return account;
}

/**
 * Create the organisation-wide system accounts if they do not exist.
 *
 * Idempotent, and safe to call on every boot and from the seed. `EQUITY-OPENING` in
 * particular must exist before any master record with an opening balance can be created.
 */
export async function ensureSystemAccounts(session?: ClientSession): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const [key, spec] of Object.entries(SYSTEM_ACCOUNTS)) {
    const account = await LedgerAccount.findOneAndUpdate(
      { code: spec.code },
      {
        $setOnInsert: {
          code: spec.code,
          name: spec.name,
          kind: spec.kind,
          accountClass: spec.accountClass,
          branchId: null,
          isSystem: true,
          enforceBalance: false,
          cachedBalance: 0,
          cachedEntryCount: 0,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, session },
    );
    result.set(key, String(account._id));
  }

  return result;
}

export async function systemAccountId(
  key: keyof typeof SYSTEM_ACCOUNTS,
  session?: ClientSession,
): Promise<Types.ObjectId> {
  const account = await LedgerAccount.findOne({ code: SYSTEM_ACCOUNTS[key].code })
    .select("_id")
    .session(session ?? null)
    .lean();

  if (!account) {
    throw new Error(
      `The system account ${SYSTEM_ACCOUNTS[key].code} is missing. Run \`npm run seed\` — ` +
        `the ledger cannot balance an opening entry without it.`,
    );
  }
  return account._id;
}

/* -------------------------------------------------------------------------- */
/* Numbering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reserve the next voucher number.
 *
 * MUST share the caller's session: if the transaction rolls back, the reservation rolls
 * back with it and the number is reused, which is what keeps the sequence gap-free. In an
 * audited book a missing voucher number is a question somebody has to answer.
 */
export async function reserveTxnNo(
  type: TransactionType,
  date: Date,
  session: ClientSession,
  prefixOverride?: string,
): Promise<{ txnNo: string; fiscalYear: number }> {
  const fiscalYear = fiscalYearOf(date, env.FISCAL_YEAR_START_MONTH);
  const prefix = prefixOverride ?? TXN_PREFIX[type];
  const seq = await nextSequence(prefix, fiscalYear, session);
  return { txnNo: formatDocumentNumber(prefix, fiscalYear, seq), fiscalYear };
}

/* -------------------------------------------------------------------------- */
/* Posting                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Post a balanced transaction to the ledger.
 *
 * The order of operations is deliberate and each step depends on the last:
 *
 *   1. assert the lines balance          — fail before touching anything
 *   2. load and validate every account   — active, in scope, funded
 *   3. reserve the voucher number        — inside the session, so it can roll back
 *   4. write the transaction header
 *   5. write the entries with running balances
 *   6. update the cached balances
 *   7. write the audit row in the SAME session
 *
 * All of it inside one Mongo transaction. Any throw and none of it happened.
 *
 * This function must be idempotent with respect to its inputs, because `withTransaction`
 * retries on a write conflict and will call the enclosing callback again.
 */
export async function postTransaction(
  input: PostTransactionInput,
  session: ClientSession,
  auditContext?: audit.AuditContext,
): Promise<TransactionDoc> {
  // ── 0. Period ───────────────────────────────────────────────────────────
  const period = await assertPeriodOpen(input.date, session);

  // ── 1. Balance ──────────────────────────────────────────────────────────
  const { debit } = assertBalanced(input.lines);

  const chargeAmount = input.chargeAmount ?? 0;
  const netAmount = input.grossAmount - chargeAmount;

  // ── 2. Accounts ─────────────────────────────────────────────────────────
  const accountIds = [...new Set(input.lines.map((l) => String(l.ledgerAccountId)))];
  const accounts = await LedgerAccount.find({ _id: { $in: accountIds } }).session(session);

  if (accounts.length !== accountIds.length) {
    const found = new Set(accounts.map((a) => String(a._id)));
    const missing = accountIds.filter((id) => !found.has(id));
    throw new NotFoundError("Ledger account", missing.join(", "));
  }

  const byId = new Map(accounts.map((a) => [String(a._id), a]));

  for (const account of accounts) {
    if (account.status !== "ACTIVE") throw new InactiveAccountError(account.name);
  }

  /**
   * Net movement per account first, THEN check the balance.
   *
   * A transaction can debit and credit the same account (a charge deducted from the very
   * account being paid from, for instance). Checking each line in isolation would
   * wrongly reject a posting whose net effect is affordable.
   */
  const deltaByAccount = new Map<string, number>();
  for (const line of input.lines) {
    const id = String(line.ledgerAccountId);
    const account = byId.get(id)!;
    const delta = signedDelta(account.accountClass, line.direction, line.amount);
    deltaByAccount.set(id, (deltaByAccount.get(id) ?? 0) + delta);
  }

  if (!input.allowOverdraft) {
    for (const [id, delta] of deltaByAccount) {
      const account = byId.get(id)!;
      if (!account.enforceBalance || delta >= 0) continue;

      const resulting = account.cachedBalance + delta;
      const floor = -account.overdraftLimit;

      if (resulting < floor) {
        throw new InsufficientBalanceError(
          account.name,
          account.cachedBalance + account.overdraftLimit,
          Math.abs(delta),
        );
      }
    }
  }

  // ── 3. Number ───────────────────────────────────────────────────────────
  const numbering = input.txnNo
    ? { txnNo: input.txnNo, fiscalYear: fiscalYearOf(input.date, env.FISCAL_YEAR_START_MONTH) }
    : await reserveTxnNo(input.type, input.date, session);

  // ── 4. Header ───────────────────────────────────────────────────────────
  const [transaction] = await Transaction.create(
    [
      {
        txnNo: numbering.txnNo,
        type: input.type,
        date: input.date,
        branchId: input.branchId,
        // Posting is what COMPLETED means. There is no state in which entries exist and
        // the header claims to be a draft.
        status: "COMPLETED",
        grossAmount: input.grossAmount,
        chargeAmount,
        netAmount,
        paymentMode: input.paymentMode,
        referenceNo: input.referenceNo,
        narration: input.narration,
        partyId: input.partyId ?? null,
        accountIds,
        reversalOf: input.reversalOf ?? null,
        postedAt: new Date(),
        fiscalYear: numbering.fiscalYear,
        periodId: period?._id ?? null,
        createdBy: input.createdBy,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        // Type-specific fields, validated by the discriminator schema in this same write.
        ...(input.details ?? {}),
      },
    ],
    { session },
  );

  if (!transaction) throw new Error("Failed to create the transaction header");

  // ── 5. Entries ──────────────────────────────────────────────────────────
  // Contra names let a statement row answer "paid to whom" without another query.
  const contraNames = accounts.map((a) => a.name);

  const runningByAccount = new Map<string, number>();
  const entryDocs = input.lines.map((line) => {
    const id = String(line.ledgerAccountId);
    const account = byId.get(id)!;
    const delta = signedDelta(account.accountClass, line.direction, line.amount);

    const previous = runningByAccount.get(id) ?? account.cachedBalance;
    const running = previous + delta;
    runningByAccount.set(id, running);

    return {
      transactionId: transaction._id,
      txnNo: transaction.txnNo,
      transactionType: input.type,
      ledgerAccountId: new Types.ObjectId(id),
      branchId: new Types.ObjectId(String(input.branchId)),
      date: input.date,
      direction: line.direction,
      amount: line.amount,
      runningBalance: running,
      narration: line.narration ?? input.narration,
      contra: contraNames.filter((n) => n !== account.name),
      createdBy: new Types.ObjectId(String(input.createdBy)),
    };
  });

  await LedgerEntry.insertMany(entryDocs, { session, ordered: true });

  // ── 6. Cached balances ──────────────────────────────────────────────────
  // `$inc`, never `$set`: an increment composes correctly with a concurrent posting,
  // whereas assigning a value computed from a stale read would silently lose the other
  // transaction's effect.
  const now = new Date();
  // Sequential for the same reason as everywhere else in a session: concurrent operations
  // on one ClientSession abort the transaction with NoSuchTransaction. The loop is at most
  // a handful of accounts, so there is nothing to gain from parallelism here anyway.
  for (const [id, delta] of deltaByAccount) {
    const lineCount = input.lines.filter((l) => String(l.ledgerAccountId) === id).length;
    await LedgerAccount.updateOne(
      { _id: id },
      { $inc: { cachedBalance: delta, cachedEntryCount: lineCount }, $set: { cachedAt: now } },
      { session },
    );
  }

  // ── 7. Audit ────────────────────────────────────────────────────────────
  if (auditContext) {
    await audit.record(
      auditContext,
      {
        action: "POST",
        entity: "Transaction",
        entityId: String(transaction._id),
        entityLabel: transaction.txnNo,
        amount: input.grossAmount,
        newValue: {
          txnNo: transaction.txnNo,
          type: input.type,
          gross: input.grossAmount,
          charge: chargeAmount,
          net: netAmount,
          lines: input.lines.map((l) => ({
            account: byId.get(String(l.ledgerAccountId))!.name,
            direction: l.direction,
            amount: l.amount,
          })),
        },
      },
      session,
    );
  }

  logger.debug(
    { txnNo: transaction.txnNo, type: input.type, amount: debit, lines: input.lines.length },
    "ledger posting committed",
  );

  return transaction;
}

/* -------------------------------------------------------------------------- */
/* Financial periods (§35)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to post into a closed period.
 *
 * Called from `postTransaction`, so it covers EVERY money movement in the system —
 * payments, transfers, expenses, adjustments, reversals and opening balances alike.
 * Putting the check in the engine rather than in each service is what makes it
 * impossible for a new transaction type to forget it.
 *
 * A date that falls in no defined period is allowed. Periods are opt-in: a business that
 * has not set any up should not find its books frozen by a control it never configured.
 * Once a period exists and is closed, it is closed.
 */
export async function assertPeriodOpen(
  date: Date,
  session?: ClientSession,
): Promise<FinancialPeriodDoc | null> {
  const period = await FinancialPeriod.findOne({
    startDate: { $lte: date },
    endDate: { $gte: date },
  })
    .session(session ?? null)
    .lean();

  if (!period) return null;

  if (period.status !== "OPEN") {
    throw new PeriodClosedError(
      `${period.name}${period.status === "LOCKED" ? " (locked)" : ""}`,
      date,
    );
  }

  return period as unknown as FinancialPeriodDoc;
}

/* -------------------------------------------------------------------------- */
/* Opening balances                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Post an opening balance against equity.
 *
 * This is why `EQUITY-OPENING` exists. A bank account opening at ₹5,00,000 has to get
 * that money from somewhere or the books do not balance; in double-entry it comes from
 * owner's equity:
 *
 *     DR  Bank: HDFC ••1234      5,00,000
 *         CR  Opening Equity              5,00,000
 *
 * `amount` is expressed in the ACCOUNT'S OWN TERMS: a positive figure means the account
 * opens with that much balance, whichever side it normally sits on. For an asset that is
 * a debit; for a LIABILITY — a member's savings account, where the money is theirs and we
 * merely hold it — the very same "opening balance of ₹10,000" is a CREDIT.
 *
 * Debiting unconditionally, as an earlier version did, opened every savings account at
 * minus its deposit. The books still balanced, which is exactly why it was easy to miss.
 *
 * A negative opening (an overdrawn account, or a party we owe) flips the pair. Zero posts
 * nothing — an empty transaction would consume a voucher number for no movement.
 */
export async function postOpeningBalance(
  input: {
    ledgerAccountId: Types.ObjectId | string;
    branchId: Types.ObjectId | string;
    amount: number;
    date: Date;
    label: string;
    createdBy: Types.ObjectId | string;
  },
  session: ClientSession,
  auditContext?: audit.AuditContext,
): Promise<TransactionDoc | null> {
  if (input.amount === 0) return null;

  const equityId = await systemAccountId("OPENING_EQUITY", session);
  const magnitude = Math.abs(input.amount);

  const account = await LedgerAccount.findById(input.ledgerAccountId)
    .select("accountClass")
    .session(session)
    .lean();
  if (!account) throw new NotFoundError("Ledger account", String(input.ledgerAccountId));

  // The side that INCREASES this account. Asset and expense grow on debit; liability,
  // equity and income grow on credit.
  const increasing = NORMAL_SIDE[account.accountClass];
  const opposite = increasing === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const);
  const side = input.amount > 0 ? increasing : opposite;
  const equitySide = side === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const);

  const lines: PostingLine[] = [
    { ledgerAccountId: input.ledgerAccountId, direction: side, amount: magnitude },
    { ledgerAccountId: equityId, direction: equitySide, amount: magnitude },
  ];

  return postTransaction(
    {
      type: "OPENING_BALANCE",
      date: input.date,
      branchId: input.branchId,
      lines,
      grossAmount: magnitude,
      narration: `Opening balance — ${input.label}`,
      createdBy: input.createdBy,
      // An opening balance establishes the starting position, so it is exempt from a
      // funds check that would otherwise be evaluated against a balance of zero.
      allowOverdraft: true,
    },
    session,
    auditContext,
  );
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Balances for many accounts in one query, for a list view. Avoids an N+1. */
export async function balancesFor(
  ledgerAccountIds: Array<Types.ObjectId | string>,
): Promise<Map<string, number>> {
  if (ledgerAccountIds.length === 0) return new Map();

  const accounts = await LedgerAccount.find({ _id: { $in: ledgerAccountIds } })
    .select("cachedBalance")
    .lean();

  return new Map(accounts.map((a) => [String(a._id), a.cachedBalance]));
}

/**
 * A trial balance (§34).
 *
 * Reads entries directly rather than cached balances — a trial balance whose purpose is
 * to prove the books tie must not be computed from the cache it is meant to validate.
 */
export async function trialBalance(
  options: {
    asOf?: Date;
    branchId?: Types.ObjectId | string;
    /** Several branches at once — the picker's "All branches" for a scoped caller. */
    branchIds?: Array<Types.ObjectId | string>;
  } = {},
) {
  const match: Record<string, unknown> = {};
  if (options.asOf) match.date = { $lte: options.asOf };
  if (options.branchId) match.branchId = new Types.ObjectId(String(options.branchId));
  else if (options.branchIds?.length) {
    match.branchId = { $in: options.branchIds.map((id) => new Types.ObjectId(String(id))) };
  }

  const rows = await LedgerEntry.aggregate<{
    _id: Types.ObjectId;
    debit: number;
    credit: number;
    account: { code: string; name: string; kind: AccountKind; accountClass: AccountClass };
  }>([
    { $match: match },
    {
      $group: {
        _id: "$ledgerAccountId",
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
      },
    },
    {
      $lookup: {
        from: "ledgeraccounts",
        localField: "_id",
        foreignField: "_id",
        as: "account",
        pipeline: [{ $project: { code: 1, name: 1, kind: 1, accountClass: 1 } }],
      },
    },
    { $unwind: "$account" },
    { $sort: { "account.code": 1 } },
  ]);

  let totalDebit = 0;
  let totalCredit = 0;

  const mapped = rows.map((row) => {
    // Each account contributes on ONE side — its net position — not on both. A trial
    // balance listing gross turnover per account would tie arithmetically but tell you
    // nothing about where the money actually stands.
    const net = row.debit - row.credit;
    const debit = net > 0 ? net : 0;
    const credit = net < 0 ? -net : 0;
    totalDebit += debit;
    totalCredit += credit;

    return {
      ledgerAccountId: String(row._id),
      code: row.account.code,
      name: row.account.name,
      kind: row.account.kind,
      accountClass: row.account.accountClass,
      debit,
      credit,
    };
  });

  return {
    rows: mapped,
    totalDebit,
    totalCredit,
    // Always zero in a sound ledger. Surfaced rather than hidden, so a bug is visible.
    difference: totalDebit - totalCredit,
    asOf: (options.asOf ?? new Date()).toISOString(),
    branchId: options.branchId ? String(options.branchId) : null,
  };
}
