import crypto from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { Response } from "express";
import type { AccessTokenClaims } from "@amiri/shared";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { Session } from "../models/Session.js";
import { UnauthenticatedError } from "../lib/errors.js";
import type { UserDoc } from "../models/User.js";

/**
 * Token issuance and verification.
 *
 * Two-token design:
 *
 *   ACCESS  — short-lived (15 min) JWT, sent in the Authorization header, never stored by
 *             the browser anywhere persistent. Stateless: verified by signature alone, so
 *             the hot path costs no database round-trip.
 *   REFRESH — long-lived (7 days) opaque random token in an httpOnly, SameSite=Strict
 *             cookie. Stateful: hashed and stored, so it can be revoked, and rotated on
 *             every use so a stolen token is usable at most once before detection.
 *
 * The access token is short-lived precisely because it cannot be revoked. Fifteen minutes
 * is the blast radius of a compromised one.
 */

export const REFRESH_COOKIE = "amiri_rt";

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

function accessTtlSeconds(): number {
  const m = /^(\d+)([smhd])$/.exec(env.JWT_ACCESS_TTL);
  if (!m) return 900;
  const n = Number(m[1]);
  const unit = m[2];
  return unit === "s" ? n : unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
}

function signAccessToken(user: UserDoc, isSuperAdmin: boolean, sessionId: string): string {
  const payload = {
    sub: String(user._id),
    role: String(user.roleId),
    isSuperAdmin,
    sid: sessionId,
  };

  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"],
    issuer: "amiri-finance",
    audience: "amiri-web",
  };

  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: "amiri-finance",
      audience: "amiri-web",
    }) as AccessTokenClaims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // A distinct code so the client knows to attempt a silent refresh rather than
      // bouncing the user to the login screen.
      throw new UnauthenticatedError("Your session has expired", "TOKEN_EXPIRED");
    }
    throw new UnauthenticatedError("Invalid authentication token", "TOKEN_INVALID");
  }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Issue a fresh token pair and persist the session row. */
export async function issueTokens(
  user: UserDoc,
  isSuperAdmin: boolean,
  context: { ip?: string; userAgent?: string; familyId?: string },
): Promise<IssuedTokens> {
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const familyId = context.familyId ?? crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_HOURS * 3_600_000);

  const session = await Session.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt,
    ip: context.ip,
    userAgent: context.userAgent?.slice(0, 400),
  });

  return {
    accessToken: signAccessToken(user, isSuperAdmin, String(session._id)),
    refreshToken,
    expiresIn: accessTtlSeconds(),
    sessionId: String(session._id),
  };
}

export interface RotationResult {
  userId: string;
  familyId: string;
  previousSessionId: string;
}

/**
 * Validate a refresh token and mark it consumed.
 *
 * Implements refresh-token rotation with reuse detection. Each token may be redeemed
 * exactly once. If a token that has already been rotated out is presented again, the only
 * two explanations are a stolen token or a badly-behaved client — and since we cannot
 * tell which, the entire family is revoked, forcing a real re-authentication. That turns
 * token theft from silent indefinite access into, at worst, one extra login prompt.
 */
export async function rotateRefreshToken(token: string): Promise<RotationResult> {
  const tokenHash = hashToken(token);
  const session = await Session.findOne({ tokenHash });

  if (!session) throw new UnauthenticatedError("Your session is no longer valid");

  if (session.revokedAt) {
    logger.warn(
      { userId: String(session.userId), familyId: session.familyId },
      "refresh token reuse detected — revoking the whole session family",
    );
    await Session.updateMany(
      { familyId: session.familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: "TOKEN_REUSE_DETECTED" } },
    );
    throw new UnauthenticatedError("Your session was ended for security reasons");
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw new UnauthenticatedError("Your session has expired");
  }

  session.revokedAt = new Date();
  session.revokedReason = "ROTATED";
  await session.save();

  return {
    userId: String(session.userId),
    familyId: session.familyId,
    previousSessionId: String(session._id),
  };
}

export async function revokeSession(sessionId: string, reason = "LOGOUT"): Promise<void> {
  await Session.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

/** Sign every device out. Used on password change and on role/permission change. */
export async function revokeAllSessions(userId: string, reason: string): Promise<number> {
  const res = await Session.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
}

/* ── Cookie handling ─────────────────────────────────────────────────────── */

/**
 * The refresh cookie.
 *
 *   httpOnly           — JavaScript cannot read it, so an XSS bug cannot exfiltrate it.
 *   sameSite: "strict" — it is never sent on a cross-site request, which is CSRF
 *                        protection for the refresh endpoint without a token dance.
 *   path               — scoped to the auth routes so it is not attached to every API
 *                        call, reducing the number of places it can leak.
 */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "strict",
    path: `${env.API_PREFIX}/auth`,
    maxAge: env.JWT_REFRESH_TTL_HOURS * 3_600_000,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "strict",
    path: `${env.API_PREFIX}/auth`,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}
