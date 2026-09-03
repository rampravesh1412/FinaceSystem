import { Types, type ClientSession } from "mongoose";
import type { CreateExpenseInput, CreateIncomeInput } from "@amiri/shared";
import {
  ExpenseCategory,
  IncomeHead,
  LedgerAccount,
  nextSequence,
  type AccountHeadDoc,
  type TransactionDoc,
} from "../../models/index.js";
import { BadRequestError, NotFoundError, translateDuplicate } from "../../lib/errors.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as accounts from "../../services/accounts.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Expenses (§16) and Income (§17).
 *
 * An expense head IS a ledger account. That is what makes the Profit & Loss a plain
 * aggregation over entries grouped by account, rather than a report with a hand-written
 * case for every category anyone ever invents.
 */

/* -------------------------------------------------------------------------- */
/* Heads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every head of one kind, with what has been posted under it.
 *
 * The balance comes from the head's own ledger account, which is the whole point of §4.1:
 * an expense head IS a ledger account, so "what did we spend on salaries" is a field read
 * rather than a report.
 */
export interface AccountHeadRow {
  id: string;
  name: string;
  code: string;
  description?: string;
  parentId: string | null;
  parentName?: string;
  ledgerAccountId: string;
  /** Total posted under this head, all time. Debit-positive for expenses. */
  balance: number;
  entryCount: number;
  status: string;
}

export async function listHeads(
  kind: "EXPENSE" | "INCOME",
  includeInactive = false,
): Promise<AccountHeadRow[]> {
  const Model = kind === "EXPENSE" ? ExpenseCategory : IncomeHead;

  const heads = await Model.find(includeInactive ? {} : { status: "ACTIVE" })
    .sort({ name: 1 })
    .lean();

  const ledgerAccounts = await LedgerAccount.find({
    _id: { $in: heads.map((h) => h.ledgerAccountId) },
  })
    .select("cachedBalance cachedEntryCount accountClass")
    .lean();

  const byId = new Map(ledgerAccounts.map((a) => [String(a._id), a]));
  const nameById = new Map(heads.map((h) => [String(h._id), h.name]));

  return heads.map((h) => {
    const account = byId.get(String(h.ledgerAccountId));
    // Income is credit-normal, so its cached balance is negative in debit-positive terms.
    // Flipped here so both lists read as "how much", not "which side of the ledger".
    const raw = account?.cachedBalance ?? 0;
    return {
      id: String(h._id),
      name: h.name,
      code: h.code,
      description: h.description,
      parentId: h.parentId ? String(h.parentId) : null,
      parentName: h.parentId ? nameById.get(String(h.parentId)) : undefined,
      ledgerAccountId: String(h.ledgerAccountId),
      balance: kind === "INCOME" ? -raw : raw,
      entryCount: account?.cachedEntryCount ?? 0,
      status: h.status,
    };
  });
}

export async function createHead(
  kind: "EXPENSE" | "INCOME",
  input: { name: string; code?: string; description?: string; parentId?: string; status: string },
  ctx: audit.AuditContext,
): Promise<AccountHeadDoc> {
  const Model = kind === "EXPENSE" ? ExpenseCategory : IncomeHead;
  const prefix = kind === "EXPENSE" ? "EXP" : "INC";

  return withTransaction(async (session) => {
    try {
      const code =
        input.code ??
        `${prefix}-${String(await nextSequence(`HEAD-${prefix}`, 0, session)).padStart(3, "0")}`;

      const ledgerAccount = await ledger.createLedgerAccount(
        {
          code: `${prefix}-HEAD-${code}`,
          name: input.name,
          kind: kind === "EXPENSE" ? "EXPENSE" : "INCOME",
          // Heads are organisation-wide: "Salary" means the same thing in every branch,
          // and the P&L needs to group across branches without merging duplicates.
          branchId: null,
          refKind: kind === "EXPENSE" ? "ExpenseCategory" : "IncomeHead",
          enforceBalance: false,
          createdBy: ctx.userId,
        },
        session,
      );

      const [head] = await Model.create(
        [
          {
            name: input.name,
            code,
            description: input.description,
            parentId: input.parentId ?? null,
            ledgerAccountId: ledgerAccount._id,
            status: input.status,
            createdBy: ctx.userId,
          },
        ],
        { session },
      );

      if (!head) throw new Error("Head creation returned no document");
      await LedgerAccount.updateOne({ _id: ledgerAccount._id }, { $set: { refId: head._id } }, { session });

      await audit.record(
        ctx,
        {
          action: "CREATE",
          entity: kind === "EXPENSE" ? "ExpenseCategory" : "IncomeHead",
          entityId: String(head._id),
          entityLabel: input.name,
          newValue: { name: input.name, code },
        },
        session,
      );

      return head;
    } catch (err) {
      const duplicate = translateDuplicate(err, kind === "EXPENSE" ? "expense head" : "income head");
      if (duplicate) throw duplicate;
      throw err;
    }
  }, { label: "head.create" });
}

/* -------------------------------------------------------------------------- */
/* Expense                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Record an expense.
 *
 * Paid immediately from an account:
 *
 *     DR  Expense: Panel        5,000
 *         CR  Bank: HDFC                 5,000
 *
 * Or booked as payable to a vendor, settled later by a Payment Out:
 *
 *     DR  Expense: Panel        5,000
 *         CR  Party: Vendor             5,000     (a negative party balance — DENA HAI)
 *
 * Tax is posted to the same expense head rather than a separate input-credit account.
 * That is correct for a business not claiming GST input credit; a business that does
 * claim it needs an INPUT_TAX asset account, which is a deliberate future change and not
 * something to guess at now.
 */
export async function createExpense(
  input: CreateExpenseInput,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  return withTransaction(async (session) => {
    const category = await ExpenseCategory.findById(input.categoryId).session(session);
    if (!category) throw new NotFoundError("Expense head", input.categoryId);
    if (category.status !== "ACTIVE") {
      throw new BadRequestError(`The expense head "${category.name}" is not active`, "categoryId");
    }

    // `?? 0`, not a bare add. This service is also called by the seed and by importers
    // that do not pass through the Zod schema, and `amount + undefined` is NaN — which
    // the ledger correctly refuses, but only after a confusing journey.
    const total = input.amount + (input.taxAmount ?? 0);

    const account = input.accountId
      ? await accounts.resolveAccount(input.accountId, session)
      : null;
    const party = input.partyId
      ? await accounts.resolveParty(input.partyId, session)
      : null;

    // Schema-level validation already requires one of the two, but the service must not
    // depend on a caller having gone through that schema.
    const creditTarget = account?.ledgerAccountId ?? party?.ledgerAccountId;
    if (!creditTarget) {
      throw new BadRequestError(
        "Choose an account to pay from, or a party to book this against",
        "accountId",
      );
    }

    const lines: ledger.PostingLine[] = [
      { ledgerAccountId: category.ledgerAccountId, direction: "DEBIT", amount: total },
      { ledgerAccountId: creditTarget, direction: "CREDIT", amount: total },
    ];

    const txn = await ledger.postTransaction(
      {
        type: "EXPENSE",
        date: input.date,
        branchId: input.branchId,
        lines,
        grossAmount: total,
        paymentMode: input.paymentMode,
        referenceNo: input.referenceNo ?? input.invoiceNo,
        narration: input.narration ?? `${category.name}${party ? ` — ${party.name}` : ""}`,
        partyId: party?.id ?? null,
        createdBy: ctx.userId!,
        attachments: input.attachments,
        notes: input.notes ? [{ text: input.notes, createdBy: ctx.userId, createdAt: new Date() }] : [],
        details: {
          categoryId: category._id,
          categoryName: category.name,
          accountId: account?.id ?? null,
          accountKind: account?.kind,
          accountLabel: account?.label ?? (party ? `Payable — ${party.name}` : undefined),
          taxAmount: input.taxAmount ?? 0,
          invoiceNo: input.invoiceNo,
          invoiceDate: input.invoiceDate,
          items: input.items,
        },
      },
      session,
      { ...ctx, branchId: String(input.branchId) },
    );

    return txn;
  }, { label: "expense.create" });
}

/* -------------------------------------------------------------------------- */
/* Income                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Record income.
 *
 *     DR  Bank/Cash            25,000     money arrives
 *         CR  Income: Commission          25,000
 *
 * Note this is NOT a Payment In: no party debt is being settled. Conflating the two is
 * how a receivable ends up written off by accident — the party would appear to have paid
 * when they have not.
 */
export async function createIncome(
  input: CreateIncomeInput,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  return withTransaction(async (session) => {
    const head = await IncomeHead.findById(input.headId).session(session);
    if (!head) throw new NotFoundError("Income head", input.headId);
    if (head.status !== "ACTIVE") {
      throw new BadRequestError(`The income head "${head.name}" is not active`, "headId");
    }

    const account = await accounts.resolveAccount(input.accountId, session);
    const party = input.partyId
      ? await accounts.resolveParty(input.partyId, session)
      : null;

    const lines: ledger.PostingLine[] = [
      { ledgerAccountId: account.ledgerAccountId, direction: "DEBIT", amount: input.amount },
      { ledgerAccountId: head.ledgerAccountId, direction: "CREDIT", amount: input.amount },
    ];

    const txn = await ledger.postTransaction(
      {
        type: "INCOME",
        date: input.date,
        branchId: input.branchId,
        lines,
        grossAmount: input.amount,
        paymentMode: input.paymentMode,
        referenceNo: input.referenceNo,
        narration: input.narration ?? `${head.name}${party ? ` — ${party.name}` : ""}`,
        partyId: party?.id ?? null,
        createdBy: ctx.userId!,
        attachments: input.attachments,
        notes: input.notes ? [{ text: input.notes, createdBy: ctx.userId, createdAt: new Date() }] : [],
        details: {
          headId: head._id,
          headName: head.name,
          accountId: account.id,
          accountKind: account.kind,
          accountLabel: account.label,
        },
      },
      session,
      { ...ctx, branchId: String(input.branchId) },
    );

    return txn;
  }, { label: "income.create" });
}

/** Seed the expense heads named in the brief, plus the usual operating categories. */
export const DEFAULT_EXPENSE_HEADS = [
  "Salary", "Rent", "Marketing", "Bank Charges", "Bonus", "Ram Ji Expense",
  "Panel Expense", "Travel", "Office", "Software", "Domain", "Hosting",
  "Electricity", "Internet", "Maintenance", "Other",
] as const;

export const DEFAULT_INCOME_HEADS = [
  "Commission", "Service Income", "Interest", "Other Income",
] as const;

/** Used by the seed and by tests; not exposed as a route. */
export async function ensureHead(
  kind: "EXPENSE" | "INCOME",
  name: string,
  ctx: audit.AuditContext,
  session?: ClientSession,
): Promise<Types.ObjectId> {
  const Model = kind === "EXPENSE" ? ExpenseCategory : IncomeHead;
  const existing = await Model.findOne({ name }).session(session ?? null).lean();
  if (existing) return existing._id;

  const head = await createHead(kind, { name, status: "ACTIVE" }, ctx);
  return head._id;
}
