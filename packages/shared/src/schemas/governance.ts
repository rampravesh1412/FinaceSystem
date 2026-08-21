import { z } from "zod";
import { APPROVER_TIER, AUDIT_ACTION } from "../enums.js";
import {
  businessDate,
  dateRange,
  listQuery,
  money,
  nonNegativeMoney,
  objectId,
  optionalObjectId,
  reason as reasonSchema,
} from "./common.js";

/**
 * Governance: approvals (§27), financial periods (§35), audit (§26).
 *
 * These three are the controls that make the ledger trustworthy rather than merely
 * correct. The engine already guarantees that every posting balances; these decide WHO
 * may post, WHEN a posting is still allowed, and leave the permanent record of both.
 */

/* -------------------------------------------------------------------------- */
/* Approval thresholds (§27)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A value band and who must sign it off.
 *
 * The brief's worked example:
 *   ₹0 – ₹50,000        → Branch Admin
 *   ₹50,001 – ₹5,00,000 → Branch Admin
 *   ₹5,00,000+          → Super Admin
 *
 * Configurable, because a threshold that cannot be changed as a business grows gets
 * worked around instead of respected.
 */
export const approvalTierSchema = z.object({
  /** Inclusive floor. The first band starts at 0. */
  from: nonNegativeMoney,
  /** Inclusive ceiling; null on the final, open-ended band. */
  to: money.nullable(),
  tier: z.nativeEnum(APPROVER_TIER),
});
export type ApprovalTier = z.infer<typeof approvalTierSchema>;

export const approvalSettingsSchema = z
  .object({
    /** Off entirely: everything posts immediately. The default for a small operation. */
    enabled: z.boolean().default(false),
    /**
     * Below this, nothing needs approval regardless of the bands. Keeps a day of small
     * cash receipts from filling the queue.
     */
    minimumAmount: nonNegativeMoney.default(0),
    tiers: z.array(approvalTierSchema).default([]),
    /** Transaction types the workflow applies to. Empty means all money movements. */
    appliesTo: z.array(z.string()).default([]),
  })
  .superRefine((v, ctx) => {
    if (!v.enabled || v.tiers.length === 0) return;

    // Bands must ascend and the last must be open-ended, or an amount above the highest
    // ceiling would match no tier and silently skip approval — the exact failure the
    // control exists to prevent.
    let previous = -1;
    v.tiers.forEach((tier, i) => {
      if (tier.from <= previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tiers", i, "from"],
          message: "Each band must start above the one before it",
        });
      }
      if (tier.to !== null && tier.to < tier.from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tiers", i, "to"],
          message: "A band cannot end below where it starts",
        });
      }
      previous = tier.to ?? Number.MAX_SAFE_INTEGER;
    });

    if (v.tiers.at(-1)!.to !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiers"],
        message: "The highest band must be open-ended, or a large amount would need no approval at all",
      });
    }
  });
export type ApprovalSettings = z.infer<typeof approvalSettingsSchema>;

export const approvalDecisionSchema = z.object({
  /** Rejection always needs a reason; approval may carry a comment. */
  comment: z.string().trim().max(1000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const rejectSchema = z.object({ reason: reasonSchema });
export type RejectInput = z.infer<typeof rejectSchema>;

export const approvalQuerySchema = listQuery.extend({
  branchId: optionalObjectId,
  type: z.string().optional(),
  tier: z.nativeEnum(APPROVER_TIER).optional(),
});
export type ApprovalQuery = z.infer<typeof approvalQuerySchema>;

export interface PendingApproval {
  id: string;
  txnNo: string;
  type: string;
  typeLabel: string;
  date: string;
  branch: { id: string; name: string; code: string };
  party: { id: string; name: string } | null;
  accountLabel: string;
  grossAmount: number;
  chargeAmount: number;
  netAmount: number;
  narration?: string;
  /** Which tier must sign this off, from the amount. */
  requiredTier: string;
  /** Whether the caller personally may approve it. */
  canApprove: boolean;
  submittedBy: { id: string; name: string } | null;
  submittedAt: string;
  /** The exact postings that will hit the ledger on approval. */
  lines: Array<{ accountName: string; direction: string; amount: number }>;
  ageHours: number;
}

/* -------------------------------------------------------------------------- */
/* Financial periods (§35)                                                    */
/* -------------------------------------------------------------------------- */

export const createPeriodSchema = z
  .object({
    name: z.string().trim().min(4).max(40),
    startDate: businessDate,
    endDate: businessDate,
  })
  .refine((v) => v.startDate < v.endDate, {
    message: "The period must end after it starts",
    path: ["endDate"],
  });
export type CreatePeriodInput = z.infer<typeof createPeriodSchema>;

/**
 * Closing a period.
 *
 * After closing, nothing can be posted into it — including a reversal. That is the point:
 * once the books are closed and reported on, changing them retrospectively means the
 * figures somebody already acted on no longer reconcile. A correction is posted in the
 * CURRENT period instead, referencing the original.
 *
 * LOCKED goes further: a locked period cannot even be reopened without a super admin.
 */
export const closePeriodSchema = z.object({
  reason: reasonSchema,
  /** LOCKED requires a super admin to undo; CLOSED can be reopened by anyone with the permission. */
  lock: z.boolean().default(false),
});
export type ClosePeriodInput = z.infer<typeof closePeriodSchema>;

export const reopenPeriodSchema = z.object({ reason: reasonSchema });
export type ReopenPeriodInput = z.infer<typeof reopenPeriodSchema>;

export interface FinancialPeriodSummary {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  isCurrent: boolean;
  transactionCount: number;
  closedBy: string | null;
  closedAt: string | null;
  closeReason?: string;
}


/* -------------------------------------------------------------------------- */
/* Audit log (§26)                                                            */
/* -------------------------------------------------------------------------- */

export const auditQuerySchema = listQuery
  .extend({
    action: z.nativeEnum(AUDIT_ACTION).optional(),
    entity: z.string().trim().max(60).optional(),
    entityId: z.string().trim().max(60).optional(),
    userId: optionalObjectId,
    branchId: optionalObjectId,
    /** Only failures — the fast path to "who has been trying to get in". */
    failuresOnly: z.coerce.boolean().optional(),
    minAmount: nonNegativeMoney.optional(),
  })
  .and(dateRange);
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditRow {
  id: string;
  action: string;
  entity: string;
  entityId?: string;
  entityLabel?: string;

  /** Denormalised at write time — an audit row must stay readable after the user is gone. */
  userName: string;
  userEmail?: string;
  roleName?: string;
  branchId?: string;

  changedFields?: string[];
  oldValue?: unknown;
  newValue?: unknown;

  reason?: string;
  amount?: number;
  ip?: string;
  userAgent?: string;
  requestId?: string;

  success: boolean;
  errorCode?: string;
  createdAt: string;
}

export interface AuditSummary {
  total: number;
  failures: number;
  byAction: Array<{ action: string; count: number }>;
  byUser: Array<{ name: string; count: number }>;
}

/** The record timeline (§51) — one entity's history, oldest first. */
export interface TimelineEvent {
  action: string;
  at: string;
  by: string;
  role?: string;
  reason?: string;
  changedFields?: string[];
}

/* -------------------------------------------------------------------------- */
/* Organisation profile (§35)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The organisation's own details.
 *
 * These are not decoration. `fiscalStartMonth` drives voucher numbering, period locking
 * and every year-to-date figure in the system, so changing it after transactions exist
 * would renumber history — the API refuses that, and the UI says why.
 *
 * The rest is provenance: a name and address that appear on every exported report, so a
 * PDF that has left the building still says who produced it.
 */
export const organisationProfileSchema = z.object({
  legalName: z.string().trim().min(2, "The organisation's name is required").max(140),
  displayName: z.string().trim().max(80).optional(),

  addressLine1: z.string().trim().max(140).optional(),
  addressLine2: z.string().trim().max(140).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "An Indian PIN code is six digits")
    .optional()
    .or(z.literal("")),

  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/, "That is not a valid GSTIN")
    .optional()
    .or(z.literal("")),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}\d{4}[A-Z]$/, "That is not a valid PAN")
    .optional()
    .or(z.literal("")),

  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email("That is not a valid email address").optional().or(z.literal("")),

  /**
   * The month the fiscal year starts. 4 = April, the Indian default.
   *
   * Locked once anything has been posted — see the note above.
   */
  fiscalStartMonth: z.coerce.number().int().min(1).max(12).default(4),
});
export type OrganisationProfile = z.infer<typeof organisationProfileSchema>;

/** What the settings screen reads: the profile plus what it is not allowed to change. */
export interface OrganisationSettings {
  profile: OrganisationProfile;
  /**
   * False once a ledger entry exists. Renumbering posted history is not a setting.
   */
  fiscalStartMonthEditable: boolean;
  /** Why it is locked, in words the screen can show without inventing its own. */
  fiscalLockReason?: string;
  updatedAt: string | null;
  updatedBy: string | null;
}
