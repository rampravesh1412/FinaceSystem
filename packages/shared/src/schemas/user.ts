import { z } from "zod";
import { RECORD_STATUS } from "../enums.js";
import { ALL_PERMISSIONS } from "../permissions.js";
import { email, listQuery, objectId, optionalIndianMobile } from "./common.js";
import { password } from "./auth.js";

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2, "Name is required").max(120),
    email,
    phone: optionalIndianMobile,
    password,
    roleId: objectId,

    /**
     * Branch assignment.
     *
     * A user may hold several branches (a regional manager over 105 and 107). The
     * authorization layer turns this into `{ branchId: { $in: branchIds } }` on every
     * query. A non-SuperAdmin with an empty list can see nothing at all, which is the
     * correct fail-closed default.
     */
    branchIds: z.array(objectId).default([]),
    defaultBranchId: objectId.optional(),

    designation: z.string().trim().max(80).optional(),
    status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
    mustChangePassword: z.boolean().default(true),
  })
  .refine(
    (v) => !v.defaultBranchId || v.branchIds.includes(v.defaultBranchId),
    { message: "The default branch must be one of the assigned branches", path: ["defaultBranchId"] },
  );
export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * Update never carries a password — that is a separate, separately-permissioned,
 * separately-audited operation (`users.resetPassword`). Bundling it into a general
 * profile PATCH is how privilege escalation gets in.
 */
export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: email.optional(),
  phone: optionalIndianMobile,
  roleId: objectId.optional(),
  branchIds: z.array(objectId).optional(),
  defaultBranchId: objectId.nullable().optional(),
  designation: z.string().trim().max(80).optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const userQuerySchema = listQuery.extend({
  roleId: objectId.optional(),
  branchId: objectId.optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
});
export type UserQuery = z.infer<typeof userQuerySchema>;

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  phone?: string;
  designation?: string;
  role: { id: string; name: string; label: string };
  branches: Array<{ id: string; name: string; code: string }>;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                      */
/* -------------------------------------------------------------------------- */

const permissionEnum = z.enum(ALL_PERMISSIONS as [string, ...string[]]);

export const createRoleSchema = z.object({
  name: z
    .string()
    .trim()
    .toUpperCase()
    .min(3)
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use uppercase letters, digits and underscores"),
  label: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(permissionEnum).default([]),
  /**
   * Unscoped roles see every branch. Reserved for SuperAdmin-equivalents and gated so
   * only an existing unscoped user can grant it — see the role service.
   */
  isUnscoped: z.boolean().default(false),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = createRoleSchema.omit({ name: true }).partial();
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export interface RoleSummary {
  id: string;
  name: string;
  label: string;
  description?: string;
  permissions: string[];
  isUnscoped: boolean;
  /** System roles cannot be deleted or renamed; their permissions remain editable. */
  isSystem: boolean;
  userCount: number;
}
