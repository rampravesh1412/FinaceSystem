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
  requireAuth,
  requirePermission,
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

/* ── Dashboards (§31, §32, §33) ──────────────────────────────────────────── */

dashboardRouter.get(
  "/",
  validate({ query: z.object({ days: z.coerce.number().min(7).max(90).default(30) }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { days: number };

    return ok(
      res,
      await dashboard.buildDashboard({
        trendDays: query.days,
      }),
    );
  }),
);

/* ── Profit & Loss (§34) ─────────────────────────────────────────────────── */

reportRouter.get(
  "/profit-loss",
  requirePermission("reports.pnl"),
  validate({ query: reportRangeSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as ReportRange;
    return ok(
      res,
      await reports.profitAndLoss({
        from: query.from,
        to: query.to,
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
  validate({ query: reportRangeSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as ReportRange;
    return ok(
      res,
      await reports.monthlyHistory({
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
  validate({ query: asOfSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as AsOfQuery;
    return ok(
      res,
      await reports.balanceSheet({
        asOf: query.asOf ?? new Date(),
      }),
    );
  }),
);

/* ── Cash flow ───────────────────────────────────────────────────────────── */

reportRouter.get(
  "/cash-flow",
  requirePermission("reports.view"),
  validate({ query: reportRangeSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as ReportRange;
    return ok(
      res,
      await reports.cashFlow({
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
