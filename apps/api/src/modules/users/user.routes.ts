import { Router } from "express";
import { z } from "zod";
import {
  RECORD_STATUS,
  createUserSchema,
  objectId,
  password,
  reason as reasonSchema,
  updateUserSchema,
  userQuerySchema,
  type CreateUserInput,
  type UpdateUserInput,
  type UserQuery,
} from "@amiri/shared";
import { asyncHandler, created, ok, paginated, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
import { auditContextFrom } from "../../services/audit.service.js";
import * as service from "./user.service.js";

export const userRouter: Router = Router();

userRouter.use(requireAuth);

const idParam = z.object({ id: objectId });
const SORTABLE = ["name", "email", "status", "lastLoginAt", "createdAt"];

const actorOf = (req: { auth?: Express.AuthContext }): service.ActingUser => ({
  userId: req.auth!.userId,
  isSuperAdmin: req.auth!.isSuperAdmin,
});

userRouter.get(
  "/",
  requirePermission("users.view"),
  validate({ query: userQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as UserQuery;
    const page = paging(query, { name: 1 }, SORTABLE);

    const { items, total } = await service.list(
      {
        q: query.q,
        roleId: query.roleId,
        status: query.status,
      },
      page,
    );

    return paginated(res, items, total, page.page, page.limit);
  }),
);

userRouter.get(
  "/:id",
  requirePermission("users.view"),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const user = await service.getById(id);
    return ok(res, user);
  }),
);

userRouter.post(
  "/",
  requirePermission("users.create"),
  mutationLimiter,
  validate({ body: createUserSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateUserInput;
    const user = await service.create(input, actorOf(req), auditContextFrom(req));
    // The list's shape — `id`, `role`, `branches`. Returning the raw document meant the
    // response carried `_id` and no populated refs, so a client that created a user then
    // linked to them had no id to link with.
    return created(res, await service.getSummary(String(user._id)), `${user.name} can now sign in`);
  }),
);

userRouter.patch(
  "/:id",
  requirePermission("users.edit"),
  mutationLimiter,
  validate({ params: idParam, body: updateUserSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const input = req.valid.body as UpdateUserInput;
    const user = await service.update(id, input, actorOf(req), auditContextFrom(req));
    return ok(res, await service.getSummary(String(user._id)), "User updated");
  }),
);

userRouter.post(
  "/:id/status",
  requirePermission("users.disable"),
  mutationLimiter,
  validate({
    params: idParam,
    body: z.object({ status: z.nativeEnum(RECORD_STATUS), reason: reasonSchema }),
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const { status, reason } = req.valid.body as {
      status: "ACTIVE" | "INACTIVE" | "BLOCKED";
      reason: string;
    };
    const user = await service.setStatus(id, status, reason, actorOf(req), auditContextFrom(req));
    return ok(res, await service.getSummary(id), `${user.name} is now ${status.toLowerCase()}`);
  }),
);

/**
 * Administrative password reset.
 *
 * Deliberately its own route with its own permission — bundling a password field into the
 * general user PATCH is a well-worn path to privilege escalation, because "edit user" is
 * a permission far more people hold than "take over an account".
 */
userRouter.post(
  "/:id/reset-password",
  requirePermission("users.resetPassword"),
  mutationLimiter,
  validate({
    params: idParam,
    body: z.object({ newPassword: password, mustChange: z.boolean().default(true) }),
  }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const { newPassword, mustChange } = req.valid.body as {
      newPassword: string;
      mustChange: boolean;
    };
    await service.resetPassword(id, newPassword, mustChange, actorOf(req), auditContextFrom(req));
    return ok(
      res,
      { reset: true },
      "Password reset. The user has been signed out everywhere and must set a new password.",
    );
  }),
);
