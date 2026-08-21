import { Router } from "express";
import { organisationProfileSchema, type OrganisationProfile } from "@amiri/shared";
import { asyncHandler, ok } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
import { auditContextFrom } from "../../services/audit.service.js";
import * as settings from "./settings.service.js";

/**
 * Settings (§35).
 *
 * Organisation-wide, so deliberately NOT branch-scoped — there is one organisation. That
 * makes the permission the only control, which is why `settings.manage` is held by
 * SUPER_ADMIN alone and the read is separately gated.
 */
export const settingsRouter: Router = Router();

settingsRouter.use(requireAuth);

settingsRouter.get(
  "/organisation",
  requirePermission("settings.view"),
  asyncHandler(async (_req, res) => ok(res, await settings.getSettings())),
);

settingsRouter.put(
  "/organisation",
  requirePermission("settings.manage"),
  mutationLimiter,
  validate({ body: organisationProfileSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as OrganisationProfile;
    return ok(
      res,
      await settings.saveProfile(input, auditContextFrom(req)),
      "Organisation details saved",
    );
  }),
);

settingsRouter.get(
  "/system",
  requirePermission("settings.view"),
  asyncHandler(async (_req, res) => ok(res, await settings.getSystemSummary())),
);
