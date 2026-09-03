import { Router } from "express";
import { z } from "zod";
import {
  asOfSchema,
  objectId,
  recordTallySchema,
  reportRangeSchema,
  type AsOfQuery,
  type RecordTallyInput,
  type ReportRange,
} from "@amiri/shared";
import { asyncHandler, ok } from "../../lib/http.js";
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
import * as reports from "../../services/reports.service.js";
import * as tally from "./cashTally.service.js";
import * as dashboard from "./dashboard.service.js";

export const reportRouter: Router = Router();
export const dashboardRouter: Router = Router();
export const tallyRouter: Router = Router();

for (const r of [reportRouter, dashboardRouter, tallyRouter]) r.use(requireAuth);

/**
 * Resolve the branch a report should cover.
 *
 * A scoped caller is pinned to their own branch whatever they ask for; an unscoped one may
 * name a branch or omit it for the whole organisation. The narrowing happens here rather
 * than in each report so no report can forget it.
 */
function resolveBranch(
  req: Parameters<typeof scopeOf>[0],
  requested?: string,
): string | undefined {
  const scope = req.scope!;
  if (scope.isUnscoped) return requested;
  if (requested) {
    assertBranchInScope(req, requested);
    return requested;
  }
  return scope.activeBranchId ? String(scope.activeBranchId) : String(scope.branchIds[0] ?? "");
}

/* ── Dashboards (§31, §32, §33) ──────────────────────────────────────────── */

dashboardRouter.get(
  "/",
  requireBranchAccess({ optional: true }),
  validate({ query: z.object({ branchId: objectId.optional(), days: z.coerce.number().min(7).max(90).default(30) }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { branchId?: string; days: number };
    const scope = req.scope!;

    return ok(
      res,
      await dashboard.buildDashboard({
        branchId: resolveBranch(req, query.branchId) || null,
        isUnscoped: scope.isUnscoped,
        branchIds: scope.branchIds,
        trendDays: query.days,
      }),
    );
  }),
);

/* ── Profit & Loss (§34) ─────────────────────────────────────────────────── */

reportRouter.get(
  "/profit-loss",
  requirePermission("reports.pnl"),
  requireBranchAccess({ optional: true }),
  validate({ query: reportRangeSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as ReportRange;
    return ok(
      res,
      await reports.profitAndLoss({
        from: query.from,
        to: query.to,
        branchId: resolveBranch(req, query.branchId),
      }),
    );
  }),
);

/* ── Monthly history ─────────────────────────────────────────────────────── */

/**
 * Month-by-month P&L, expenses and party movement over a range.
 *
 * Gated on `reports.pnl` rather than the broader `reports.view`: the rows carry the profit
 * figure, and someone who may not open the P&L should not be handed twelve of them in a
 * table instead.
 */
reportRouter.get(
  "/monthly-history",
  requirePermission("reports.pnl"),
  requireBranchAccess({ optional: true }),
  validate({ query: reportRangeSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as ReportRange;
    return ok(
      res,
      await reports.monthlyHistory({
        from: query.from,
        to: query.to,
        branchId: resolveBranch(req, query.branchId),
      }),
    );
  }),
);

/* ── Balance Sheet (§34) ─────────────────────────────────────────────────── */

reportRouter.get(
  "/balance-sheet",
  requirePermission("reports.balanceSheet"),
  requireBranchAccess({ optional: true }),
  validate({ query: asOfSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as AsOfQuery;
    return ok(
      res,
      await reports.balanceSheet({
        asOf: query.asOf ?? new Date(),
        branchId: resolveBranch(req, query.branchId),
      }),
    );
  }),
);

/* ── Cash flow ───────────────────────────────────────────────────────────── */

reportRouter.get(
  "/cash-flow",
  requirePermission("reports.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: reportRangeSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as ReportRange;
    return ok(
      res,
      await reports.cashFlow({
        from: query.from,
        to: query.to,
        branchId: resolveBranch(req, query.branchId),
      }),
    );
  }),
);

/* ── Daily Cash Tally (§20) ──────────────────────────────────────────────── */

tallyRouter.get(
  "/targets",
  requirePermission("finance.cash.view"),
  asyncHandler(async (_req, res) => ok(res, await tally.tallyTargets())),
);

tallyRouter.get(
  "/",
  requirePermission("finance.cash.view"),
  validate({ query: z.object({ date: z.coerce.date().optional(), cashAccountId: objectId }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { date?: Date; cashAccountId: string };
    return ok(res, await tally.getTally(query.date ?? new Date(), query.cashAccountId));
  }),
);

/**
 * Record the counted amount.
 *
 * This NEVER posts an adjustment to make the drawer agree. A shortfall is a finding, and
 * writing it off is a separate, separately-permissioned decision (§62).
 */
tallyRouter.post(
  "/",
  requirePermission("finance.cash.tally"),
  mutationLimiter,
  validate({ body: recordTallySchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as RecordTallyInput;
    const result = await tally.recordTally(input, auditContextFrom(req));

    const message =
      result.status === "MATCHED"
        ? "Cash tallies exactly"
        : `${result.status === "SHORT" ? "SHORT" : "EXCESS"} — the difference has been recorded for investigation`;

    return ok(res, result, message);
  }),
);

tallyRouter.get(
  "/history",
  requirePermission("finance.cash.view"),
  validate({ query: z.object({ cashAccountId: objectId, limit: z.coerce.number().min(1).max(180).default(60) }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { cashAccountId: string; limit: number };
    return ok(res, await tally.listTallies(query.cashAccountId, query.limit));
  }),
);
