import { Types, type FilterQuery } from "mongoose";
import type { CreateUserInput, UpdateUserInput } from "@amiri/shared";
import { Role, User, type UserDoc } from "../../models/index.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  translateDuplicate,
} from "../../lib/errors.js";
import { escapeRegex, type Paging } from "../../lib/http.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import { revokeAllSessions } from "../../services/token.service.js";
import * as audit from "../../services/audit.service.js";

export interface ActingUser {
  userId: string;
  isSuperAdmin: boolean;
}

/**
 * Privilege-escalation guard.
 *
 * An admin managing staff must not hand out access they do not themselves hold: only a
 * super admin may assign a role marked `isSuperAdmin`. Enforced here rather than in a
 * controller, so every path that assigns a role goes through it.
 */
async function assertMayAssign(
  actor: { isSuperAdmin: boolean },
  roleId: string | undefined,
): Promise<void> {
  if (!roleId || actor.isSuperAdmin) return;

  const role = await Role.findById(roleId).select("isSuperAdmin name").lean();
  if (!role) throw new NotFoundError("Role", roleId);
  if (role.isSuperAdmin) {
    throw new ForbiddenError("You cannot assign a role with super-admin access");
  }
}

export interface UserListFilters {
  q?: string;
  roleId?: string;
  status?: string;
}

export async function list(filters: UserListFilters, page: Paging) {
  const filter: FilterQuery<UserDoc> = {};

  if (filters.status) filter.status = filters.status;
  if (filters.roleId) filter.roleId = filters.roleId;

  if (filters.q?.trim()) {
    const rx = new RegExp(escapeRegex(filters.q.trim()), "i");
    filter.$or = [{ name: rx }, { email: rx }, { designation: rx }];
  }

  const [docs, total] = await Promise.all([
    User.find(filter)
      .sort(page.sort)
      .skip(page.skip)
      .limit(page.limit)
      .populate<{ roleId: { _id: Types.ObjectId; name: string; label: string } }>(
        "roleId",
        "name label",
      )
      .lean(),
    User.countDocuments(filter),
  ]);

  return { items: docs.map(toUserSummary), total };
}

/**
 * The populated document shape both the list query and `getById` produce.
 *
 * Named so the mapper below has one input type rather than being written twice — the
 * create route returned the raw document for a while, which meant its response carried
 * `_id` instead of `id` and no `role` or `branches` at all. Any client that created a user
 * and then rendered them got `undefined` where the id should be.
 */
type PopulatedUser = {
  _id: unknown;
  name: string;
  email: string;
  phone?: string;
  designation?: string;
  roleId?: { _id: unknown; name: string; label: string } | null;
  status: string;
  mustChangePassword?: boolean;
  lastLoginAt?: Date | null;
  createdAt: Date;
};

function toUserSummary(u: PopulatedUser) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    phone: u.phone,
    designation: u.designation,
    role: u.roleId
      ? { id: String(u.roleId._id), name: u.roleId.name, label: u.roleId.label }
      : null,
    status: u.status,
    mustChangePassword: Boolean(u.mustChangePassword),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

/** One user in the SAME shape the list returns — used by create, update and status. */
export async function getSummary(id: string) {
  const user = await User.findById(id)
    .populate("roleId", "name label")
    .lean();

  if (!user) throw new NotFoundError("User", id);
  return toUserSummary(user as never);
}

export async function getById(id: string) {
  const filter: FilterQuery<UserDoc> = { _id: id };

  const user = await User.findOne(filter)
    .populate("roleId", "name label permissions")
    .lean();

  if (!user) throw new NotFoundError("User", id);
  return user;
}

export async function create(
  input: CreateUserInput,
  actor: ActingUser,
  ctx: audit.AuditContext,
): Promise<UserDoc> {
  await assertMayAssign(actor, input.roleId);

  const role = await Role.findById(input.roleId).select("name").lean();
  if (!role) throw new NotFoundError("Role", input.roleId);

  return withTransaction(async (session) => {
    try {
      const passwordHash = await User.hashPassword(input.password);

      const [user] = await User.create(
        [
          {
            name: input.name,
            email: input.email,
            phone: input.phone,
            passwordHash,
            roleId: input.roleId,
            designation: input.designation,
            status: input.status,
            mustChangePassword: input.mustChangePassword,
            createdBy: ctx.userId,
          },
        ],
        { session },
      );

      if (!user) throw new Error("User creation returned no document");

      await audit.record(
        ctx,
        {
          action: "CREATE",
          entity: "User",
          entityId: String(user._id),
          entityLabel: user.name,
          // `sanitize()` in the audit service strips the hash; the role assignment is the
          // part that matters for an access review.
          newValue: {
            name: user.name,
            email: user.email,
            role: role.name,
            status: user.status,
          },
        },
        session,
      );

      return user;
    } catch (err) {
      const duplicate = translateDuplicate(err, "user");
      if (duplicate) throw duplicate;
      throw err;
    }
  }, { label: "user.create" });
}

export async function update(
  id: string,
  input: UpdateUserInput,
  actor: ActingUser,
  ctx: audit.AuditContext,
): Promise<UserDoc> {
  await assertMayAssign(actor, input.roleId);

  return withTransaction(async (session) => {
    const user = await User.findById(id).session(session);
    if (!user) throw new NotFoundError("User", id);

    const before = {
      name: user.name,
      email: user.email,
      roleId: String(user.roleId),
      status: user.status,
      designation: user.designation,
    };

    const roleChanged = input.roleId !== undefined && input.roleId !== String(user.roleId);

    Object.assign(user, input, { updatedBy: ctx.userId });
    await user.save({ session });

    const after = {
      name: user.name,
      email: user.email,
      roleId: String(user.roleId),
      status: user.status,
      designation: user.designation,
    };

    await audit.record(
      ctx,
      {
        action: roleChanged ? "ROLE_CHANGE" : "UPDATE",
        entity: "User",
        entityId: id,
        entityLabel: user.name,
        oldValue: before,
        newValue: after,
      },
      session,
    );

    return { user, roleChanged };
  }, { label: "user.update" }).then(async ({ user, roleChanged }) => {
    /**
     * A change of role revokes every session for that user.
     *
     * `requireAuth` re-reads permissions on each request, so a revoked permission takes
     * effect immediately anyway — but forcing a fresh sign-in also refreshes the branch
     * ids baked into their access token and makes the change unambiguous in the audit
     * trail. Done after commit so a failed revocation cannot roll back the update.
     */
    if (roleChanged) {
      await revokeAllSessions(id, roleChanged ? "ROLE_CHANGED" : "BRANCHES_CHANGED");
    }
    return user;
  });
}

export async function setStatus(
  id: string,
  status: "ACTIVE" | "INACTIVE" | "BLOCKED",
  reason: string,
  actor: ActingUser,
  ctx: audit.AuditContext,
): Promise<UserDoc> {
  if (id === actor.userId) {
    throw new ConflictError("You cannot change the status of your own account");
  }

  const user = await withTransaction(async (session) => {
    const doc = await User.findById(id).session(session);
    if (!doc) throw new NotFoundError("User", id);
    if (doc.status === status) {
      throw new ConflictError(`That user is already ${status.toLowerCase()}`);
    }

    const before = doc.status;
    doc.status = status;
    doc.updatedBy = ctx.userId ? new Types.ObjectId(ctx.userId) : undefined;
    await doc.save({ session });

    await audit.record(
      ctx,
      {
        action: "UPDATE",
        entity: "User",
        entityId: id,
        entityLabel: doc.name,
        oldValue: { status: before },
        newValue: { status },
        reason,
      },
      session,
    );

    return doc;
  }, { label: "user.setStatus" });

  if (status !== "ACTIVE") await revokeAllSessions(id, `STATUS_${status}`);
  return user;
}

/**
 * Administrative password reset.
 *
 * Separate from `update` and separately permissioned. `mustChangePassword` is forced on
 * so the administrator's chosen password is a one-time value they cannot keep using to
 * impersonate the user.
 */
export async function resetPassword(
  id: string,
  newPassword: string,
  mustChange: boolean,
  actor: ActingUser,
  ctx: audit.AuditContext,
): Promise<void> {
  const user = await User.findById(id).select("+passwordHash name email");
  if (!user) throw new NotFoundError("User", id);

  await user.setPassword(newPassword);
  user.mustChangePassword = mustChange;
  await user.save();

  await revokeAllSessions(id, "PASSWORD_RESET_BY_ADMIN");

  await audit.record(ctx, {
    action: "PASSWORD_RESET",
    entity: "User",
    entityId: id,
    entityLabel: user.name,
    reason: `Password reset by ${ctx.userName}`,
  });
}
