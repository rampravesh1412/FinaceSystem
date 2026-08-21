import { Types } from "mongoose";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hasPermission, type Permission } from "@amiri/shared";
import {
  BranchAccessDeniedError,
  ForbiddenError,
  PermissionDeniedError,
  UnauthenticatedError,
} from "../lib/errors.js";
import { verifyAccessToken } from "../services/token.service.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { Role } from "../models/Role.js";

/**
 * The four authorization guards (§57).
 *
 *   requireAuth          — establishes who is calling
 *   requirePermission    — establishes what they may do
 *   requireBranchAccess  — establishes what they may see
 *   requireRole          — coarse role check, used sparingly
 *
 * They compose left to right on a route. `requirePermission` and `requireBranchAccess`
 * both assume `requireAuth` ran first and throw a programmer-facing error if it did not,
 * so a misordered route fails loudly in development rather than silently allowing traffic.
 */

/**
 * Resolve the caller from the bearer token.
 *
 * The token is verified by signature first (cheap, no I/O), then the user and role are
 * loaded from the database on every request. That second step is deliberate and worth its
 * cost: permissions, branch assignments and account status must take effect immediately.
 * A user whose access is revoked at 10:00 should not keep working until their token
 * expires at 10:14 — in a financial system that window is unacceptable.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.get("authorization");
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthenticatedError("Sign in to continue");
    }

    const claims = verifyAccessToken(header.slice(7).trim());

    // The session must still be live. This is what makes "sign out everywhere" and
    // reuse-detection revocation actually terminate access.
    const session = await Session.findById(claims.sid).select("revokedAt expiresAt").lean();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthenticatedError("Your session is no longer valid");
    }

    const user = await User.findById(claims.sub)
      .select("name email status roleId branchIds defaultBranchId")
      .lean();

    if (!user) throw new UnauthenticatedError("Your account no longer exists");
    if (user.status !== "ACTIVE") {
      throw new ForbiddenError("Your account has been disabled", "ACCOUNT_DISABLED");
    }

    const role = await Role.findById(user.roleId).select("name permissions isUnscoped").lean();
    if (!role) throw new ForbiddenError("Your role no longer exists — contact an administrator");

    req.auth = {
      userId: String(user._id),
      objectId: user._id,
      name: user.name,
      email: user.email,
      roleId: String(role._id),
      roleName: role.name,
      permissions: role.permissions,
      branchIds: (user.branchIds ?? []).map(String),
      isSuperAdmin: role.isUnscoped === true,
      sessionId: claims.sid,
    };

    next();
  } catch (err) {
    next(err);
  }
};

function assertAuth(req: Request): Express.AuthContext {
  if (!req.auth) {
    throw new Error(
      "Route misconfiguration: requireAuth must run before this guard. " +
        "Check the middleware order on this route.",
    );
  }
  return req.auth;
}

/**
 * Require one permission.
 *
 * This is the real gate. Roles are data; this string is the contract, and it is the same
 * string the web app checks to decide whether to render the button.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    try {
      const auth = assertAuth(req);
      if (!hasPermission(auth.permissions, permission)) {
        throw new PermissionDeniedError(permission);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Require any one of several permissions — for a screen reachable by more than one route. */
export function requireAnyPermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    try {
      const auth = assertAuth(req);
      if (!permissions.some((p) => hasPermission(auth.permissions, p))) {
        throw new PermissionDeniedError(permissions.join(" or "));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Coarse role check.
 *
 * Used only where the concept genuinely is the role rather than a capability — for
 * instance "only an unscoped user may grant the unscoped flag". Everything else should
 * use `requirePermission`, so that permissions stay configurable.
 */
export function requireRole(...roleNames: string[]): RequestHandler {
  return (req, _res, next) => {
    try {
      const auth = assertAuth(req);
      if (!roleNames.includes(auth.roleName)) {
        throw new ForbiddenError("Your role does not allow this action");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  try {
    const auth = assertAuth(req);
    if (!auth.isSuperAdmin) throw new ForbiddenError("This action is restricted to super admins");
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Build `req.scope` — the branch filter every scoped query must carry.
 *
 * THIS IS THE BRANCH ISOLATION BOUNDARY (§3, §57).
 *
 * A SuperAdmin gets `{}` and sees everything. Everyone else gets
 * `{ branchId: { $in: assignedBranches } }`, derived from the database record, not from
 * anything the client sent. If the request names a branch (`?branchId=`), it may only
 * NARROW the scope — a branch the user does not hold is refused with 403 rather than
 * silently ignored, because silently ignoring it would let a probing client distinguish
 * "no data" from "not allowed" and map the branch structure.
 */
export function requireBranchAccess(options: { optional?: boolean } = {}): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = assertAuth(req);

      const requested =
        (req.query.branchId as string | undefined) ??
        (req.body as { branchId?: string } | undefined)?.branchId;

      const requestedId =
        requested && requested !== "all" && Types.ObjectId.isValid(requested)
          ? new Types.ObjectId(requested)
          : null;

      if (auth.isSuperAdmin) {
        req.scope = {
          filter: requestedId ? { branchId: requestedId } : {},
          branchIds: [],
          isUnscoped: true,
          activeBranchId: requestedId,
        };
        next();
        return;
      }

      const allowed = auth.branchIds.map((id) => new Types.ObjectId(id));

      if (allowed.length === 0 && !options.optional) {
        throw new ForbiddenError(
          "You are not assigned to any branch yet — ask an administrator to assign one",
          "BRANCH_ACCESS_DENIED",
        );
      }

      if (requestedId) {
        const permitted = allowed.some((id) => id.equals(requestedId));
        if (!permitted) throw new BranchAccessDeniedError();

        req.scope = {
          filter: { branchId: requestedId },
          branchIds: allowed,
          isUnscoped: false,
          activeBranchId: requestedId,
        };
        next();
        return;
      }

      req.scope = {
        filter: { branchId: { $in: allowed } },
        branchIds: allowed,
        isUnscoped: false,
        activeBranchId: allowed.length === 1 ? allowed[0]! : null,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Assert that a specific branch id is within the caller's scope.
 *
 * For write paths, where the branch arrives in the body and the record is about to be
 * created under it. `requireBranchAccess` covers reads; this covers "you may not create a
 * payment in branch 107 when you are assigned to 105".
 */
export function assertBranchInScope(req: Request, branchId: Types.ObjectId | string): void {
  const scope = req.scope;
  if (!scope) {
    throw new Error("Route misconfiguration: requireBranchAccess must run before this check.");
  }
  if (scope.isUnscoped) return;

  const target = typeof branchId === "string" ? new Types.ObjectId(branchId) : branchId;
  if (!scope.branchIds.some((id) => id.equals(target))) {
    throw new BranchAccessDeniedError();
  }
}

/** The scope filter, or a hard failure if the route forgot to establish one. */
export function scopeOf(req: Request): Record<string, unknown> {
  if (!req.scope) {
    throw new Error(
      "Route misconfiguration: a branch-scoped query ran without requireBranchAccess. " +
        "Every query over branch-owned data must carry req.scope.filter.",
    );
  }
  return req.scope.filter;
}
