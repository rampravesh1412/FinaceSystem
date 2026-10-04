import { Types, type ClientSession, type FilterQuery } from "mongoose";
import {
  formatINR,
  maskAccountNumber,
  type BankAccountSummary,
  type CashAccountSummary,
  type ChangeOpeningBalanceInput,
  type CreateBankAccountInput,
  type CreateBankInput,
  type CreateCashAccountInput,
  type OpeningBalanceState,
  type UpdateBankAccountInput,
  type UpdateCashAccountInput,
  type UpdateBankInput,
} from "@amiri/shared";
import {
  Bank,
  BankAccount,
  CashAccount,
  LedgerAccount,
  LedgerEntry,
  Transaction,
  nextSequence,
  type BankAccountDoc,
  type BankDoc,
  type CashAccountDoc,
  type TransactionDoc,
} from "../../models/index.js";
import { BadRequestError, ConflictError, NotFoundError, translateDuplicate } from "../../lib/errors.js";
import { escapeRegex, type Paging } from "../../lib/http.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as audit from "../../services/audit.service.js";
import * as reversals from "../transactions/reversal.service.js";

/**
 * Banks, bank accounts and cash accounts.
 *
 * All three are ORGANISATION-WIDE masters — see the model files for why. Nothing in this
 * file filters by branch, and none of these records carries one. The branch is recorded on
 * every posting instead, which is where per-branch reporting reads it from.
 *
 * Every creation here does the same three things inside ONE database transaction:
 *
 *   1. write the master record
 *   2. create its ledger account
 *   3. post the opening balance against equity
 *
 * All three or none. There is no reachable state where an account exists but cannot be
 * posted against, or where an opening balance was declared but never made it onto the
 * books.
 */

/* -------------------------------------------------------------------------- */
/* Bank                                                                       */
/* -------------------------------------------------------------------------- */

export async function listBanks(
  filters: { q?: string; status?: string },
  page: Paging,
) {
  const filter: FilterQuery<BankDoc> = {};
  if (filters.status) filter.status = filters.status;
  if (filters.q?.trim()) {
    const rx = new RegExp(escapeRegex(filters.q.trim()), "i");
    filter.$or = [{ name: rx }, { shortName: rx }, { ifscPrefix: rx }];
  }

  const [banks, total] = await Promise.all([
    Bank.find(filter).sort(page.sort).skip(page.skip).limit(page.limit).lean(),
    Bank.countDocuments(filter),
  ]);

  /**
   * Per-bank account counts and totals.
   *
   * Accounts are organisation-wide, so "HDFC — 2 accounts, ₹4,20,000" is the business's
   * whole position with that institution. That is the figure the bank itself would quote,
   * and the only one that can be checked against a statement.
   */
  const bankIds = banks.map((b) => b._id);
  const accountMatch: Record<string, unknown> = { bankId: { $in: bankIds }, status: "ACTIVE" };

  const stats = await BankAccount.aggregate<{ _id: Types.ObjectId; count: number; balance: number }>([
    { $match: accountMatch },
    {
      $lookup: {
        from: "ledgeraccounts",
        localField: "ledgerAccountId",
        foreignField: "_id",
        as: "ledger",
        pipeline: [{ $project: { cachedBalance: 1 } }],
      },
    },
    { $unwind: "$ledger" },
    { $group: { _id: "$bankId", count: { $sum: 1 }, balance: { $sum: "$ledger.cachedBalance" } } },
  ]);

  const byBank = new Map(stats.map((s) => [String(s._id), s]));

  return {
    items: banks.map((b) => ({
      id: String(b._id),
      name: b.name,
      shortName: b.shortName,
      ifscPrefix: b.ifscPrefix,
      contactPerson: b.contactPerson,
      phone: b.phone,
      email: b.email,
      status: b.status,
      accountCount: byBank.get(String(b._id))?.count ?? 0,
      totalBalance: byBank.get(String(b._id))?.balance ?? 0,
      createdAt: b.createdAt.toISOString(),
    })),
    total,
  };
}

export async function createBank(input: CreateBankInput, ctx: audit.AuditContext): Promise<BankDoc> {
  try {
    const bank = await Bank.create({ ...input, createdBy: ctx.userId });
    await audit.record(ctx, {
      action: "CREATE",
      entity: "Bank",
      entityId: String(bank._id),
      entityLabel: bank.name,
      newValue: { name: bank.name, ifscPrefix: bank.ifscPrefix },
    });
    return bank;
  } catch (err) {
    const duplicate = translateDuplicate(err, "bank");
    if (duplicate) throw duplicate;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Bank account                                                               */
/* -------------------------------------------------------------------------- */

/** Next sequence for a ledger account code, e.g. `BANK-0007`. */
async function ledgerCode(prefix: string, session: ClientSession): Promise<string> {
  const seq = await nextSequence(`LEDGER-${prefix}`, 0, session);
  return `${prefix}-${String(seq).padStart(5, "0")}`;
}

export async function createBankAccount(
  input: CreateBankAccountInput,
  ctx: audit.AuditContext,
): Promise<BankAccountDoc> {
  const bank = await Bank.findById(input.bankId).select("name shortName ifscPrefix status").lean();

  if (!bank) throw new NotFoundError("Bank", input.bankId);
  if (bank.status !== "ACTIVE") throw new BadRequestError("That bank is not active", "bankId");

  /**
   * The IFSC must belong to the bank it is being filed under.
   *
   * An HDFC account filed under ICICI would reconcile against the wrong statement every
   * month, and nobody would notice until the difference was large.
   */
  if (bank.ifscPrefix && !input.ifsc.startsWith(bank.ifscPrefix)) {
    throw new BadRequestError(
      `That IFSC does not belong to ${bank.name} — it should begin with ${bank.ifscPrefix}.`,
      "ifsc",
    );
  }

  // A deleted account keeps its number, so the unique index would refuse this anyway —
  // with a message about a duplicate nobody can see. Say which account holds it.
  if (await BankAccount.exists({ bankId: input.bankId, accountNumber: input.accountNumber, deletedAt: { $ne: null } })) {
    throw new ConflictError(
      "That account number belongs to a deleted account at this bank. A deleted account keeps its number so its history stays traceable.",
      "accountNumber",
    );
  }

  return withTransaction(async (session) => {
    try {
      const code = await ledgerCode("BANK", session);
      const label = `${bank.shortName ?? bank.name} ••${input.accountNumber.slice(-4)}`;

      const ledgerAccount = await ledger.createLedgerAccount(
        {
          code,
          name: `${label} — ${input.accountName}`,
          kind: "BANK",
          // Organisation-wide. The branch lives on the entries, not on the account.
          refKind: "BankAccount",
          overdraftLimit: input.overdraftLimit,
          // A bank account cannot be taken below its sanctioned overdraft. For a plain
          // current account the limit is zero, so it simply cannot go negative.
          enforceBalance: true,
          createdBy: ctx.userId,
        },
        session,
      );

      const [account] = await BankAccount.create(
        [
          {
            bankId: input.bankId,
            ledgerAccountId: ledgerAccount._id,
            accountName: input.accountName,
            accountNumber: input.accountNumber,
            ifsc: input.ifsc,
            bankBranchName: input.bankBranchName,
            accountType: input.accountType,
            overdraftLimit: input.overdraftLimit,
            lowBalanceThreshold: input.lowBalanceThreshold,
            status: input.status,
            notes: input.notes,
            createdBy: ctx.userId,
          },
        ],
        { session },
      );

      if (!account) throw new Error("Bank account creation returned no document");

      // Backfill the reverse link now that the master has an id.
      await LedgerAccount.updateOne({ _id: ledgerAccount._id }, { $set: { refId: account._id } }, { session });

      await audit.record(
        ctx,
        {
          action: "CREATE",
          entity: "BankAccount",
          entityId: String(account._id),
          entityLabel: label,
          amount: input.openingBalance,
          // The full account number belongs in the audit trail — proving what was
          // entered is precisely what the trail is for. It is masked on the API surface,
          // not here.
          newValue: {
            bank: bank.name,
            accountName: input.accountName,
            accountNumber: input.accountNumber,
            ifsc: input.ifsc,
            openingBalance: input.openingBalance,
          },
        },
        session,
      );

      // The opening balance becomes a real double-entry posting against equity. It has no
      // branch: what the account held on day one is the organisation's position, not any
      // one office's trade.
      await ledger.postOpeningBalance(
        {
          ledgerAccountId: ledgerAccount._id,
          amount: input.openingBalance,
          date: input.openingDate ?? new Date(),
          label,
          createdBy: ctx.userId!,
        },
        session,
        ctx,
      );

      return account;
    } catch (err) {
      const duplicate = translateDuplicate(err, "bank account");
      if (duplicate) {
        throw new ConflictError(
          "That account number is already recorded for this bank. Filing it twice would split one balance across two ledgers.",
          "accountNumber",
        );
      }
      throw err;
    }
  }, { label: "bankAccount.create" });
}

export interface BankAccountListFilters {
  q?: string;
  bankId?: string;
  accountType?: string;
  status?: string;
}

/**
 * The bank account list.
 *
 * Unfiltered by branch, because accounts are organisation-wide: a caller holding
 * `finance.bank.view` sees every account and its full balance. The footer total is
 * therefore the business's real bank position rather than a partial sum.
 */
export async function listBankAccounts(
  filters: BankAccountListFilters,
  page: Paging,
  canSeeFullNumbers: boolean,
): Promise<{ items: BankAccountSummary[]; total: number; totalBalance: number }> {
  // Soft-deleted accounts are gone from the UI. This list feeds every account picker too,
  // so filtering here is what keeps them out of the entry forms as well.
  const filter: FilterQuery<BankAccountDoc> = { deletedAt: null };

  if (filters.bankId) filter.bankId = new Types.ObjectId(filters.bankId);
  if (filters.accountType) filter.accountType = filters.accountType;
  if (filters.status) filter.status = filters.status;
  if (filters.q?.trim()) {
    const rx = new RegExp(escapeRegex(filters.q.trim()), "i");
    filter.$or = [{ accountName: rx }, { accountNumber: rx }, { ifsc: rx }, { bankBranchName: rx }];
  }

  const [docs, total] = await Promise.all([
    BankAccount.find(filter)
      .sort(page.sort)
      .skip(page.skip)
      .limit(page.limit)
      .populate<{ bankId: { _id: Types.ObjectId; name: string; shortName?: string } }>("bankId", "name shortName")
      .populate<{ ledgerAccountId: { _id: Types.ObjectId; cachedBalance: number } }>(
        "ledgerAccountId",
        "cachedBalance",
      )
      .lean(),
    BankAccount.countDocuments(filter),
  ]);

  // Total across the whole filtered set, not just this page — a footer total that only
  // covered the visible 25 rows would be actively misleading.
  const [totals] = await BankAccount.aggregate<{ total: number }>([
    { $match: filter },
    {
      $lookup: {
        from: "ledgeraccounts",
        localField: "ledgerAccountId",
        foreignField: "_id",
        as: "ledger",
        pipeline: [{ $project: { cachedBalance: 1 } }],
      },
    },
    { $unwind: "$ledger" },
    { $group: { _id: null, total: { $sum: "$ledger.cachedBalance" } } },
  ]);

  const items = docs.map((d) => toBankAccountSummary(d, canSeeFullNumbers));

  return { items, total, totalBalance: totals?.total ?? 0 };
}

function toBankAccountSummary(
  d: {
    _id: unknown;
    bankId: { _id: unknown; name: string; shortName?: string } | null;
    accountName: string;
    accountNumber: string;
    ifsc: string;
    bankBranchName?: string;
    accountType: string;
    overdraftLimit: number;
    lowBalanceThreshold: number;
    status: string;
    ledgerAccountId: { _id: unknown; cachedBalance: number } | null;
    createdAt?: Date;
  },
  canSeeFullNumbers: boolean,
): BankAccountSummary {
  {
    // A populate that finds nothing yields null, not the id. One account whose bank or
    // ledger row has gone must not take the whole list down with it — it renders as an
    // unknown bank with a zero balance, which is visibly wrong and fixable.
    const balance = d.ledgerAccountId?.cachedBalance ?? 0;
    const overdraftLimit = d.overdraftLimit ?? 0;
    const lowBalanceThreshold = d.lowBalanceThreshold ?? 0;
    return {
      id: String(d._id),
      bank: {
        id: d.bankId ? String(d.bankId._id) : "",
        name: d.bankId?.name ?? "Unknown bank",
        shortName: d.bankId?.shortName,
      },
      accountName: d.accountName,
      // Masked on the SERVER. An unauthorised caller never receives the digits at all —
      // masking in the browser would mean shipping them and hiding them with CSS.
      accountNumber: canSeeFullNumbers ? d.accountNumber : maskAccountNumber(d.accountNumber),
      accountNumberMasked: !canSeeFullNumbers,
      ifsc: d.ifsc,
      bankBranchName: d.bankBranchName,
      accountType: d.accountType,
      balance,
      availableBalance: balance + overdraftLimit,
      overdraftLimit,
      lowBalanceThreshold,
      isLowBalance: lowBalanceThreshold > 0 && balance < lowBalanceThreshold,
      status: d.status,
      ledgerAccountId: d.ledgerAccountId ? String(d.ledgerAccountId._id) : "",
      // Rows written past the model can lack timestamps; the ObjectId still carries one.
      createdAt: (d.createdAt ?? (d._id as Types.ObjectId).getTimestamp()).toISOString(),
    } satisfies BankAccountSummary;
  }
}

/**
 * One bank account in the SAME shape the list returns.
 *
 * Used by the create route. A POST that answered with the raw document would omit
 * `balance` — the posted opening balance, which is the single figure a caller wants back
 * after opening an account — and would ship the UNMASKED account number regardless of
 * whether the caller holds `finance.bank.viewFull`.
 */
export async function getBankAccountSummary(
  id: string,
  canSeeFullNumbers: boolean,
): Promise<BankAccountSummary> {
  const doc = await BankAccount.findById(id)
    .populate<{ bankId: { _id: Types.ObjectId; name: string; shortName?: string } }>("bankId", "name shortName")
    .populate<{ ledgerAccountId: { _id: Types.ObjectId; cachedBalance: number } }>("ledgerAccountId", "cachedBalance")
    .lean();

  if (!doc) throw new NotFoundError("Bank account", id);
  return toBankAccountSummary(doc as never, canSeeFullNumbers);
}

/**
 * Rename or retire a bank.
 *
 * A bank holds no balance of its own — the accounts under it do — so this touches no
 * ledger. Retiring one does NOT cascade to its accounts: an account with posted history
 * must stay usable for reconciliation and reversal even if the institution is no longer
 * being used for new business.
 */
export async function updateBank(
  id: string,
  input: UpdateBankInput,
  ctx: audit.AuditContext,
): Promise<BankDoc> {
  const bank = await Bank.findById(id);
  if (!bank) throw new NotFoundError("Bank", id);

  const before = { name: bank.name, shortName: bank.shortName, status: bank.status };

  Object.assign(bank, input, { updatedBy: ctx.userId });

  try {
    await bank.save();
  } catch (err) {
    throw translateDuplicate(err, "Bank");
  }

  /**
   * The ledger accounts carry the bank's name in their own label, so a rename has to reach
   * them or the trial balance keeps showing the old institution forever.
   *
   * The label is rebuilt with EXACTLY the format `createBankAccount` uses —
   * `SHORTNAME ••1234 — Account Name`. Composing it differently here would quietly change
   * the naming convention on rename, so two accounts opened the same way would print
   * differently depending on whether their bank had ever been renamed.
   */
  if ((input.name && input.name !== before.name) || (input.shortName && input.shortName !== before.shortName)) {
    const accounts = await BankAccount.find({ bankId: bank._id })
      .select("ledgerAccountId accountName accountNumber")
      .lean();

    for (const account of accounts) {
      const label = `${bank.shortName ?? bank.name} ••${account.accountNumber.slice(-4)}`;
      await LedgerAccount.updateOne(
        { _id: account.ledgerAccountId },
        { $set: { name: `${label} — ${account.accountName}` } },
      );
    }
  }

  await audit.record(ctx, {
    action: "UPDATE",
    entity: "Bank",
    entityId: id,
    entityLabel: bank.name,
    oldValue: before,
    newValue: { name: bank.name, shortName: bank.shortName, status: bank.status },
  });

  return bank;
}

/** Rename or retire a cash drawer. The balance and its entries are untouched. */
export async function updateCashAccount(
  id: string,
  input: UpdateCashAccountInput,
  ctx: audit.AuditContext,
): Promise<CashAccountDoc> {
  const account = await CashAccount.findById(id);
  // A deleted drawer cannot be edited back into use through its status.
  if (!account || account.deletedAt) throw new NotFoundError("Cash account", id);

  const before = { name: account.name, code: account.code, status: account.status };

  Object.assign(account, input, { updatedBy: ctx.userId });
  await account.save();

  if (input.name && input.name !== before.name) {
    await LedgerAccount.updateOne(
      { _id: account.ledgerAccountId },
      { $set: { name: `Cash — ${account.name}` } },
    );
  }

  await audit.record(
    ctx,
    {
      action: "UPDATE",
      entity: "CashAccount",
      entityId: id,
      entityLabel: account.name,
      oldValue: before,
      newValue: { name: account.name, code: account.code, status: account.status },
    },
  );

  return account;
}

export async function updateBankAccount(
  id: string,
  input: UpdateBankAccountInput,
  ctx: audit.AuditContext,
): Promise<BankAccountDoc> {
  return withTransaction(async (session) => {
    const account = await BankAccount.findById(id).session(session);
    // A deleted account cannot be edited back into use through its status.
    if (!account || account.deletedAt) throw new NotFoundError("Bank account", id);

    const before = {
      accountName: account.accountName,
      overdraftLimit: account.overdraftLimit,
      lowBalanceThreshold: account.lowBalanceThreshold,
      status: account.status,
    };

    Object.assign(account, input, { updatedBy: ctx.userId });
    await account.save({ session });

    // The ledger account mirrors the overdraft limit, because that is where the balance
    // check reads it from at posting time.
    if (input.overdraftLimit !== undefined) {
      await LedgerAccount.updateOne(
        { _id: account.ledgerAccountId },
        { $set: { overdraftLimit: input.overdraftLimit } },
        { session },
      );
    }

    await audit.record(
      ctx,
      {
        action: "UPDATE",
        entity: "BankAccount",
        entityId: id,
        entityLabel: account.accountName,
        oldValue: before,
        newValue: {
          accountName: account.accountName,
          overdraftLimit: account.overdraftLimit,
          lowBalanceThreshold: account.lowBalanceThreshold,
          status: account.status,
        },
      },
      session,
    );

    return account;
  }, { label: "bankAccount.update" });
}

/* -------------------------------------------------------------------------- */
/* Cash account                                                               */
/* -------------------------------------------------------------------------- */

export async function createCashAccount(
  input: CreateCashAccountInput,
  ctx: audit.AuditContext,
): Promise<CashAccountDoc> {
  // Names are unique and a deleted drawer keeps its own; say so instead of reporting a
  // duplicate nobody can see.
  if (await CashAccount.exists({ name: input.name, deletedAt: { $ne: null } })) {
    throw new ConflictError(`A deleted drawer is still called “${input.name}”. Pick another name.`, "name");
  }

  return withTransaction(async (session) => {
    try {
      const code = await ledgerCode("CASH", session);
      // The first drawer opened becomes the default one. Deleted drawers do not count —
      // deleting the default hands the flag on, or leaves none to hand.
      const existing = await CashAccount.countDocuments({ deletedAt: null }).session(session);

      const ledgerAccount = await ledger.createLedgerAccount(
        {
          code,
          name: `Cash — ${input.name}`,
          kind: "CASH",
          // Organisation-wide. The branch lives on the entries, not on the account.
          refKind: "CashAccount",
          overdraftLimit: 0,
          // Hard zero floor. You cannot hand over notes that are not in the drawer, so
          // unlike a bank account there is no overdraft to grant.
          enforceBalance: true,
          createdBy: ctx.userId,
        },
        session,
      );

      const [account] = await CashAccount.create(
        [
          {
            ledgerAccountId: ledgerAccount._id,
            name: input.name,
            code: input.code,
            isDefault: existing === 0,
            status: input.status,
            notes: input.notes,
            createdBy: ctx.userId,
          },
        ],
        { session },
      );

      if (!account) throw new Error("Cash account creation returned no document");

      await LedgerAccount.updateOne({ _id: ledgerAccount._id }, { $set: { refId: account._id } }, { session });

      await audit.record(
        ctx,
        {
          action: "CREATE",
          entity: "CashAccount",
          entityId: String(account._id),
          entityLabel: input.name,
          amount: input.openingBalance,
          newValue: { name: input.name, openingBalance: input.openingBalance },
        },
        session,
      );

      await ledger.postOpeningBalance(
        {
          ledgerAccountId: ledgerAccount._id,
          amount: input.openingBalance,
          date: input.openingDate ?? new Date(),
          label: `Cash — ${input.name}`,
          createdBy: ctx.userId!,
        },
        session,
        ctx,
      );

      return account;
    } catch (err) {
      const duplicate = translateDuplicate(err, "cash account");
      if (duplicate) throw duplicate;
      throw err;
    }
  }, { label: "cashAccount.create" });
}

export async function listCashAccounts(
  page: Paging,
): Promise<{ items: CashAccountSummary[]; total: number; totalBalance: number }> {
  // Feeds every drawer picker as well as the Accounts screen — see `listBankAccounts`.
  const filter: FilterQuery<CashAccountDoc> = { deletedAt: null };

  const [docs, total] = await Promise.all([
    CashAccount.find(filter)
      .sort(page.sort)
      .skip(page.skip)
      .limit(page.limit)
      .populate<{ ledgerAccountId: { _id: Types.ObjectId; cachedBalance: number } }>(
        "ledgerAccountId",
        "cachedBalance",
      )
      .lean(),
    CashAccount.countDocuments(filter),
  ]);

  const items = docs.map((d) => ({
    id: String(d._id),
    name: d.name,
    code: d.code,
    balance: d.ledgerAccountId?.cachedBalance ?? 0,
    isDefault: d.isDefault,
    status: d.status,
    ledgerAccountId: String(d.ledgerAccountId._id),
    createdAt: d.createdAt.toISOString(),
  }));

  return { items, total, totalBalance: items.reduce((sum, i) => sum + i.balance, 0) };
}

/** One cash drawer in the same shape the list returns — used by the create route. */
export async function getCashAccountSummary(id: string): Promise<CashAccountSummary> {
  const d = await CashAccount.findById(id)
    .populate<{ ledgerAccountId: { _id: Types.ObjectId; cachedBalance: number } }>(
      "ledgerAccountId",
      "cachedBalance",
    )
    .lean();

  if (!d) throw new NotFoundError("Cash account", id);

  return {
    id: String(d._id),
    name: d.name,
    code: d.code,
    balance: d.ledgerAccountId?.cachedBalance ?? 0,
    isDefault: d.isDefault,
    status: d.status,
    ledgerAccountId: String(d.ledgerAccountId._id),
    createdAt: d.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Opening balance correction and soft delete                                 */
/* -------------------------------------------------------------------------- */

type AccountKey = "BANK" | "CASH";

/** Either master, with the few things the opening-balance and delete paths need. */
async function loadAccount(kind: AccountKey, id: string, session?: ClientSession) {
  if (kind === "BANK") {
    const account = await BankAccount.findById(id)
      .populate<{ bankId: { name: string; shortName?: string } }>("bankId", "name shortName")
      .session(session ?? null)
      .lean();
    if (!account || account.deletedAt) throw new NotFoundError("Bank account", id);
    return {
      id: account._id,
      ledgerAccountId: account.ledgerAccountId,
      name: account.accountName,
      status: account.status,
      isDefault: false,
      createdAt: account.createdAt,
      // The label `createBankAccount` posted the original opening under.
      label: `${account.bankId?.shortName ?? account.bankId?.name ?? "Bank"} ••${account.accountNumber.slice(-4)}`,
      entity: "BankAccount" as const,
    };
  }

  const account = await CashAccount.findById(id).session(session ?? null).lean();
  if (!account || account.deletedAt) throw new NotFoundError("Cash account", id);
  return {
    id: account._id,
    ledgerAccountId: account.ledgerAccountId,
    name: account.name,
    status: account.status,
    isDefault: account.isDefault,
    createdAt: account.createdAt,
    label: `Cash — ${account.name}`,
    entity: "CashAccount" as const,
  };
}

/**
 * What the opening balance is, and whether anything else has been posted since.
 *
 * An opening and every reversal of one share the OPENING_BALANCE type, so "nothing else
 * posted" is simply no entry of any other type. The live opening is the one neither
 * reversed nor itself a reversal.
 */
async function openingStateOf(ledgerAccountId: Types.ObjectId, session?: ClientSession) {
  const account = await LedgerAccount.findById(ledgerAccountId)
    .select("accountClass")
    .session(session ?? null)
    .lean();
  if (!account) throw new NotFoundError("Ledger account", String(ledgerAccountId));

  // Sequential, not Promise.all: concurrent operations on one session abort the transaction.
  const otherEntryCount = await LedgerEntry.countDocuments({
    ledgerAccountId,
    transactionType: { $ne: "OPENING_BALANCE" },
  }).session(session ?? null);

  const openingEntries = await LedgerEntry.find({ ledgerAccountId, transactionType: "OPENING_BALANCE" })
    .select("transactionId direction amount")
    .session(session ?? null)
    .lean();

  const live: TransactionDoc[] = await Transaction.find({
    _id: { $in: openingEntries.map((e) => e.transactionId) },
    status: "COMPLETED",
    reversalOf: null,
  })
    .sort({ date: 1 })
    .session(session ?? null);

  const liveIds = new Set(live.map((t) => String(t._id)));
  const amount = openingEntries
    .filter((e) => liveIds.has(String(e.transactionId)))
    .reduce((sum, e) => sum + ledger.signedDelta(account.accountClass, e.direction, e.amount), 0);

  return { amount, live, otherEntryCount };
}

function toOpeningBalanceState(
  amount: number,
  posted: Pick<TransactionDoc, "date" | "txnNo"> | null | undefined,
  otherEntryCount: number,
): OpeningBalanceState {
  return {
    amount,
    date: posted ? posted.date.toISOString() : null,
    txnNo: posted?.txnNo ?? null,
    editable: otherEntryCount === 0,
    otherEntryCount,
  };
}

export async function getOpeningBalance(kind: AccountKey, id: string): Promise<OpeningBalanceState> {
  const account = await loadAccount(kind, id);
  const state = await openingStateOf(account.ledgerAccountId);
  return toOpeningBalanceState(state.amount, state.live[0], state.otherEntryCount);
}

/**
 * Correct an opening balance — only while it is the account's only posting.
 *
 * A posted entry is still never rewritten. The live opening is REVERSED and the corrected
 * figure posted in its place, on the same date and inside one database transaction, the
 * way an edited payment is. Changing the amount in place would move a balance with nothing
 * in the ledger to explain it, and leave Opening Equity's running balances disagreeing
 * with its own entries.
 *
 * Once anything else is posted, other entries were checked against this opening (a payment
 * allowed because the opening covered it), so it locks. A correction after that is an
 * adjustment, which says what it is.
 */
export async function changeOpeningBalance(
  kind: AccountKey,
  id: string,
  input: ChangeOpeningBalanceInput,
  ctx: audit.AuditContext,
): Promise<OpeningBalanceState> {
  // Same rule the posting engine applies to every later movement out of a drawer.
  if (kind === "CASH" && input.openingBalance < 0) {
    throw new BadRequestError("A cash drawer cannot open below zero.", "openingBalance");
  }

  return withTransaction(async (session) => {
    const account = await loadAccount(kind, id, session);
    const state = await openingStateOf(account.ledgerAccountId, session);

    if (state.otherEntryCount > 0) {
      throw new BadRequestError(
        `${account.name} already has ${state.otherEntryCount} posting${state.otherEntryCount === 1 ? "" : "s"} ` +
          "besides its opening balance, so the opening is locked. Correct it with an adjustment instead.",
        "openingBalance",
      );
    }

    if (state.amount === input.openingBalance) {
      return toOpeningBalanceState(state.amount, state.live[0], 0);
    }

    const original = state.live[0];
    // The date of the figure being corrected, so a statement for any day reads right.
    const date = original?.date ?? account.createdAt;
    const reason =
      input.reason ||
      `Opening balance corrected from ${formatINR(state.amount)} to ${formatINR(input.openingBalance)}`;

    for (const txn of state.live) {
      await reversals.reverseWithin(String(txn._id), { reason, date: txn.date }, ctx, session);
    }

    // Zero posts nothing: an account may simply open empty.
    const replacement = await ledger.postOpeningBalance(
      {
        ledgerAccountId: account.ledgerAccountId,
        amount: input.openingBalance,
        date,
        label: account.label,
        createdBy: ctx.userId!,
      },
      session,
      ctx,
    );

    // Link the chain both ways, as an edited payment does.
    if (original && replacement) {
      await Transaction.updateOne(
        { _id: original._id },
        { $set: { supersededBy: replacement._id, editReason: reason } },
        { session },
      );
      await Transaction.updateOne(
        { _id: replacement._id },
        { $set: { supersedes: original._id, editReason: reason } },
        { session },
      );
    }

    await audit.record(
      ctx,
      {
        action: "BALANCE_ADJUSTED",
        entity: account.entity,
        entityId: id,
        entityLabel: account.name,
        amount: input.openingBalance,
        reason,
        oldValue: { openingBalance: state.amount, txnNo: original?.txnNo ?? null },
        newValue: { openingBalance: input.openingBalance, txnNo: replacement?.txnNo ?? null },
      },
      session,
    );

    return toOpeningBalanceState(input.openingBalance, replacement, 0);
  }, { label: `${kind === "BANK" ? "bankAccount" : "cashAccount"}.openingBalance` });
}

/**
 * Soft-delete a bank account or a cash drawer. The routes restrict it to a super admin.
 *
 * Deleted means hidden, never erased. The master is stamped `deletedAt` and drops out of
 * every list and picker; it and its ledger account go INACTIVE so nothing new can post to
 * them. The entries stay, because last March's balance sheet still has to add up, and so
 * does the audit trail that explains it.
 *
 * Refused while the account holds money: hiding a balance would leave the Accounts screen
 * disagreeing with every report that still counts it. Move the money out — or, if it is
 * only the opening balance, set that to zero — and then delete.
 */
export async function deleteAccount(kind: AccountKey, id: string, ctx: audit.AuditContext): Promise<void> {
  await withTransaction(async (session) => {
    const account = await loadAccount(kind, id, session);

    const { balance } = await ledger.computeBalance(account.ledgerAccountId, { session });
    if (balance !== 0) {
      throw new BadRequestError(
        `${account.name} still holds ${formatINR(balance)}. Move it to another account first — ` +
          "deleting it now would hide money that the reports still count.",
      );
    }

    const now = new Date();
    const stamp = { deletedAt: now, deletedBy: ctx.userId, status: "INACTIVE", updatedBy: ctx.userId };

    if (kind === "BANK") {
      await BankAccount.updateOne({ _id: account.id }, { $set: stamp }, { session });
    } else {
      // The flag comes off before it is handed on: a partial unique index allows only one.
      await CashAccount.updateOne({ _id: account.id }, { $set: { ...stamp, isDefault: false } }, { session });
      if (account.isDefault) {
        const successor = await CashAccount.findOne({ _id: { $ne: account.id }, deletedAt: null, status: "ACTIVE" })
          .sort({ createdAt: 1 })
          .select("_id")
          .session(session)
          .lean();
        if (successor) {
          await CashAccount.updateOne({ _id: successor._id }, { $set: { isDefault: true } }, { session });
        }
      }
    }

    // The ledger account too, or a caller naming it directly could still post to it, and
    // the ledger pickers would keep offering it.
    await LedgerAccount.updateOne(
      { _id: account.ledgerAccountId },
      { $set: { status: "INACTIVE", deletedAt: now } },
      { session },
    );

    await audit.record(
      ctx,
      {
        action: "DELETE",
        entity: account.entity,
        entityId: id,
        entityLabel: account.name,
        reason: "Soft delete — hidden from the UI; the record, its ledger account and every entry are kept",
        oldValue: { status: account.status, deletedAt: null },
        newValue: { status: "INACTIVE", deletedAt: now.toISOString() },
      },
      session,
    );
  }, { label: `${kind === "BANK" ? "bankAccount" : "cashAccount"}.delete` });
}
