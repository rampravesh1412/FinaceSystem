import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import {
  approvalQuerySchema,
  approvalSettingsSchema,
  auditQuerySchema,
  closePeriodSchema,
  createPeriodSchema,
  objectId,
  rejectSchema,
  reopenPeriodSchema,
  type ApprovalQuery,
  type ApprovalSettings,
  type AuditQuery,
  type ClosePeriodInput,
  type CreatePeriodInput,
} from "@amiri/shared";
import { asyncHandler, created, escapeRegex, ok, paginated, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import {
  requireAuth,
  requirePermission,
  requireResolvedPermission,
  requireSuperAdmin,
} from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
import { AuditLog, FinancialPeriod, Transaction } from "../../models/index.js";
import { ConflictError, NotFoundError, translateDuplicate } from "../../lib/errors.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as audit from "../../services/audit.service.js";
import * as approvals from "./approval.service.js";
import { transactionPermission } from "../transactions/transaction-permissions.js";

export const approvalRouter: Router = Router();
export const periodRouter: Router = Router();
export const auditRouter: Router = Router();

for (const r of [approvalRouter, periodRouter, auditRouter]) r.use(requireAuth);

const idParam = z.object({ id: objectId });

const actorOf = (req: { auth?: Express.AuthContext }) => ({
  userId: req.auth!.userId,
  isSuperAdmin: req.auth!.isSuperAdmin,
  roleName: req.auth!.roleName,
});

/* ── Approvals (§27) ─────────────────────────────────────────────────────── */

approvalRouter.get(
  "/",
  requirePermission("approvals.view"),
  validate({ query: approvalQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as ApprovalQuery;
    const page = paging(query, { createdAt: 1 });

    const { items, total, totalValue } = await approvals.listPending(
      actorOf(req),
      { skip: page.skip, limit: page.limit },
    );

    return paginated(res, items, total, page.page, page.limit, { totalValue });
  }),
);

approvalRouter.get(
  "/settings",
  requirePermission("approvals.view"),
  asyncHandler(async (_req, res) =>
    ok(res, { settings: await approvals.getSettings(), suggestedTiers: approvals.SUGGESTED_TIERS }),
  ),
);

approvalRouter.put(
  "/settings",
  // Changing who must approve what is itself a privileged act — restricted to a super
  // admin, or a branch admin could lower the threshold above their own signing limit.
  requireSuperAdmin,
  mutationLimiter,
  validate({ body: approvalSettingsSchema }),
  asyncHandler(async (req, res) => {
    const settings = req.valid.body as ApprovalSettings;
    return ok(res, await approvals.saveSettings(settings, audit.auditContextFrom(req)), "Thresholds updated");
  }),
);

/**
 * Approving is TWO permissions, not one.
 *
 * `approvals.approve` says a person may work this queue at all; the module's own
 * `approve` says they may sign off that kind of thing. Requiring only the first is what
 * the system did before, and it is why `payment_out.approve`, `settlements.approve` and
 * every other per-module approve key sat on the Roles screen doing nothing — one grant
 * silently approved payments, expenses, settlements and adjustments alike.
 *
 * Splitting them is the difference between "may clear the queue" and "may release a
 * payment", which on a finance desk are routinely different people.
 */
approvalRouter.post(
  "/:id/approve",
  requirePermission("approvals.approve"),
  requireResolvedPermission((req) => transactionPermission(String(req.params.id), "approve")),
  mutationLimiter,
  validate({ params: idParam, body: z.object({ comment: z.string().trim().max(1000).optional() }) }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const { comment } = req.valid.body as { comment?: string };

    const posted = await approvals.approve(
      id,
      actorOf(req),
      comment,
      audit.auditContextFrom(req),
    );

    return ok(res, posted, `Approved and posted as ${posted.txnNo}`);
  }),
);

/** Rejecting is gated the same way as approving — see the note above. */
approvalRouter.post(
  "/:id/reject",
  requirePermission("approvals.reject"),
  requireResolvedPermission((req) => transactionPermission(String(req.params.id), "reject")),
  mutationLimiter,
  validate({ params: idParam, body: rejectSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const { reason } = req.valid.body as { reason: string };

    const txn = await approvals.reject(id, actorOf(req), reason, audit.auditContextFrom(req));
    return ok(res, txn, "Rejected — nothing was posted");
  }),
);

/* ── Financial periods (§35) ─────────────────────────────────────────────── */

periodRouter.get(
  "/",
  requirePermission("periods.view"),
  asyncHandler(async (_req, res) => {
    const periods = await FinancialPeriod.find()
      .sort({ startDate: -1 })
      .populate<{ closedBy: { name: string } | null }>("closedBy", "name")
      .lean();

    const now = new Date();
    const counts = await Transaction.aggregate<{ _id: Types.ObjectId | null; n: number }>([
      { $group: { _id: "$periodId", n: { $sum: 1 } } },
    ]);
    const countById = new Map(counts.map((c) => [String(c._id), c.n]));

    return ok(
      res,
      periods.map((p) => ({
        id: String(p._id),
        name: p.name,
        startDate: p.startDate.toISOString(),
        endDate: p.endDate.toISOString(),
        status: p.status,
        isCurrent: p.startDate <= now && p.endDate >= now,
        transactionCount: countById.get(String(p._id)) ?? 0,
        closedBy: p.closedBy?.name ?? null,
        closedAt: p.closedAt ? p.closedAt.toISOString() : null,
        closeReason: p.closeReason,
      })),
    );
  }),
);

periodRouter.post(
  "/",
  requirePermission("periods.create"),
  mutationLimiter,
  validate({ body: createPeriodSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreatePeriodInput;

    // Overlapping periods would make "which period is this date in" ambiguous, and the
    // posting guard resolves exactly one.
    const overlap = await FinancialPeriod.findOne({
      startDate: { $lte: input.endDate },
      endDate: { $gte: input.startDate },
    }).lean();

    if (overlap) {
      throw new ConflictError(
        `That range overlaps ${overlap.name}. Periods must not overlap, or a transaction's period would be ambiguous.`,
      );
    }

    try {
      const period = await FinancialPeriod.create({ ...input, createdBy: req.auth!.userId });
      await audit.record(audit.auditContextFrom(req), {
        action: "CREATE",
        entity: "FinancialPeriod",
        entityId: String(period._id),
        entityLabel: period.name,
        newValue: { name: period.name, startDate: period.startDate, endDate: period.endDate },
      });
      return created(res, period, `${period.name} opened`);
    } catch (err) {
      const duplicate = translateDuplicate(err, "period");
      if (duplicate) throw duplicate;
      throw err;
    }
  }),
);

/**
 * Close a period.
 *
 * After this, nothing posts into the range — payments, adjustments and reversals alike.
 * That is the point of closing: numbers somebody has already reported on must not move
 * underneath them. A correction goes into the CURRENT period referencing the original.
 */
periodRouter.post(
  "/:id/close",
  requirePermission("periods.edit"),
  mutationLimiter,
  validate({ params: idParam, body: closePeriodSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const { reason, lock } = req.valid.body as ClosePeriodInput;

    const period = await withTransaction(async (session) => {
      const doc = await FinancialPeriod.findById(id).session(session);
      if (!doc) throw new NotFoundError("Financial period", id);
      if (doc.status !== "OPEN") throw new ConflictError(`${doc.name} is already ${doc.status.toLowerCase()}`);

      // Nothing pending may be left behind: an approval that lands after closing would
      // try to post into a closed period and simply fail, stranding the request.
      const pending = await Transaction.countDocuments({
        status: "PENDING",
        date: { $gte: doc.startDate, $lte: doc.endDate },
      }).session(session);

      if (pending > 0) {
        throw new ConflictError(
          `${pending} transaction${pending === 1 ? " is" : "s are"} still awaiting approval in this period. Clear the queue before closing.`,
        );
      }

      doc.status = lock ? "LOCKED" : "CLOSED";
      doc.closedBy = new Types.ObjectId(req.auth!.userId);
      doc.closedAt = new Date();
      doc.closeReason = reason;
      await doc.save({ session });

      await audit.record(
        audit.auditContextFrom(req),
        {
          action: "PERIOD_CLOSED",
          entity: "FinancialPeriod",
          entityId: id,
          entityLabel: doc.name,
          reason,
          oldValue: { status: "OPEN" },
          newValue: { status: doc.status },
        },
        session,
      );

      return doc;
    }, { label: "period.close" });

    return ok(
      res,
      period,
      `${period.name} is ${lock ? "locked" : "closed"} — nothing further can be posted into it`,
    );
  }),
);

periodRouter.post(
  "/:id/reopen",
  requirePermission("periods.edit"),
  mutationLimiter,
  validate({ params: idParam, body: reopenPeriodSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const { reason } = req.valid.body as { reason: string };

    const period = await FinancialPeriod.findById(id);
    if (!period) throw new NotFoundError("Financial period", id);
    if (period.status === "OPEN") throw new ConflictError(`${period.name} is already open`);

    // A LOCKED period is for a year already filed with an authority. Reopening it is a
    // super-admin decision, not a routine one.
    if (period.status === "LOCKED" && !req.auth!.isSuperAdmin) {
      throw new ConflictError(
        `${period.name} is locked. Only a super admin can reopen a locked period.`,
      );
    }

    period.status = "OPEN";
    period.reopenedBy = new Types.ObjectId(req.auth!.userId);
    period.reopenedAt = new Date();
    await period.save();

    await audit.record(audit.auditContextFrom(req), {
      action: "PERIOD_REOPENED",
      entity: "FinancialPeriod",
      entityId: id,
      entityLabel: period.name,
      reason,
      newValue: { status: "OPEN", reopenedBy: req.auth!.name },
    });

    return ok(res, period, `${period.name} reopened`);
  }),
);

/* ── Audit log (§26) ─────────────────────────────────────────────────────── */

/**
 * The audit log endpoint.
 *
 * Read-only by construction — there is no POST, PATCH or DELETE here and never will be.
 * The model refuses mutation, and this router offers no route that would attempt one.
 */
auditRouter.get(
  "/",
  requirePermission("audit.view"),
  validate({ query: auditQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as AuditQuery;
    const page = paging(query, { createdAt: -1 }, ["createdAt", "action", "amount"]);

    const filter: Record<string, unknown> = {};

    if (query.action) filter.action = query.action;
    if (query.entity) filter.entity = query.entity;
    if (query.entityId) filter.entityId = query.entityId;
    if (query.userId) filter.userId = new Types.ObjectId(query.userId);
    if (query.failuresOnly) filter.success = false;
    if (query.minAmount !== undefined) filter.amount = { $gte: query.minAmount };

    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: new Date(query.to.getTime() + 86_399_999) } : {}),
      };
    }

    if (query.q?.trim()) {
      const rx = new RegExp(escapeRegex(query.q.trim()), "i");
      const search = [{ userName: rx }, { entityLabel: rx }, { reason: rx }, { entity: rx }];
      filter.$and = filter.$or ? [{ $or: filter.$or }, { $or: search }] : [{ $or: search }];
      delete filter.$or;
    }

    const [rows, total, byAction, failures] = await Promise.all([
      AuditLog.find(filter).sort(page.sort).skip(page.skip).limit(page.limit).lean(),
      AuditLog.countDocuments(filter),
      AuditLog.aggregate<{ _id: string; count: number }>([
        { $match: filter },
        { $group: { _id: "$action", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      AuditLog.countDocuments({ ...filter, success: false }),
    ]);

    return paginated(
      res,
      rows.map((r) => ({
        id: String(r._id),
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        entityLabel: r.entityLabel,
        userName: r.userName,
        userEmail: r.userEmail,
        roleName: r.roleName,
        changedFields: r.changedFields,
        oldValue: r.oldValue,
        newValue: r.newValue,
        reason: r.reason,
        amount: r.amount,
        ip: r.ip,
        userAgent: r.userAgent,
        requestId: r.requestId,
        success: r.success,
        errorCode: r.errorCode,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page.page,
      page.limit,
      {
        failures,
        byAction: byAction.map((a) => ({ action: a._id, count: a.count })),
      },
    );
  }),
);

/** One record's history, oldest first (§51). */
auditRouter.get(
  "/timeline/:entity/:entityId",
  requirePermission("audit.view"),
  validate({ params: z.object({ entity: z.string().trim().max(60), entityId: z.string().trim().max(60) }) }),
  asyncHandler(async (req, res) => {
    const { entity, entityId } = req.valid.params as { entity: string; entityId: string };
    const rows = await AuditLog.find({ entity, entityId }).sort({ createdAt: 1 }).lean();

    return ok(
      res,
      rows.map((r) => ({
        action: r.action,
        at: r.createdAt.toISOString(),
        by: r.userName,
        role: r.roleName,
        reason: r.reason,
        changedFields: r.changedFields,
      })),
    );
  }),
);
