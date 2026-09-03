import { Router } from "express";
import { z } from "zod";
import { objectId } from "@amiri/shared";
import { asyncHandler, ok } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { exportLimiter } from "../../middleware/security.js";
import { auditContextFrom } from "../../services/audit.service.js";
import * as importer from "./import.service.js";

export const importRouter: Router = Router();
export const notificationRouter: Router = Router();

importRouter.use(requireAuth);
notificationRouter.use(requireAuth);

/**
 * Import (§52).
 *
 * Two endpoints on purpose. `preview` validates and reports; `commit` writes. There is no
 * single-shot import, because an operator who has not seen the validation errors first has
 * no way to know what a 500-row file is about to do to their party master.
 */
// No `branchId`: the party master is organisation-wide, so an import lands in it whole.
const importBody = z.object({
  // Rows as the client parsed them from the spreadsheet, headers included. Header names
  // are normalised server-side, so "Party Name", "party_name" and "PARTY NAME" all work.
  rows: z.array(z.record(z.unknown())).min(1, "The file has no rows").max(5000, "Import at most 5,000 rows at a time"),
});

importRouter.post(
  "/parties/preview",
  requirePermission("import.run"),
  exportLimiter,
  validate({ body: importBody }),
  asyncHandler(async (req, res) => {
    const { rows } = req.valid.body as z.infer<typeof importBody>;
    // Nothing is written by this call.
    return ok(res, await importer.previewParties(rows));
  }),
);

importRouter.post(
  "/parties/commit",
  requirePermission("import.run"),
  exportLimiter,
  validate({ body: importBody }),
  asyncHandler(async (req, res) => {
    const { rows } = req.valid.body as z.infer<typeof importBody>;
    const result = await importer.commitParties(rows, auditContextFrom(req));

    return ok(
      res,
      result,
      `${result.imported} of ${result.totalRows} rows imported` +
        (result.skipped > 0 ? ` — ${result.skipped} skipped` : ""),
    );
  }),
);

importRouter.get(
  "/parties/template",
  requirePermission("import.run"),
  asyncHandler(async (_req, res) => ok(res, importer.partyTemplate())),
);

/* ── Notifications (§50) ─────────────────────────────────────────────────── */

notificationRouter.get(
  "/",
  validate({ query: z.object({ limit: z.coerce.number().min(1).max(100).default(30) }) }),
  asyncHandler(async (req, res) => {
    const { limit } = req.valid.query as { limit: number };
    const notifications = await import("../notifications/notification.service.js");
    // No permission gate: these are the caller's OWN notifications, addressed to them.
    return ok(res, await notifications.listForUser(req.auth!.userId, limit));
  }),
);

notificationRouter.post(
  "/read",
  validate({ body: z.object({ ids: z.array(objectId).optional() }) }),
  asyncHandler(async (req, res) => {
    const { ids } = req.valid.body as { ids?: string[] };
    const notifications = await import("../notifications/notification.service.js");
    const count = await notifications.markRead(req.auth!.userId, ids);
    return ok(res, { marked: count });
  }),
);
