import { z } from "zod";
import { email, objectId } from "./common.js";

/**
 * Password policy.
 *
 * Length is the dominant factor, so the floor is 10 rather than the customary 8, with a
 * light character-class requirement to stop "1234567890". Deliberately no maximum below
 * 128 and no forced rotation — both push users toward weaker, reused secrets.
 */
export const password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((v) => /[a-z]/.test(v), "Include at least one lowercase letter")
  .refine((v) => /[A-Z]/.test(v), "Include at least one uppercase letter")
  .refine((v) => /\d/.test(v), "Include at least one number");

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
  /** Optional: pre-select a branch at login when the user is assigned to several. */
  branchId: objectId.optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "The passwords do not match",
    path: ["confirmPassword"],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: "The new password must be different from the current one",
    path: ["newPassword"],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const resetPasswordSchema = z
  .object({
    userId: objectId,
    newPassword: password,
    confirmPassword: z.string(),
    /** Force the user to set their own password at next login. Default true. */
    mustChange: z.boolean().default(true),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "The passwords do not match",
    path: ["confirmPassword"],
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Switch the active branch for a multi-branch user without re-authenticating.
 *
 * `null` means "no single branch in context" — the all-branches view. Only an unscoped
 * user may select it; the server rejects it for everyone else rather than quietly
 * substituting their assignment list, so the client can never widen its own scope.
 */
export const switchBranchSchema = z.object({ branchId: objectId.nullable() });
export type SwitchBranchInput = z.infer<typeof switchBranchSchema>;

/* -------------------------------------------------------------------------- */
/* Session payloads                                                           */
/* -------------------------------------------------------------------------- */

/** The authenticated principal, as the client sees it. Never contains secrets. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: { id: string; name: string; label: string };
  permissions: string[];
  /** Branches this user may read. Empty for a SuperAdmin, who is unscoped. */
  branchIds: string[];
  branches: Array<{ id: string; name: string; code: string }>;
  /** The branch currently in context; drives default filters across the UI. */
  activeBranchId: string | null;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  avatarUrl?: string;
}

export interface LoginResponse {
  user: SessionUser;
  accessToken: string;
  /** Seconds until the access token expires; the client refreshes just before. */
  expiresIn: number;
}

/** Claims carried in the signed access token. Kept small — it travels on every request. */
export interface AccessTokenClaims {
  sub: string;
  role: string;
  branchIds: string[];
  isSuperAdmin: boolean;
  /** Session id, so a single session can be revoked without invalidating the user. */
  sid: string;
  iat: number;
  exp: number;
}
