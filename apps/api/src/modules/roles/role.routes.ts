import { Router } from "express";
import { z } from "zod";
import {
  createRoleSchema,
  describePermission,
  expandLegacy,
  groupModules,
  hasPermission,
  objectId,
  type Permission,
  updateRoleSchema,
  type CreateRoleInput,
  type UpdateRoleInput,
} from "@amiri/shared";
import { asyncHandler, created, ok } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
import { ConflictError, ForbiddenError, NotFoundError, translateDuplicate } from "../../lib/errors.js";
import { Role, User } from "../../models/index.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import { revokeAllSessions } from "../../services/token.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Roles and permissions (§5).
 *
 * This is what makes the permission system configurable rather than hard-coded: a
 * SuperAdmin edits the permission array on a role and every guard in the API changes
 * behaviour immediately, with no deploy.
 */
export const roleRouter: Router = Router();

roleRouter.use(requireAuth);

const idParam = z.object({ id: objectId });

/**
 * Normalise a grant list before it is stored.
 *
 * Two jobs. It rewrites any legacy string into the keys it stands for, so pressing Save on
 * a role written under the old vocabulary CLEANS it rather than storing the old strings
 * back; and it refuses a grant the actor does not themselves hold, which is the escalation
 * a role editor otherwise offers for free — anyone with `roles.edit` could mint a role
 * with every permission and assign it to themselves.
 *
 * A super admin is exempt from the second rule: they hold everything by definition, and it
 * is their job to hand out what they are not personally using.
 */
function normaliseGrants(
  requested: readonly string[],
  actor: { permissions: string[]; isSuperAdmin: boolean },
): string[] {
  const expanded = expandLegacy(requested);
  if (actor.isSuperAdmin) return expanded;

  const beyond = expanded.filter((p) => !hasPermission(actor.permissions, p as Permission));
  if (beyond.length > 0) {
    throw new ForbiddenError(
      `You cannot grant a permission you do not hold yourself: ${beyond
        .map((p) => describePermission(p))
        .join(", ")}`,
    );
  }
  return expanded;
}

/**
 * The permission catalogue, grouped, for the role matrix.
 *
 * Hidden modules are included: `adjustments` has no sidebar entry but is very much
 * something a role is granted, and leaving it out of the matrix is how a permission
 * becomes ungrantable in practice while still being enforced.
 */
roleRouter.get(
  "/catalogue",
  requirePermission("roles.view"),
  asyncHandler(async (_req, res) => ok(res, groupModules({ includeHidden: true }))),
);

roleRouter.get(
  "/",
  requirePermission("roles.view"),
  asyncHandler(async (_req, res) => {
    const roles = await Role.find().sort({ isSystem: -1, name: 1 }).lean();

    const counts = await User.aggregate<{ _id: unknown; count: number }>([
      { $match: { status: "ACTIVE" } },
      { $group: { _id: "$roleId", count: { $sum: 1 } } },
    ]);
    const byRole = new Map(counts.map((c) => [String(c._id), c.count]));

    return ok(
      res,
      roles.map((r) => ({
        id: String(r._id),
        name: r.name,
        label: r.label,
        description: r.description,
        permissions: r.permissions,
        isSuperAdmin: r.isSuperAdmin,
        isSystem: r.isSystem,
        userCount: byRole.get(String(r._id)) ?? 0,
      })),
    );
  }),
);

roleRouter.post(
  "/",
  requirePermission("roles.create"),
  mutationLimiter,
  validate({ body: createRoleSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateRoleInput;

    /**
     * Only an unscoped user may create an unscoped role.
     *
     * Without this check, anyone holding `roles.manage` could create a role with
     * `isSuperAdmin: true`, assign it to themselves, and become a SuperAdmin. This is the
     * single most important escalation guard in the system.
     */
    if (input.isSuperAdmin && !req.auth!.isSuperAdmin) {
      throw new ForbiddenError("Only a super admin can create another super-admin role");
    }

    try {
      const role = await Role.create({
        ...input,
        permissions: normaliseGrants(input.permissions ?? [], req.auth!),
        isSystem: false,
        createdBy: req.auth!.userId,
      });

      await audit.record(audit.auditContextFrom(req), {
        action: "CREATE",
        entity: "Role",
        entityId: String(role._id),
        entityLabel: role.name,
        newValue: { name: role.name, permissions: role.permissions, isSuperAdmin: role.isSuperAdmin },
      });

      return created(res, role, `Role ${role.label} created`);
    } catch (err) {
      const duplicate = translateDuplicate(err, "role");
      if (duplicate) throw duplicate;
      throw err;
    }
  }),
);

roleRouter.patch(
  "/:id",
  requirePermission("roles.edit"),
  mutationLimiter,
  validate({ params: idParam, body: updateRoleSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const input = req.valid.body as UpdateRoleInput;

    if (input.isSuperAdmin !== undefined && !req.auth!.isSuperAdmin) {
      throw new ForbiddenError("Only a super admin can grant or revoke super-admin access");
    }

    const role = await withTransaction(async (session) => {
      const doc = await Role.findById(id).session(session);
      if (!doc) throw new NotFoundError("Role", id);

      /**
       * The SuperAdmin role's own permissions cannot be reduced.
       *
       * Removing `roles.manage` from it — by accident or malice — would leave the system
       * with nobody able to grant it back, requiring direct database surgery to recover.
       */
      if (doc.isSystem && doc.isSuperAdmin && input.permissions) {
        throw new ConflictError(
          "The super admin role's permissions cannot be edited — it must retain full access",
        );
      }

      const before = { permissions: doc.permissions, label: doc.label, isSuperAdmin: doc.isSuperAdmin };
      Object.assign(doc, input, { updatedBy: req.auth!.userId });
      // Whether or not this edit touched them, what gets stored is the current vocabulary.
      doc.permissions = input.permissions
        ? normaliseGrants(input.permissions, req.auth!)
        : expandLegacy(doc.permissions);
      await doc.save({ session });

      await audit.record(
        audit.auditContextFrom(req),
        {
          action: "PERMISSION_CHANGE",
          entity: "Role",
          entityId: id,
          entityLabel: doc.name,
          oldValue: before,
          newValue: { permissions: doc.permissions, label: doc.label, isSuperAdmin: doc.isSuperAdmin },
        },
        session,
      );

      return doc;
    }, { label: "role.update" });

    // Everyone holding this role is signed out, so nobody keeps working with a stale
    // permission set cached in a live session.
    if (input.permissions || input.isSuperAdmin !== undefined) {
      const holders = await User.find({ roleId: id }).select("_id").lean();
      await Promise.all(holders.map((u) => revokeAllSessions(String(u._id), "ROLE_PERMISSIONS_CHANGED")));
    }

    return ok(res, role, "Role updated");
  }),
);

roleRouter.delete(
  "/:id",
  requirePermission("roles.delete"),
  mutationLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const role = await Role.findById(id);
    if (!role) throw new NotFoundError("Role", id);

    if (role.isSystem) throw new ConflictError("A system role cannot be deleted");

    // Deleting a role out from under its holders would leave users unable to authenticate
    // at all, since `requireAuth` resolves permissions through the role.
    const holders = await User.countDocuments({ roleId: id });
    if (holders > 0) {
      throw new ConflictError(
        `${holders} user${holders === 1 ? " is" : "s are"} still assigned to this role. Move them to another role first.`,
      );
    }

    await role.deleteOne();

    await audit.record(audit.auditContextFrom(req), {
      action: "DELETE",
      entity: "Role",
      entityId: id,
      entityLabel: role.name,
      oldValue: { name: role.name, permissions: role.permissions },
    });

    return ok(res, { deleted: true }, `Role ${role.label} deleted`);
  }),
);
