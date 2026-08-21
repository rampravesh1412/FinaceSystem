import { Router } from "express";
import { z } from "zod";
import {
  branchQuerySchema,
  createBranchSchema,
  objectId,
  reason as reasonSchema,
  updateBranchSchema,
  RECORD_STATUS,
  type BranchQuery,
  type CreateBranchInput,
  type UpdateBranchInput,
} from "@amiri/shared";
import { asyncHandler, created, ok, paginated, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth, requireBranchAccess, requirePermission } from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
import { auditContextFrom } from "../../services/audit.service.js";
import * as service from "./branch.service.js";

export const branchRouter: Router = Router();

branchRouter.use(requireAuth);

const idParam = z.object({ id: objectId });
const SORTABLE = ["name", "code", "city", "status", "createdAt", "updatedAt"];

/**
 * List branches.
 *
 * `requireBranchAccess({ optional: true })` because a newly created user with no branch
 * assignment must still be able to load this endpoint and see an empty list, rather than
 * hitting a 403 that looks like a broken application.
 */
branchRouter.get(
  "/",
  requirePermission("branches.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: branchQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as BranchQuery;
    const page = paging(query, { code: 1 }, SORTABLE);

    const { items, total } = await service.list(
      {
        q: query.q,
        status: query.status,
        // A scoped user may only list the branches they hold. `req.scope.branchIds` is
        // derived from their user record on the server; nothing here comes from the client.
        scopeIds: req.scope!.isUnscoped ? null : req.scope!.branchIds,
      },
      page,
    );

    return paginated(res, items, total, page.page, page.limit);
  }),
);

branchRouter.get(
  "/:id",
  requirePermission("branches.view"),
  requireBranchAccess({ optional: true }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const branch = await service.getById(id, req.scope!.isUnscoped ? null : req.scope!.branchIds);
    return ok(res, branch);
  }),
);

branchRouter.post(
  "/",
  requirePermission("branches.create"),
  mutationLimiter,
  validate({ body: createBranchSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateBranchInput;
    const branch = await service.create(input, auditContextFrom(req));
    return created(res, branch, `Branch ${branch.code} created`);
  }),
);

branchRouter.patch(
  "/:id",
  requirePermission("branches.edit"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ params: idParam, body: updateBranchSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    // A scoped editor cannot reach outside their own branches, even by id.
    if (!req.scope!.isUnscoped) {
      const { assertBranchInScope } = await import("../../middleware/auth.js");
      assertBranchInScope(req, id);
    }
    const input = req.valid.body as UpdateBranchInput;
    const branch = await service.update(id, input, auditContextFrom(req));
    return ok(res, branch, "Branch updated");
  }),
);

/**
 * Change branch status. There is no DELETE route for a branch, deliberately — see the
 * note on `setStatus` in the service.
 */
branchRouter.post(
  "/:id/status",
  requirePermission("branches.disable"),
  mutationLimiter,
  validate({
    params: idParam,
    body: z.object({
      status: z.nativeEnum(RECORD_STATUS),
      // Required and at least 10 characters — this is a dangerous action (§65) and the
      // reason goes verbatim into the audit trail.
      reason: reasonSchema,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const { status, reason } = req.valid.body as { status: "ACTIVE" | "INACTIVE" | "BLOCKED"; reason: string };
    const branch = await service.setStatus(id, status, reason, auditContextFrom(req));
    return ok(res, branch, `Branch ${branch.code} is now ${status.toLowerCase()}`);
  }),
);
