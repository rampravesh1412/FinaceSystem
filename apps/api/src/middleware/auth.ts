import type { Request, RequestHandler } from "express";
import { hasPermission, type Permission } from "@amiri/shared";
import {
  ForbiddenError,
  PermissionDeniedError,
  UnauthenticatedError,
} from "../lib/errors.js";
import { verifyAccessToken } from "../services/token.service.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { Role } from "../models/Role.js";

/**
 * The authorization guards (§57).
 *
 *   requireAuth        — establishes who is calling
 *   requirePermission  — establishes what they may do
 *   requireRole        — coarse role check, used sparingly
 *
 * They compose left to right on a route. `requirePermission` assumes `requireAuth` ran
 * first and throws a programmer-facing error if it did not, so a misordered route fails
 * loudly in development rather than silently allowing traffic.
 *
 * There is no branch guard. The business is one set of books: every account, party and
 * report belongs to the organisation, and what a user may do is decided entirely by the
 * permissions on their role.
 */

/**
 * Resolve the caller from the bearer token.
 *
 * The token is verified by signature first (cheap, no I/O), then the user and role are
 * loaded from the database on every request. That second step is deliberate and worth its
 * cost: a permission or role change, or a disabled account, must take effect immediately.
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

    const user = await User.findById(claims.sub).select("name email status roleId").lean();

    if (!user) throw new UnauthenticatedError("Your account no longer exists");
    if (user.status !== "ACTIVE") {
      throw new ForbiddenError("Your account has been disabled", "ACCOUNT_DISABLED");
    }

    const role = await Role.findById(user.roleId).select("name permissions isSuperAdmin").lean();
    if (!role) throw new ForbiddenError("Your role no longer exists — contact an administrator");

    req.auth = {
      userId: String(user._id),
      objectId: user._id,
      name: user.name,
      email: user.email,
      roleId: String(role._id),
      roleName: role.name,
      permissions: role.permissions,
      isSuperAdmin: role.isSuperAdmin === true,
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
 * instance "only a super admin may grant the super-admin flag". Everything else should
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

