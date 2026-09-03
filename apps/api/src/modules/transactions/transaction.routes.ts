import { Router } from "express";
import { z } from "zod";
import {
  booleanFlag,
  chargeRuleQuerySchema,
  createBankTransferSchema,
  createChargeRuleSchema,
  createExpenseCategorySchema,
  createExpenseSchema,
  createIncomeHeadSchema,
  createIncomeSchema,
  createPaymentInSchema,
  createPaymentOutSchema,
  objectId,
  previewChargeSchema,
  reverseTransactionSchema,
  transactionQuerySchema,
  type CreateBankTransferInput,
  type CreateChargeRuleInput,
  type CreateExpenseInput,
  type CreateIncomeInput,
  type CreatePaymentInInput,
  type CreatePaymentOutInput,
  type TransactionQuery,
  updateAccountHeadSchema,
  updateChargeRuleSchema,
  updatePaymentSchema,
  type PaymentEditResult,
  type UpdateAccountHeadInput,
  type UpdateChargeRuleInput,
  type UpdatePaymentInput,
} from "@amiri/shared";
import { asyncHandler, created, ok, paginated, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import {
  requireAuth,
  requirePermission,
} from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
import { NotFoundError } from "../../lib/errors.js";
import * as audit from "../../services/audit.service.js";
import { auditContextFrom } from "../../services/audit.service.js";
import { ChargeRule, ExpenseCategory, IncomeHead } from "../../models/index.js";
import { computeCharge, previewCharge } from "../../services/charges.service.js";
import * as payments from "./payment.service.js";
import * as expenses from "./expense.service.js";
import * as reversal from "./reversal.service.js";
import * as listing from "./transaction.service.js";

export const paymentInRouter: Router = Router();
export const paymentOutRouter: Router = Router();
export const transferRouter: Router = Router();
export const expenseRouter: Router = Router();
export const incomeRouter: Router = Router();
export const chargeRouter: Router = Router();
export const transactionRouter: Router = Router();

for (const r of [
  paymentInRouter, paymentOutRouter, transferRouter, expenseRouter,
  incomeRouter, chargeRouter, transactionRouter,
]) {
  r.use(requireAuth);
}

const idParam = z.object({ id: objectId });

/** What the toast says after an edit — the two outcomes are genuinely different events. */
function editMessage(result: PaymentEditResult): string {
  return result.outcome === "UPDATED"
    ? `${result.transaction.txnNo} updated`
    : `${result.replaced!.txnNo} reversed and reposted as ${result.transaction.txnNo}`;
}

const headMessage = (name: string, status: string) =>
  status === "ACTIVE" ? `${name} is active` : `${name} retired`;
const SORTABLE = ["date", "txnNo", "grossAmount", "netAmount", "createdAt", "status"];

/**
 * A list handler shared by every per-type screen.
 *
 * Payment In, Payment Out, Expenses and Income are the same query with the type pinned,
 * so they share one implementation rather than four that drift apart.
 */
function listHandler(type?: Parameters<typeof listing.list>[0]["type"]) {
  return asyncHandler(async (req, res) => {
    const query = req.valid.query as TransactionQuery;
    const page = paging(query, { date: -1, _id: -1 }, SORTABLE);

    const { items, total, totals } = await listing.list(
      {
        q: query.q,
        type: type ?? query.type,
        status: query.status,
        partyId: query.partyId,
        accountId: query.accountId,
        paymentMode: query.paymentMode,
        createdBy: query.createdBy,
        from: query.from,
        to: query.to,
        minAmount: query.minAmount,
        maxAmount: query.maxAmount,
      },
      page,
    );

    return paginated(res, items, total, page.page, page.limit, totals);
  });
}

/* ── Payment In (§14) ────────────────────────────────────────────────────── */

paymentInRouter.get(
  "/",
  requirePermission("finance.payment.view"),
  validate({ query: transactionQuerySchema }),
  listHandler("PAYMENT_IN"),
);

paymentInRouter.post(
  "/",
  requirePermission("finance.payment.create"),
  mutationLimiter,
  validate({ body: createPaymentInSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreatePaymentInInput;
    const txn = await payments.createPaymentIn(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/**
 * Edit a posted Payment In.
 *
 * Guarded by `finance.payment.reverse`, not `.edit`: when the money changes this reverses
 * and reposts, and anyone who can do that through this route could do it through the
 * reversal route anyway. Gating it lower would be a way around the stricter permission.
 */
paymentInRouter.patch(
  "/:id",
  requirePermission("finance.payment.reverse"),
  mutationLimiter,
  validate({ params: idParam, body: updatePaymentSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const result = await payments.editPayment(
      id,
      req.valid.body as UpdatePaymentInput,
      auditContextFrom(req),
    );
    return ok(res, result, editMessage(result));
  }),
);

/* ── Payment Out (§15) ───────────────────────────────────────────────────── */

paymentOutRouter.get(
  "/",
  requirePermission("finance.payment.view"),
  validate({ query: transactionQuerySchema }),
  listHandler("PAYMENT_OUT"),
);

paymentOutRouter.post(
  "/",
  requirePermission("finance.payment.create"),
  mutationLimiter,
  validate({ body: createPaymentOutSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreatePaymentOutInput;
    const txn = await payments.createPaymentOut(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/** Edit a posted Payment Out. See the Payment In route above. */
paymentOutRouter.patch(
  "/:id",
  requirePermission("finance.payment.reverse"),
  mutationLimiter,
  validate({ params: idParam, body: updatePaymentSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const result = await payments.editPayment(
      id,
      req.valid.body as UpdatePaymentInput,
      auditContextFrom(req),
    );
    return ok(res, result, editMessage(result));
  }),
);

/* ── Bank transfer (§8) ──────────────────────────────────────────────────── */

transferRouter.get(
  "/",
  requirePermission("finance.bank.view"),
  validate({ query: transactionQuerySchema }),
  listHandler("BANK_TRANSFER"),
);

transferRouter.post(
  "/",
  requirePermission("finance.bank.transfer"),
  mutationLimiter,
  validate({ body: createBankTransferSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateBankTransferInput;
    const txn = await payments.createBankTransfer(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/* ── Expenses (§16) ──────────────────────────────────────────────────────── */

expenseRouter.get(
  "/",
  requirePermission("finance.expense.view"),
  validate({ query: transactionQuerySchema }),
  listHandler("EXPENSE"),
);

expenseRouter.post(
  "/",
  requirePermission("finance.expense.create"),
  mutationLimiter,
  validate({ body: createExpenseSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateExpenseInput;
    const txn = await expenses.createExpense(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/**
 * Expense heads.
 *
 * Defaults to ACTIVE only, because the main consumer is the expense form's dropdown and a
 * retired head must not be selectable for a new transaction. `includeInactive` is for the
 * management screen, which has to show a retired head in order to restore it.
 *
 * Each head carries its ledger balance — the total spent under it. A management screen that
 * listed names alone could not answer the only question anybody asks of this list, which is
 * where the money went.
 */
expenseRouter.get(
  "/categories",
  requirePermission("finance.expense.view"),
  validate({ query: z.object({ includeInactive: booleanFlag.default(false) }) }),
  asyncHandler(async (req, res) => {
    const { includeInactive } = req.valid.query as { includeInactive: boolean };
    return ok(res, await expenses.listHeads("EXPENSE", includeInactive));
  }),
);

expenseRouter.post(
  "/categories",
  requirePermission("finance.expense.manageCategories"),
  mutationLimiter,
  validate({ body: createExpenseCategorySchema }),
  asyncHandler(async (req, res) => {
    const head = await expenses.createHead(
      "EXPENSE",
      req.valid.body as never,
      auditContextFrom(req),
    );
    return created(res, head, `${head.name} added`);
  }),
);

/**
 * Rename or retire an expense head.
 *
 * Retiring is what replaces deleting: a head with postings under it cannot be removed
 * without orphaning them, so `status: "INACTIVE"` takes it out of the pickers and leaves
 * the history intact. The same route reactivates it.
 */
expenseRouter.patch(
  "/categories/:id",
  requirePermission("finance.expense.manageCategories"),
  mutationLimiter,
  validate({ params: idParam, body: updateAccountHeadSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const head = await expenses.updateHead(
      "EXPENSE",
      id,
      req.valid.body as UpdateAccountHeadInput,
      auditContextFrom(req),
    );
    return ok(res, head, headMessage(head.name, head.status));
  }),
);

/* ── Income (§17) ────────────────────────────────────────────────────────── */

incomeRouter.get(
  "/",
  requirePermission("finance.income.view"),
  validate({ query: transactionQuerySchema }),
  listHandler("INCOME"),
);

incomeRouter.post(
  "/",
  requirePermission("finance.income.create"),
  mutationLimiter,
  validate({ body: createIncomeSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateIncomeInput;
    const txn = await expenses.createIncome(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

incomeRouter.get(
  "/heads",
  requirePermission("finance.income.view"),
  validate({ query: z.object({ includeInactive: booleanFlag.default(false) }) }),
  asyncHandler(async (req, res) => {
    const { includeInactive } = req.valid.query as { includeInactive: boolean };
    return ok(res, await expenses.listHeads("INCOME", includeInactive));
  }),
);

incomeRouter.post(
  "/heads",
  requirePermission("finance.income.manageHeads"),
  mutationLimiter,
  validate({ body: createIncomeHeadSchema }),
  asyncHandler(async (req, res) => {
    const head = await expenses.createHead("INCOME", req.valid.body as never, auditContextFrom(req));
    return created(res, head, `${head.name} added`);
  }),
);

/** Rename or retire an income head. See the expense head route above. */
incomeRouter.patch(
  "/heads/:id",
  requirePermission("finance.income.manageHeads"),
  mutationLimiter,
  validate({ params: idParam, body: updateAccountHeadSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const head = await expenses.updateHead(
      "INCOME",
      id,
      req.valid.body as UpdateAccountHeadInput,
      auditContextFrom(req),
    );
    return ok(res, head, headMessage(head.name, head.status));
  }),
);

/* ── Charges & commission (§18) ──────────────────────────────────────────── */

/**
 * The one place a charge rule becomes a summary.
 *
 * `sampleOn100k` is computed, not stored, so a route that returned the raw document showed
 * `NaN` in the UI — which is exactly the field the operator checks to confirm the rule does
 * what they intended.
 */
/**
 * Resolve the heads a set of rules post to, in one pass per collection.
 *
 * A rule may name an expense head or an income head, and which one depends on its bearer,
 * so both collections are searched by id. Two queries for the whole list rather than two
 * per rule — the charges screen is small, but an N+1 here would be N+1 everywhere the
 * summary is used.
 */
async function resolveChargeHeads(
  ids: Array<unknown | null | undefined>,
): Promise<Map<string, { id: string; name: string; code: string }>> {
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (wanted.length === 0) return new Map();

  const [expense, income] = await Promise.all([
    ExpenseCategory.find({ _id: { $in: wanted } }).select("name code").lean(),
    IncomeHead.find({ _id: { $in: wanted } }).select("name code").lean(),
  ]);

  return new Map(
    [...expense, ...income].map((h) => [
      String(h._id),
      { id: String(h._id), name: h.name, code: h.code },
    ]),
  );
}

function toChargeRuleSummary(r: {
  _id: unknown;
  name: string;
  code: string;
  description?: string;
  type: string;
  rateBps?: number;
  fixedAmount?: number;
  tiers?: unknown;
  minCharge: number;
  maxCharge: number;
  bearer: string;
  deductFromAmount?: boolean;
  chargeAccountId?: unknown;
  appliesTo: string[];
  partyTypes: string[];
  status: string;
}, heads?: Map<string, { id: string; name: string; code: string }>) {
  return {
    id: String(r._id),
    name: r.name,
    code: r.code,
    description: r.description,
    type: r.type,
    rateBps: r.rateBps,
    fixedAmount: r.fixedAmount,
    tiers: r.tiers,
    minCharge: r.minCharge,
    maxCharge: r.maxCharge,
    bearer: r.bearer,
    // Rules written before this field existed read as `true` — see the model.
    deductFromAmount: r.deductFromAmount !== false,
    chargeAccount: r.chargeAccountId ? heads?.get(String(r.chargeAccountId)) ?? null : null,
    appliesTo: r.appliesTo,
    partyTypes: r.partyTypes,
    status: r.status,
    // A worked example on ₹1,00,000, so the effect of a rule is legible without anyone
    // having to do the arithmetic in their head.
    sampleOn100k: computeCharge(r as never, 100_000_00).amount,
  };
}

chargeRouter.get(
  "/",
  requirePermission("finance.charges.view"),
  validate({ query: chargeRuleQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { page: number; limit: number; status?: string };
    const filter = query.status ? { status: query.status } : {};

    const rules = await ChargeRule.find(filter).sort({ name: 1 }).lean();
    const heads = await resolveChargeHeads(rules.map((r) => r.chargeAccountId));
    return ok(res, rules.map((r) => toChargeRuleSummary(r, heads)));
  }),
);

chargeRouter.post(
  "/",
  requirePermission("finance.charges.manage"),
  mutationLimiter,
  validate({ body: createChargeRuleSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateChargeRuleInput;
    const rule = await ChargeRule.create({ ...input, createdBy: req.auth!.userId });
    const heads = await resolveChargeHeads([rule.chargeAccountId]);
    // The list's shape — including the worked example, which is the one field a caller
    // wants back to confirm the rule does what they meant.
    return created(
      res,
      toChargeRuleSummary(rule.toObject() as never, heads),
      `${rule.name} added`,
    );
  }),
);

/**
 * Change a charge rule, including who bears it and whether it is still active.
 *
 * Affects FUTURE postings only — every posted transaction froze its own charge amount and
 * basis string at the time, so correcting a rule cannot rewrite what was already charged.
 * The audit row carries the before and after, because "who changed the commission rate,
 * and when" is a question this screen has to be able to answer.
 */
chargeRouter.patch(
  "/:id",
  requirePermission("finance.charges.manage"),
  mutationLimiter,
  validate({ params: idParam, body: updateChargeRuleSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const input = req.valid.body as UpdateChargeRuleInput;

    const rule = await ChargeRule.findById(id);
    if (!rule) throw new NotFoundError("Charge rule", id);

    const before = {
      name: rule.name,
      type: rule.type,
      rateBps: rule.rateBps,
      fixedAmount: rule.fixedAmount,
      minCharge: rule.minCharge,
      maxCharge: rule.maxCharge,
      bearer: rule.bearer,
      appliesTo: [...rule.appliesTo],
      status: rule.status,
    };

    Object.assign(rule, input, { updatedBy: req.auth!.userId });
    await rule.save();

    await audit.recordSafe(auditContextFrom(req), {
      action: "UPDATE",
      entity: "ChargeRule",
      entityId: id,
      entityLabel: `${rule.code} — ${rule.name}`,
      oldValue: before,
      newValue: {
        name: rule.name,
        type: rule.type,
        rateBps: rule.rateBps,
        fixedAmount: rule.fixedAmount,
        minCharge: rule.minCharge,
        maxCharge: rule.maxCharge,
        bearer: rule.bearer,
        appliesTo: [...rule.appliesTo],
        status: rule.status,
      },
    });

    const heads = await resolveChargeHeads([rule.chargeAccountId]);
    return ok(
      res,
      toChargeRuleSummary(rule.toObject() as never, heads),
      rule.status === "ACTIVE" ? `${rule.name} updated` : `${rule.name} retired`,
    );
  }),
);

/**
 * Preview a charge without posting anything.
 *
 * Powers the live "Gross / Charge / Net" breakdown in the payment forms, so an operator
 * sees the three figures §18 requires BEFORE committing, not after.
 */
chargeRouter.post(
  "/preview",
  requirePermission("finance.charges.view"),
  validate({ body: previewChargeSchema }),
  asyncHandler(async (req, res) => {
    const { chargeRuleId, amount, transactionType } = req.valid.body as {
      chargeRuleId: string;
      amount: number;
      transactionType?: string;
    };
    return ok(res, await previewCharge(chargeRuleId, amount, transactionType));
  }),
);

/* ── All transactions + reversal (§28) ───────────────────────────────────── */

transactionRouter.get(
  "/",
  requirePermission("finance.daybook.view"),
  validate({ query: transactionQuerySchema }),
  listHandler(),
);

transactionRouter.get(
  "/:id",
  requirePermission("finance.daybook.view"),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    return ok(res, await listing.getDetail(id));
  }),
);

/**
 * Reverse a posted transaction.
 *
 * There is no DELETE route for a transaction anywhere in this API — by design. The reason
 * is mandatory and at least 10 characters, enforced by the schema.
 */
transactionRouter.post(
  "/:id/reverse",
  requirePermission("finance.payment.reverse"),
  mutationLimiter,
  validate({ params: idParam, body: reverseTransactionSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const body = req.valid.body as { reason: string; date?: Date };

    const { original, reversal: mirror } = await reversal.reverseTransaction(
      id,
      body,
      auditContextFrom(req),
    );

    return ok(
      res,
      { original: { id: String(original._id), txnNo: original.txnNo, status: original.status },
        reversal: { id: String(mirror._id), txnNo: mirror.txnNo } },
      `${original.txnNo} reversed by ${mirror.txnNo}`,
    );
  }),
);
