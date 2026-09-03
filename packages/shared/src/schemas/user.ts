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

    designation: z.string().trim().max(80).optional(),
    status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
    mustChangePassword: z.boolean().default(true),
  });
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
  designation: z.string().trim().max(80).optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const userQuerySchema = listQuery.extend({
  roleId: objectId.optional(),
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
   * Marks a role as a super admin: it may act on any approval tier and administer roles
   * and users. Gated so only an existing super admin can grant it — see the role service.
   */
  isSuperAdmin: z.boolean().default(false),
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
  isSuperAdmin: boolean;
  /** System roles cannot be deleted or renamed; their permissions remain editable. */
  isSystem: boolean;
  userCount: number;
}
