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
} from "@amiri/shared";
import { asyncHandler, created, ok, paginated, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import {
  assertBranchInScope,
  requireAuth,
  requireBranchAccess,
  requirePermission,
  scopeOf,
} from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
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
        scopeFilter: scopeOf(req),
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
  requireBranchAccess({ optional: true }),
  validate({ query: transactionQuerySchema }),
  listHandler("PAYMENT_IN"),
);

paymentInRouter.post(
  "/",
  requirePermission("finance.payment.create"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createPaymentInSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreatePaymentInInput;
    // The branch arrives in the body, so this is the write-path scope check.
    assertBranchInScope(req, input.branchId);
    const txn = await payments.createPaymentIn(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/* ── Payment Out (§15) ───────────────────────────────────────────────────── */

paymentOutRouter.get(
  "/",
  requirePermission("finance.payment.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: transactionQuerySchema }),
  listHandler("PAYMENT_OUT"),
);

paymentOutRouter.post(
  "/",
  requirePermission("finance.payment.create"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createPaymentOutSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreatePaymentOutInput;
    assertBranchInScope(req, input.branchId);
    const txn = await payments.createPaymentOut(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/* ── Bank transfer (§8) ──────────────────────────────────────────────────── */

transferRouter.get(
  "/",
  requirePermission("finance.bank.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: transactionQuerySchema }),
  listHandler("BANK_TRANSFER"),
);

transferRouter.post(
  "/",
  requirePermission("finance.bank.transfer"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createBankTransferSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateBankTransferInput;
    assertBranchInScope(req, input.branchId);
    const txn = await payments.createBankTransfer(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/* ── Expenses (§16) ──────────────────────────────────────────────────────── */

expenseRouter.get(
  "/",
  requirePermission("finance.expense.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: transactionQuerySchema }),
  listHandler("EXPENSE"),
);

expenseRouter.post(
  "/",
  requirePermission("finance.expense.create"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createExpenseSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateExpenseInput;
    assertBranchInScope(req, input.branchId);
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

/* ── Income (§17) ────────────────────────────────────────────────────────── */

incomeRouter.get(
  "/",
  requirePermission("finance.income.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: transactionQuerySchema }),
  listHandler("INCOME"),
);

incomeRouter.post(
  "/",
  requirePermission("finance.income.create"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createIncomeSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateIncomeInput;
    assertBranchInScope(req, input.branchId);
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

/* ── Charges & commission (§18) ──────────────────────────────────────────── */

/**
 * The one place a charge rule becomes a summary.
 *
 * `sampleOn100k` is computed, not stored, so a route that returned the raw document showed
 * `NaN` in the UI — which is exactly the field the operator checks to confirm the rule does
 * what they intended.
 */
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
  appliesTo: string[];
  partyTypes: string[];
  status: string;
}) {
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
    return ok(res, rules.map(toChargeRuleSummary));
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
    // The list's shape — including the worked example, which is the one field a caller
    // wants back to confirm the rule does what they meant.
    return created(res, toChargeRuleSummary(rule.toObject() as never), `${rule.name} added`);
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
    const { chargeRuleId, amount } = req.valid.body as { chargeRuleId: string; amount: number };
    return ok(res, await previewCharge(chargeRuleId, amount));
  }),
);

/* ── All transactions + reversal (§28) ───────────────────────────────────── */

transactionRouter.get(
  "/",
  requirePermission("finance.daybook.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: transactionQuerySchema }),
  listHandler(),
);

transactionRouter.get(
  "/:id",
  requirePermission("finance.daybook.view"),
  requireBranchAccess({ optional: true }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    return ok(res, await listing.getDetail(id, scopeOf(req)));
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
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ params: idParam, body: reverseTransactionSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const body = req.valid.body as { reason: string; date?: Date };

    const { original, reversal: mirror } = await reversal.reverseTransaction(
      id,
      body,
      scopeOf(req),
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
