import { Router, type Request } from "express";
import {
  changePasswordSchema,
  loginSchema,
  type ChangePasswordInput,
  type LoginInput,
} from "@amiri/shared";
import { asyncHandler, clientIp, ok } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth } from "../../middleware/auth.js";
import { loginLimiter } from "../../middleware/security.js";
import { UnauthenticatedError } from "../../lib/errors.js";
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  setRefreshCookie,
} from "../../services/token.service.js";
import * as service from "./auth.service.js";

/**
 * Auth routes.
 *
 * Controllers stay thin by design (§58): translate HTTP to a service call, set the
 * cookie, shape the response. No business logic lives in this file.
 */
export const authRouter: Router = Router();

const contextOf = (req: Request): service.RequestContext => ({
  ip: clientIp(req),
  userAgent: req.get("user-agent"),
  requestId: req.reqId,
});

authRouter.post(
  "/login",
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as LoginInput;
    const result = await service.login(input, contextOf(req));

    // The refresh token goes ONLY into an httpOnly cookie. It is never in the JSON body,
    // so no client-side code path can read it and no logger can capture it.
    setRefreshCookie(res, result.refreshToken);

    return ok(res, {
      user: result.user,
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    });
  }),
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw new UnauthenticatedError("Sign in to continue");

    try {
      const result = await service.refresh(token, contextOf(req));
      setRefreshCookie(res, result.refreshToken);
      return ok(res, {
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      });
    } catch (err) {
      // A dead refresh token must not linger in the browser — otherwise every subsequent
      // page load retries it and gets the same failure.
      clearRefreshCookie(res);
      throw err;
    }
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    // Deliberately not behind `requireAuth`: signing out must work even when the access
    // token has already expired, which is the common case for a user returning to a tab.
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (token) {
      try {
        const rotation = await import("../../services/token.service.js").then((m) =>
          m.rotateRefreshToken(token),
        );
        await service.logout(rotation.previousSessionId, contextOf(req));
      } catch {
        // An invalid or already-consumed token still results in a successful sign-out.
      }
    }
    clearRefreshCookie(res);
    return ok(res, { signedOut: true }, "Signed out");
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { User } = await import("../../models/index.js");
    const user = await User.findById(req.auth!.userId).select(
      "name email status roleId mustChangePassword lastLoginAt avatarUrl",
    );
    if (!user) throw new UnauthenticatedError("Your account no longer exists");
    return ok(res, await service.buildSessionUser(user));
  }),
);

authRouter.post(
  "/change-password",
  requireAuth,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as ChangePasswordInput;
    await service.changePassword(req.auth!.userId, input, contextOf(req));
    clearRefreshCookie(res);
    return ok(
      res,
      { passwordChanged: true },
      "Password updated. Please sign in again on all your devices.",
    );
  }),
);

