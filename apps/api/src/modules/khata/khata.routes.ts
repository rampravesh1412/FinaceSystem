import { Router } from "express";
import { z } from "zod";
import {
  createAdjustmentSchema,
  createSavingsAccountSchema,
  createSettlementSchema,
  creditQuerySchema,
  importStatementSchema,
  khataQuerySchema,
  listQuery,
  matchLineSchema,
  objectId,
  savingsTransactionSchema,
  startReconciliationSchema,
  type CreateAdjustmentInput,
  type CreateSavingsAccountInput,
  type CreateSettlementInput,
  type CreditQuery,
  type ImportStatementInput,
  type SavingsTransactionInput,
  type StartReconciliationInput,
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
import { exportLimiter, mutationLimiter } from "../../middleware/security.js";
import { auditContextFrom } from "../../services/audit.service.js";
import * as khata from "./khata.service.js";
import * as savings from "../savings/savings.service.js";
import * as recon from "../reconciliation/reconciliation.service.js";
import * as settlements from "../settlements/settlement.service.js";

export const khataRouter: Router = Router();
export const creditRouter: Router = Router();
export const savingsRouter: Router = Router();
export const reconciliationRouter: Router = Router();
export const settlementRouter: Router = Router();
export const adjustmentRouter: Router = Router();

for (const r of [khataRouter, creditRouter, savingsRouter, reconciliationRouter, settlementRouter, adjustmentRouter]) {
  r.use(requireAuth);
}

const idParam = z.object({ id: objectId });

/* ── Digital Khata (§11) ─────────────────────────────────────────────────── */

khataRouter.get(
  "/:id",
  requirePermission("finance.khata.view"),
  requireBranchAccess({ optional: true }),
  validate({ params: idParam, query: khataQuerySchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const query = req.valid.query as { from?: Date; to?: Date; limit: number };
    return ok(
      res,
      await khata.getStatement(
        id,
        { from: query.from, to: query.to, limit: query.limit },
        scopeOf(req),
      ),
    );
  }),
);

/* ── Adjustments (§25) ───────────────────────────────────────────────────── */

adjustmentRouter.post(
  "/",
  requirePermission("finance.adjustment.create"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createAdjustmentSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateAdjustmentInput;
    assertBranchInScope(req, input.branchId);
    const txn = await khata.createAdjustment(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/* ── Credit & aging (§12) ────────────────────────────────────────────────── */

creditRouter.get(
  "/",
  requirePermission("finance.party.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: creditQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as CreditQuery;
    const { rows, summary } = await khata.creditReport(scopeOf(req), {
      overLimit: query.overLimit,
      overdueOnly: query.overdueOnly,
      bucket: query.bucket,
      limit: query.limit,
    });
    // The summary describes the whole book; the rows are whatever was filtered.
    return ok(res, { rows, summary });
  }),
);

/* ── Bachat Khata (§13) ──────────────────────────────────────────────────── */

savingsRouter.get(
  "/",
  requirePermission("finance.savings.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as z.infer<typeof listQuery>;
    const page = paging(query, { memberName: 1 }, ["memberName", "accountNo", "openedAt"]);
    const { items, total, summary } = await savings.listAccounts(
      scopeOf(req),
      { q: query.q },
      page,
    );
    return paginated(res, items, total, page.page, page.limit, summary as never);
  }),
);

savingsRouter.post(
  "/",
  requirePermission("finance.savings.manage"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createSavingsAccountSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateSavingsAccountInput;
    assertBranchInScope(req, input.branchId);
    const account = await savings.createAccount(input, auditContextFrom(req));
    // The list's shape, so the caller gets the posted opening balance back.
    return created(
      res,
      await savings.getAccountSummary(String(account._id)),
      `${account.accountNo} opened`,
    );
  }),
);

savingsRouter.get(
  "/:id/passbook",
  requirePermission("finance.savings.view"),
  requireBranchAccess({ optional: true }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    return ok(res, await savings.getPassbook(id, scopeOf(req)));
  }),
);

savingsRouter.post(
  "/transactions",
  requirePermission("finance.savings.transact"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: savingsTransactionSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as SavingsTransactionInput;
    const txn = await savings.postSavingsTransaction(input, auditContextFrom(req));
    return created(res, txn, `${txn.txnNo} posted`);
  }),
);

/* ── Reconciliation (§23) ────────────────────────────────────────────────── */

reconciliationRouter.post(
  "/",
  requirePermission("finance.bank.reconcile"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: startReconciliationSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as StartReconciliationInput;
    const doc = await recon.start(input, scopeOf(req), auditContextFrom(req));
    return created(res, await recon.getSummary(String(doc._id), scopeOf(req)), "Reconciliation opened");
  }),
);

/**
 * Every reconciliation in scope.
 *
 * `requireBranchAccess` is mandatory here, not optional: without `req.scope.filter` this
 * would list every branch's reconciliations to anyone holding the permission.
 */
reconciliationRouter.get(
  "/",
  requirePermission("finance.bank.reconcile"),
  requireBranchAccess({ optional: true }),
  validate({
    query: listQuery.extend({ bankAccountId: objectId.optional(), status: z.string().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as {
      page: number; limit: number; bankAccountId?: string; status?: string;
    };
    const page = paging(query, { createdAt: -1 }, ["createdAt", "to", "difference"]);
    const { items, total } = await recon.list(
      scopeOf(req),
      { bankAccountId: query.bankAccountId, status: query.status },
      page,
    );
    return paginated(res, items, total, page.page, page.limit);
  }),
);

reconciliationRouter.get(
  "/:id",
  requirePermission("finance.bank.reconcile"),
  requireBranchAccess({ optional: true }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    return ok(res, await recon.getSummary(id, scopeOf(req)));
  }),
);

reconciliationRouter.get(
  "/:id/lines",
  requirePermission("finance.bank.reconcile"),
  requireBranchAccess({ optional: true }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    return ok(res, await recon.getLines(id, scopeOf(req)));
  }),
);

reconciliationRouter.post(
  "/:id/statement",
  requirePermission("finance.bank.statement.import"),
  requireBranchAccess({ optional: true }),
  exportLimiter,
  validate({ params: idParam, body: importStatementSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const result = await recon.importStatement(
      id,
      req.valid.body as ImportStatementInput,
      scopeOf(req),
      auditContextFrom(req),
    );
    return ok(
      res,
      result,
      `${result.imported} lines imported, ${result.autoMatched} matched automatically`,
    );
  }),
);

reconciliationRouter.post(
  "/lines/:id/match",
  requirePermission("finance.bank.reconcile"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ params: idParam, body: matchLineSchema.omit({ lineId: true }) }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    await recon.setLineStatus(id, req.valid.body as never, scopeOf(req), auditContextFrom(req));
    return ok(res, { matched: true }, "Line updated");
  }),
);

reconciliationRouter.post(
  "/:id/complete",
  requirePermission("finance.bank.reconcile"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({
    params: idParam,
    body: z.object({
      notes: z.string().trim().max(1000).optional(),
      /** Required to close with a non-zero difference. §62: it is acknowledged, not hidden. */
      acknowledgeDifference: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const body = req.valid.body as { notes?: string; acknowledgeDifference: boolean };
    await recon.complete(id, body, scopeOf(req), auditContextFrom(req));
    return ok(res, await recon.getSummary(id, scopeOf(req)), "Reconciliation closed");
  }),
);

/* ── Settlement (§24) ────────────────────────────────────────────────────── */

settlementRouter.get(
  "/",
  requirePermission("finance.settlement.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: listQuery.extend({ status: z.string().optional(), kind: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { page: number; limit: number; status?: string; kind?: string };
    const page = paging(query, { date: -1 }, ["date", "amount", "createdAt"]);
    const { items, total, pending } = await settlements.listSettlements(
      scopeOf(req),
      { status: query.status, kind: query.kind },
      page,
    );
    return paginated(res, items, total, page.page, page.limit, { pendingAmount: pending });
  }),
);

settlementRouter.post(
  "/",
  requirePermission("finance.settlement.create"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createSettlementSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateSettlementInput;
    assertBranchInScope(req, input.branchId);
    const settlement = await settlements.createSettlement(input, auditContextFrom(req));
    return created(res, settlement, `${settlement.settlementNo} created`);
  }),
);

settlementRouter.post(
  "/:id/execute",
  requirePermission("finance.settlement.create"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({
    params: idParam,
    body: z.object({
      amount: z.union([z.number(), z.string()]),
      accountId: objectId,
      paymentMode: z.string(),
      date: z.coerce.date(),
      referenceNo: z.string().trim().max(80).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const body = req.valid.body as {
      amount: number | string;
      accountId: string;
      paymentMode: string;
      date: Date;
      referenceNo?: string;
    };
    const { parseAmount } = await import("@amiri/shared");
    const settlement = await settlements.executeSettlement(
      id,
      { ...body, amount: parseAmount(body.amount) },
      scopeOf(req),
      auditContextFrom(req),
    );
    return ok(res, settlement, `${settlement.settlementNo} is now ${settlement.status.toLowerCase()}`);
  }),
);
