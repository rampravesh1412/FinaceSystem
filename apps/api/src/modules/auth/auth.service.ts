import { Types } from "mongoose";
import type { LoginResponse, SessionUser } from "@amiri/shared";
import { Branch, Role, User, type UserDoc } from "../../models/index.js";
import {
  AccountLockedError,
  ForbiddenError,
  InvalidCredentialsError,
  NotFoundError,
  UnauthenticatedError,
} from "../../lib/errors.js";
import {
  issueTokens,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  type IssuedTokens,
} from "../../services/token.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Authentication.
 *
 * Everything a controller needs is here; the controller only translates HTTP to these
 * calls and sets the cookie.
 */

export interface RequestContext {
  ip: string;
  userAgent?: string;
  requestId: string;
}

/** Build the client-facing session object. Never includes a hash, a token, or a lock counter. */
export async function buildSessionUser(
  user: UserDoc | (UserDoc & { _id: Types.ObjectId }),
  activeBranchId?: string | null,
): Promise<SessionUser> {
  const role = await Role.findById(user.roleId).select("name label permissions isUnscoped").lean();
  if (!role) throw new ForbiddenError("Your role no longer exists — contact an administrator");

  const isSuperAdmin = role.isUnscoped === true;

  // A SuperAdmin is unscoped, so their branch picker lists every active branch rather
  // than an assignment list they do not have.
  const branchFilter = isSuperAdmin
    ? { status: "ACTIVE" }
    : { _id: { $in: user.branchIds ?? [] } };

  const branches = await Branch.find(branchFilter).select("name code").sort({ code: 1 }).lean();

  /**
   * `undefined` and `null` mean different things here, and the distinction matters.
   *
   * `undefined` is "the caller did not say" — a fresh sign-in or a `/auth/me`. `null` is an
   * explicit choice of the all-branches view, and must survive: collapsing it into the
   * default with `??` would bounce a SuperAdmin straight back to a single branch on the
   * next request, which is exactly the bug that makes an "All branches" option feel broken.
   *
   * With nothing specified, a SuperAdmin lands on the all-branches view. Their authority is
   * unscoped, so opening on one branch understates what they are looking at — a total that
   * reads as "the business" when it is one office. The exception is a single-branch install,
   * where "all" and "101" describe the same books: there the picker collapses to a static
   * label with nothing to switch to, so defaulting to null would leave every write form
   * asking for a branch that cannot be chosen.
   */
  const active =
    activeBranchId !== undefined
      ? activeBranchId
      : isSuperAdmin && branches.length > 1
        ? null
        : (user.defaultBranchId ? String(user.defaultBranchId) : null) ??
          (branches.length === 1 ? String(branches[0]!._id) : null);

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: { id: String(role._id), name: role.name, label: role.label },
    permissions: role.permissions,
    branchIds: (user.branchIds ?? []).map(String),
    branches: branches.map((b) => ({ id: String(b._id), name: b.name, code: b.code })),
    activeBranchId: active,
    isSuperAdmin,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

export interface LoginResult extends LoginResponse {
  refreshToken: string;
}

export async function login(
  input: { email: string; password: string; branchId?: string },
  ctx: RequestContext,
): Promise<LoginResult> {
  // `+passwordHash` because the field is `select: false` on the schema.
  const user = await User.findOne({ email: input.email.toLowerCase() }).select(
    "+passwordHash name email status roleId branchIds defaultBranchId mustChangePassword lastLoginAt avatarUrl failedLoginAttempts lockedUntil",
  );

  const failureContext = {
    userName: input.email,
    userEmail: input.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };

  if (!user) {
    // Still audited: repeated failures against a non-existent address are exactly the
    // signal that someone is enumerating accounts.
    await audit.recordSafe(failureContext, {
      action: "LOGIN_FAILURE",
      entity: "User",
      success: false,
      errorCode: "NO_SUCH_USER",
    });
    throw new InvalidCredentialsError();
  }

  if (user.isLocked()) {
    await audit.recordSafe(
      { ...failureContext, userId: String(user._id), userName: user.name },
      { action: "LOGIN_FAILURE", entity: "User", entityId: String(user._id), success: false, errorCode: "ACCOUNT_LOCKED" },
    );
    throw new AccountLockedError(user.lockedUntil!);
  }

  const passwordOk = await user.verifyPassword(input.password);

  if (!passwordOk) {
    const lockedUntil = await user.registerFailedLogin();
    await audit.recordSafe(
      { ...failureContext, userId: String(user._id), userName: user.name },
      {
        action: lockedUntil ? "ACCOUNT_LOCKED" : "LOGIN_FAILURE",
        entity: "User",
        entityId: String(user._id),
        success: false,
        errorCode: "BAD_PASSWORD",
      },
    );
    if (lockedUntil) throw new AccountLockedError(lockedUntil);
    throw new InvalidCredentialsError();
  }

  if (user.status !== "ACTIVE") {
    await audit.recordSafe(
      { ...failureContext, userId: String(user._id), userName: user.name },
      { action: "LOGIN_FAILURE", entity: "User", entityId: String(user._id), success: false, errorCode: "ACCOUNT_DISABLED" },
    );
    throw new ForbiddenError("Your account has been disabled", "ACCOUNT_DISABLED");
  }

  // `undefined`, not `null`: a login that names no branch wants the user's saved default,
  // not the all-branches view.
  const sessionUser = await buildSessionUser(user, input.branchId ?? undefined);

  // A branch named at login must be one the user actually holds.
  if (input.branchId && !sessionUser.isSuperAdmin && !sessionUser.branchIds.includes(input.branchId)) {
    throw new ForbiddenError("You are not assigned to that branch", "BRANCH_ACCESS_DENIED");
  }

  const tokens = await issueTokens(user, sessionUser.isSuperAdmin, {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  await user.registerSuccessfulLogin(ctx.ip);

  await audit.recordSafe(
    {
      userId: String(user._id),
      userName: user.name,
      userEmail: user.email,
      roleName: sessionUser.role.name,
      branchId: sessionUser.activeBranchId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    },
    { action: "LOGIN", entity: "User", entityId: String(user._id), entityLabel: user.name },
  );

  return {
    user: { ...sessionUser, lastLoginAt: sessionUser.lastLoginAt },
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  };
}

/**
 * Exchange a refresh token for a new pair.
 *
 * The old token is consumed by `rotateRefreshToken` before anything else happens, so a
 * replay of it will be caught by reuse detection even if this call later fails.
 */
export async function refresh(token: string, ctx: RequestContext): Promise<LoginResult> {
  const rotation = await rotateRefreshToken(token);

  const user = await User.findById(rotation.userId).select(
    "name email status roleId branchIds defaultBranchId mustChangePassword lastLoginAt avatarUrl",
  );
  if (!user) throw new UnauthenticatedError("Your account no longer exists");
  if (user.status !== "ACTIVE") {
    throw new ForbiddenError("Your account has been disabled", "ACCOUNT_DISABLED");
  }

  const sessionUser = await buildSessionUser(user);

  const tokens: IssuedTokens = await issueTokens(user, sessionUser.isSuperAdmin, {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    // The new token stays in the same family, so reuse detection can revoke the whole
    // chain if an older link is ever replayed.
    familyId: rotation.familyId,
  });

  return {
    user: sessionUser,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  };
}

export async function logout(sessionId: string | undefined, ctx: RequestContext, actor?: {
  userId: string;
  userName: string;
  roleName?: string;
}): Promise<void> {
  if (sessionId) await revokeSession(sessionId, "LOGOUT");
  if (actor) {
    await audit.recordSafe(
      {
        userId: actor.userId,
        userName: actor.userName,
        roleName: actor.roleName,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
      { action: "LOGOUT", entity: "User", entityId: actor.userId },
    );
  }
}

export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
  ctx: RequestContext,
): Promise<void> {
  const user = await User.findById(userId).select("+passwordHash name email roleId");
  if (!user) throw new NotFoundError("User", userId);

  const ok = await user.verifyPassword(input.currentPassword);
  if (!ok) throw new InvalidCredentialsError();

  await user.setPassword(input.newPassword);
  user.mustChangePassword = false;
  await user.save();

  /**
   * Every session is revoked on a password change, including the one making the request.
   *
   * If a password is being changed because it may have been compromised, leaving other
   * sessions alive defeats the point — the attacker keeps their refresh token. The client
   * handles the resulting 401 by sending the user back to sign in.
   */
  await revokeAllSessions(userId, "PASSWORD_CHANGED");

  const role = await Role.findById(user.roleId).select("name").lean();
  await audit.recordSafe(
    {
      userId,
      userName: user.name,
      userEmail: user.email,
      roleName: role?.name,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    },
    { action: "PASSWORD_CHANGE", entity: "User", entityId: userId, entityLabel: user.name },
  );
}

/** Change the branch in context for a multi-branch user. */
export async function switchBranch(
  userId: string,
  branchId: string | null,
  isSuperAdmin: boolean,
): Promise<SessionUser> {
  const user = await User.findById(userId).select(
    "name email status roleId branchIds defaultBranchId mustChangePassword lastLoginAt avatarUrl",
  );
  if (!user) throw new UnauthenticatedError("Your account no longer exists");

  /**
   * The all-branches view.
   *
   * Refused for a scoped user rather than downgraded to their assignment list. Their
   * queries are already filtered to `{ branchId: { $in: assigned } }` by
   * `requireBranchAccess`, so clearing the context would not actually leak anything — but
   * a request to leave scope should fail loudly, not appear to succeed with a quietly
   * different meaning than the caller asked for.
   */
  if (branchId === null) {
    if (!isSuperAdmin) {
      throw new ForbiddenError(
        "Only an unscoped role may view all branches at once",
        "BRANCH_ACCESS_DENIED",
      );
    }
    return buildSessionUser(user, null);
  }

  if (!isSuperAdmin && !user.branchIds.some((id) => String(id) === branchId)) {
    throw new ForbiddenError("You are not assigned to that branch", "BRANCH_ACCESS_DENIED");
  }

  const branch = await Branch.findById(branchId).select("status").lean();
  if (!branch) throw new NotFoundError("Branch", branchId);
  if (branch.status !== "ACTIVE") throw new ForbiddenError("That branch is not active");

  return buildSessionUser(user, branchId);
}
