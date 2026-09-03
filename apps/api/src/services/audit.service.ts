import type { ClientSession } from "mongoose";
import type { Request } from "express";
import type { AuditAction } from "@amiri/shared";
import { AuditLog } from "../models/AuditLog.js";
import { logger } from "../config/logger.js";
import { clientIp } from "../lib/http.js";

/**
 * The audit trail (§26).
 *
 * Two rules govern every call here:
 *
 * 1. When auditing a change to the books, pass the SAME session as the change. The audit
 *    row then commits or rolls back with it — there is no window in which money moved but
 *    the trail does not show it, and no orphan audit row for a transfer that failed.
 *
 * 2. When auditing something outside a transaction (a login, an export), a failure to
 *    write the log must never break the operation. Those calls go through
 *    `recordSafe`, which logs and swallows.
 */

export interface AuditContext {
  userId?: string;
  userName: string;
  userEmail?: string;
  roleName?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditInput {
  action: AuditAction;
  entity: string;
  entityId?: string;
  entityLabel?: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  amount?: number;
  success?: boolean;
  errorCode?: string;
}

/** Build the actor context from an authenticated request. */
export function auditContextFrom(req: Request): AuditContext {
  return {
    userId: req.auth?.userId,
    userName: req.auth?.name ?? "anonymous",
    userEmail: req.auth?.email,
    roleName: req.auth?.roleName,
    ip: clientIp(req),
    userAgent: req.get("user-agent"),
    requestId: req.reqId,
  };
}

const REDACTED = "[redacted]";
const SENSITIVE_PATHS = new Set([
  "password",
  "passwordHash",
  "newPassword",
  "currentPassword",
  "confirmPassword",
  "refreshToken",
  "accessToken",
  "tokenHash",
]);

/**
 * Strip secrets from a value before it is written to the audit trail.
 *
 * An audit log that records "user updated" together with the new password hash has
 * converted the most-read collection in the system into a credential store. Account
 * numbers are kept — the audit trail is exactly where a full account number legitimately
 * belongs, since the point is to prove what was entered.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[too deep]";
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_PATHS.has(k) ? REDACTED : sanitize(v, depth + 1);
  }
  return out;
}

/**
 * The list of paths that actually changed.
 *
 * Storing whole before/after documents makes the audit screen unreadable — every update
 * looks like it touched forty fields. `changedFields` is what the UI renders by default,
 * with the full snapshots available on expand.
 */
function diffKeys(before: unknown, after: unknown): string[] | undefined {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") {
    return undefined;
  }
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];

  for (const k of keys) {
    if (k === "updatedAt" || k === "createdAt" || k === "__v") continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
  }
  return changed.length > 0 ? changed : undefined;
}

/**
 * Write an audit record.
 *
 * Throws if the write fails — intentional when called inside a financial transaction,
 * because a money movement that cannot be audited must not be committed.
 */
export async function record(
  context: AuditContext,
  input: AuditInput,
  session?: ClientSession,
): Promise<void> {
  const oldValue = input.oldValue === undefined ? undefined : sanitize(input.oldValue);
  const newValue = input.newValue === undefined ? undefined : sanitize(input.newValue);

  await AuditLog.create(
    [
      {
        userId: context.userId,
        userName: context.userName,
        userEmail: context.userEmail,
        roleName: context.roleName,

        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        entityLabel: input.entityLabel,

        oldValue,
        newValue,
        changedFields: diffKeys(oldValue, newValue),

        reason: input.reason,
        amount: input.amount,
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,

        success: input.success ?? true,
        errorCode: input.errorCode,
      },
    ],
    session ? { session, ordered: true } : { ordered: true },
  );
}

/**
 * Write an audit record, never throwing.
 *
 * For events outside a financial transaction — sign-in, sign-out, a failed login, an
 * export. A logging outage must not stop a user from signing in.
 */
export async function recordSafe(context: AuditContext, input: AuditInput): Promise<void> {
  try {
    await record(context, input);
  } catch (err) {
    logger.error({ err, action: input.action, entity: input.entity }, "failed to write audit log");
  }
}

/** The timeline for one record, newest first (§51). */
export async function timelineFor(entity: string, entityId: string, limit = 100) {
  return AuditLog.find({ entity, entityId }).sort({ createdAt: -1 }).limit(limit).lean();
}
