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
 * Resolve the branches a report should cover.
 *
 * A named branch must be one the caller holds. With no branch in context — the picker's
 * "All branches" — a scoped caller is widened to their *own* assignment list, never to the
 * organisation; only an unscoped caller gets the empty scope that means everything. The
 * narrowing happens here rather than in each report so no report can forget it.
 */
function resolveScope(
  req: Parameters<typeof scopeOf>[0],
  requested?: string,
): reports.BranchScope {
  const scope = req.scope!;

  if (requested) {
    if (!scope.isUnscoped) assertBranchInScope(req, requested);
    return { branchId: requested };
  }
  if (scope.activeBranchId) return { branchId: String(scope.activeBranchId) };

  return scope.isUnscoped ? {} : { branchIds: scope.branchIds };
}

/* ── Dashboards (§31, §32, §33) ──────────────────────────────────────────── */

dashboardRouter.get(
  "/",
  requireBranchAccess({ optional: true }),
  validate({ query: z.object({ branchId: objectId.optional(), days: z.coerce.number().min(7).max(90).default(30) }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { branchId?: string; days: number };
    const scope = req.scope!;
    const resolved = resolveScope(req, query.branchId);

    return ok(
      res,
      await dashboard.buildDashboard({
        branchId: resolved.branchId ? String(resolved.branchId) : null,
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
        ...resolveScope(req, query.branchId),
        from: query.from,
        to: query.to,
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
        ...resolveScope(req, query.branchId),
        asOf: query.asOf ?? new Date(),
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
        ...resolveScope(req, query.branchId),
        from: query.from,
        to: query.to,
      }),
    );
  }),
);

/* ── Daily Cash Tally (§20) ──────────────────────────────────────────────── */

tallyRouter.get(
  "/targets",
  requirePermission("finance.cash.view"),
  requireBranchAccess({ optional: true }),
  asyncHandler(async (req, res) => ok(res, await tally.tallyTargets(scopeOf(req)))),
);

tallyRouter.get(
  "/",
  requirePermission("finance.cash.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: z.object({ date: z.coerce.date().optional(), cashAccountId: objectId }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { date?: Date; cashAccountId: string };
    return ok(res, await tally.getTally(query.date ?? new Date(), query.cashAccountId, scopeOf(req)));
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
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: recordTallySchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as RecordTallyInput;
    assertBranchInScope(req, input.branchId);

    const result = await tally.recordTally(input, auditContextFrom(req), scopeOf(req));

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
  requireBranchAccess({ optional: true }),
  validate({ query: z.object({ cashAccountId: objectId, limit: z.coerce.number().min(1).max(180).default(60) }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { cashAccountId: string; limit: number };
    return ok(res, await tally.listTallies(query.cashAccountId, scopeOf(req), query.limit));
  }),
);
