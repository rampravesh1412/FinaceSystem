import { Types } from "mongoose";
import {
  TRANSACTION_TYPE_LABEL,
  formatINR,
  type ApprovalSettings,
  type ApprovalTier,
  type PendingApproval,
} from "@amiri/shared";
import {
  LedgerAccount,
  SystemSetting,
  Transaction,
  type TransactionDoc,
} from "../../models/index.js";
import { SETTING_KEYS } from "../../models/SystemSetting.js";
import { BadRequestError, ForbiddenError, NotFoundError, StateConflictError } from "../../lib/errors.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import { logger } from "../../config/logger.js";
import * as ledger from "../../services/ledger.service.js";
import * as audit from "../../services/audit.service.js";
import * as notifications from "../notifications/notification.service.js";

/**
 * Approval workflow (§27).
 *
 * THE KEY DESIGN DECISION: a transaction awaiting approval has **no ledger entries at
 * all**. It is stored as a PENDING header carrying the exact posting lines that WILL be
 * written, and nothing touches a balance until somebody approves it.
 *
 * The alternative — post immediately and reverse on rejection — was rejected outright.
 * It would mean an unapproved ₹10,00,000 payment briefly moving a real balance, showing
 * up in the DayBook, and being reversible only by a second entry. Money that nobody
 * authorised must never move, not even for a moment.
 *
 * Because the lines are stored rather than recomputed, the approver signs off exactly
 * what the submitter saw. A charge rule edited between submission and approval cannot
 * silently change the amount being approved.
 */

const DEFAULT_SETTINGS: ApprovalSettings = {
  // OFF by default. A control that appears without being asked for gets worked around;
  // a business turns this on when it wants it.
  enabled: false,
  minimumAmount: 0,
  tiers: [],
  appliesTo: [],
};

/** The example bands from the brief, offered as a starting point in the settings UI. */
export const SUGGESTED_TIERS: ApprovalTier[] = [
  { from: 0, to: 50_000_00, tier: "BRANCH_ADMIN" },
  { from: 50_000_01, to: 5_00_000_00, tier: "BRANCH_ADMIN" },
  { from: 5_00_000_01, to: null, tier: "SUPER_ADMIN" },
];

export async function getSettings(): Promise<ApprovalSettings> {
  const row = await SystemSetting.findOne({ key: SETTING_KEYS.APPROVAL }).lean();
  return (row?.value as ApprovalSettings | undefined) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(
  settings: ApprovalSettings,
  ctx: audit.AuditContext,
): Promise<ApprovalSettings> {
  const previous = await getSettings();

  await SystemSetting.findOneAndUpdate(
    { key: SETTING_KEYS.APPROVAL },
    { $set: { value: settings, description: "Approval thresholds (§27)", updatedBy: ctx.userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await audit.record(ctx, {
    action: "SETTINGS_UPDATED",
    entity: "SystemSetting",
    entityId: SETTING_KEYS.APPROVAL,
    entityLabel: "Approval thresholds",
    oldValue: previous,
    newValue: settings,
  });

  return settings;
}

/**
 * Which tier, if any, must sign off an amount.
 *
 * Returns null when the transaction can post immediately. `Math.abs` because an
 * adjustment may be negative and a ₹10,00,000 correction deserves the same scrutiny as a
 * ₹10,00,000 payment.
 */
export async function requiredTier(
  amount: number,
  transactionType: string,
): Promise<"BRANCH_ADMIN" | "SUPER_ADMIN" | null> {
  const settings = await getSettings();
  if (!settings.enabled || settings.tiers.length === 0) return null;

  if (settings.appliesTo.length > 0 && !settings.appliesTo.includes(transactionType)) return null;

  const magnitude = Math.abs(amount);
  if (magnitude < settings.minimumAmount) return null;

  const band = settings.tiers.find((t) => magnitude >= t.from && (t.to === null || magnitude <= t.to));

  if (!band) {
    // The schema forbids a gap, but a settings row written before that validation existed
    // could still have one. Failing closed is the only safe reading: an amount nobody
    // wrote a rule for is exactly the amount that should be looked at.
    logger.warn({ amount, transactionType }, "no approval band matched — requiring the highest tier");
    return "SUPER_ADMIN";
  }

  return band.tier;
}

/**
 * Hold a transaction for approval instead of posting it.
 *
 * Writes the header with status PENDING and the posting lines stored verbatim. No ledger
 * entries, no balance movement, no voucher number consumed from the type's own sequence —
 * the number is reserved on approval, so a rejected transaction leaves no gap.
 */
export async function submitForApproval(
  input: ledger.PostTransactionInput & { requiredTier: string },
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  // Still validated: an unbalanced posting should be refused at submission, not discovered
  // by whoever approves it.
  ledger.assertBalanced(input.lines);
  await ledger.assertPeriodOpen(input.date);

  const chargeAmount = input.chargeAmount ?? 0;

  return withTransaction(async (session) => {
    const accountIds = [...new Set(input.lines.map((l) => String(l.ledgerAccountId)))];

    const [txn] = await Transaction.create(
      [
        {
          // A provisional number, clearly marked. The real voucher number is issued when
          // the transaction actually posts, so the PAY-IN sequence never contains a
          // rejected entry.
          txnNo: `PENDING-${new Types.ObjectId().toHexString().slice(-10).toUpperCase()}`,
          type: input.type,
          date: input.date,
          status: "PENDING",
          grossAmount: input.grossAmount,
          chargeAmount,
          // Carried from the caller, never recomputed. A charge paid ON TOP of the amount
          // settles at `gross + charge`, and re-deriving it as `gross − charge` here would
          // show the approver a figure that contradicts the very lines they are signing off.
          netAmount: input.netAmount ?? input.grossAmount - chargeAmount,
          paymentMode: input.paymentMode,
          referenceNo: input.referenceNo,
          narration: input.narration,
          partyId: input.partyId ?? null,
          accountIds,
          pendingLines: input.lines.map((l) => ({
            ledgerAccountId: l.ledgerAccountId,
            direction: l.direction,
            amount: l.amount,
            narration: l.narration,
          })),
          approvals: [{ tier: input.requiredTier, status: "PENDING" }],
          fiscalYear: new Date(input.date).getUTCFullYear(),
          createdBy: input.createdBy,
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.details ?? {}),
        },
      ],
      { session },
    );

    if (!txn) throw new Error("Failed to create the pending transaction");

    await audit.record(
      ctx,
      {
        action: "SUBMIT",
        entity: "Transaction",
        entityId: String(txn._id),
        entityLabel: `${TRANSACTION_TYPE_LABEL[input.type]} — ${formatINR(input.grossAmount)}`,
        amount: input.grossAmount,
        newValue: {
          status: "PENDING",
          requiredTier: input.requiredTier,
          gross: input.grossAmount,
          // Recorded so the audit trail shows what was submitted, not merely that
          // something was.
          lines: input.lines.map((l) => ({ direction: l.direction, amount: l.amount })),
        },
      },
      session,
    );

    return txn;
  }, { label: "approval.submit" }).then(async (txn) => {
    // AFTER commit. A notification failure must never roll back a submission, and the
    // recipients should only hear about something that actually happened.
    await notifications.notifyApprovalRequired({
      transactionId: String(txn._id),
      txnNo: txn.txnNo,
      typeLabel: TRANSACTION_TYPE_LABEL[input.type] ?? input.type,
      amount: input.grossAmount,
      submittedBy: ctx.userName,
    });
    return txn;
  });
}

/** May this user act on this tier? */
export function canActOn(tier: string, actor: { isSuperAdmin: boolean; roleName: string }): boolean {
  if (actor.isSuperAdmin) return true;
  // A branch admin can clear their own tier but never the super-admin tier — otherwise
  // the highest band would be decorative.
  return tier === "BRANCH_ADMIN" && actor.roleName === "BRANCH_ADMIN";
}

/**
 * Approve, and post.
 *
 * This is the moment the money actually moves: the stored lines go through the ordinary
 * posting engine, with every guard it applies — balance, funds, period, atomicity. If the
 * source account has been drained since submission, approval fails here rather than
 * overdrawing it, which is correct.
 */
export async function approve(
  transactionId: string,
  actor: { userId: string; isSuperAdmin: boolean; roleName: string },
  comment: string | undefined,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  const pending = await Transaction.findOne({ _id: transactionId }).lean<
    TransactionDoc & { pendingLines?: ledger.PostingLine[] }
  >();

  if (!pending) throw new NotFoundError("Transaction", transactionId);
  if (pending.status !== "PENDING") throw new StateConflictError(pending.status, "APPROVED");

  const tier = pending.approvals?.[0]?.tier ?? "SUPER_ADMIN";
  if (!canActOn(tier, actor)) {
    throw new ForbiddenError(
      `This amount requires ${tier.replace("_", " ").toLowerCase()} approval`,
    );
  }

  /**
   * Nobody approves their own submission.
   *
   * Separation of duties is the entire point of an approval step — a control one person
   * can satisfy alone is not a control. A super admin is not exempt: if they raised it,
   * somebody else signs it.
   */
  if (String(pending.createdBy) === actor.userId) {
    throw new ForbiddenError(
      "You cannot approve a transaction you raised yourself — ask another approver",
    );
  }

  if (!pending.pendingLines?.length) {
    throw new BadRequestError(
      `${pending.txnNo} has no stored postings, so there is nothing to approve. It may have been created before the approval workflow was enabled.`,
    );
  }

  /**
   * Carry the pending header's type-specific fields onto the posting.
   *
   * `pendingLines` holds the ledger effect, but the discriminator fields — which account,
   * which expense head, which transfer endpoints — live on the header itself. Without
   * them the posted document fails its own discriminator validation, so the approver
   * would get a confusing "accountLabel is required" instead of a posted payment.
   */
  const raw = pending as unknown as Record<string, unknown>;
  const BASE_FIELDS = new Set([
    "_id", "__v", "txnNo", "type", "date", "branchId", "status",
    "grossAmount", "chargeAmount", "netAmount", "paymentMode", "referenceNo",
    "narration", "partyId", "accountIds", "attachments", "notes", "approvals",
    "approvedBy", "approvedAt", "postedAt", "periodId", "reversalOf", "reversedBy",
    "reversalReason", "fiscalYear", "createdBy", "updatedBy", "createdAt", "updatedAt",
    "pendingLines", "id",
  ]);

  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!BASE_FIELDS.has(key) && value !== undefined) details[key] = value;
  }

  return withTransaction(async (session) => {
    // Post through the ordinary engine — same guards, same numbering, same audit.
    const posted = await ledger.postTransaction(
      {
        type: pending.type,
        date: pending.date,
        lines: pending.pendingLines!,
        grossAmount: pending.grossAmount,
        chargeAmount: pending.chargeAmount,
        // What was submitted is what posts, down to the settlement figure.
        netAmount: pending.netAmount,
        paymentMode: pending.paymentMode,
        referenceNo: pending.referenceNo,
        narration: pending.narration,
        partyId: pending.partyId,
        createdBy: String(pending.createdBy),
        details,
      },
      session,
      ctx,
    );

    /**
     * The pending header is superseded, not left as a duplicate.
     *
     * It becomes APPROVED and points at the transaction that actually posted, so the
     * submission and its outcome are both on the record and the DayBook shows one entry
     * rather than two.
     */
    await Transaction.updateOne(
      { _id: pending._id },
      {
        $set: {
          status: "APPROVED",
          approvedBy: actor.userId,
          approvedAt: new Date(),
          "approvals.0.status": "APPROVED",
          "approvals.0.actedBy": actor.userId,
          "approvals.0.actedAt": new Date(),
          "approvals.0.comment": comment,
          reversedBy: posted._id,
          pendingLines: [],
        },
      },
      { session },
    );

    await audit.record(
      ctx,
      {
        action: "APPROVE",
        entity: "Transaction",
        entityId: String(pending._id),
        entityLabel: `${posted.txnNo} — ${formatINR(pending.grossAmount)}`,
        amount: pending.grossAmount,
        reason: comment,
        oldValue: { status: "PENDING" },
        newValue: { status: "APPROVED", postedAs: posted.txnNo, approvedBy: ctx.userName },
      },
      session,
    );

    return posted;
  }, { label: "approval.approve" }).then(async (posted) => {
    await notifications.notifyApprovalDecided({
      userId: String(pending.createdBy),
      approved: true,
      txnNo: posted.txnNo,
      amount: pending.grossAmount,
      decidedBy: ctx.userName,
      transactionId: String(posted._id),
    });
    return posted;
  });
}

/**
 * Reject.
 *
 * Nothing is deleted and nothing posts. The submission stays on the record as REJECTED
 * with the reason attached — "why was this refused" has to be answerable later, and a
 * quietly vanished request teaches people to route around the control.
 */
export async function reject(
  transactionId: string,
  actor: { userId: string; isSuperAdmin: boolean; roleName: string },
  reason: string,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  return withTransaction(async (session) => {
    const pending = await Transaction.findOne({ _id: transactionId }).session(session);
    if (!pending) throw new NotFoundError("Transaction", transactionId);
    if (pending.status !== "PENDING") throw new StateConflictError(pending.status, "REJECTED");

    const tier = pending.approvals?.[0]?.tier ?? "SUPER_ADMIN";
    if (!canActOn(tier, actor)) {
      throw new ForbiddenError(`This amount requires ${tier.replace("_", " ").toLowerCase()} approval`);
    }

    pending.status = "REJECTED";
    if (pending.approvals?.[0]) {
      pending.approvals[0].status = "REJECTED";
      pending.approvals[0].actedBy = new Types.ObjectId(actor.userId);
      pending.approvals[0].actedAt = new Date();
      pending.approvals[0].comment = reason;
    }
    await pending.save({ session });

    await audit.record(
      ctx,
      {
        action: "REJECT",
        entity: "Transaction",
        entityId: String(pending._id),
        entityLabel: `${TRANSACTION_TYPE_LABEL[pending.type]} — ${formatINR(pending.grossAmount)}`,
        amount: pending.grossAmount,
        reason,
        oldValue: { status: "PENDING" },
        newValue: { status: "REJECTED", rejectedBy: ctx.userName },
      },
      session,
    );

    return pending;
  }, { label: "approval.reject" }).then(async (rejected) => {
    await notifications.notifyApprovalDecided({
      userId: String(rejected.createdBy),
      approved: false,
      txnNo: rejected.txnNo,
      amount: rejected.grossAmount,
      decidedBy: ctx.userName,
      reason,
      transactionId: String(rejected._id),
    });
    return rejected;
  });
}

/** The approval queue (§27). */
export async function listPending(
  actor: { isSuperAdmin: boolean; roleName: string },
  page: { skip: number; limit: number },
): Promise<{ items: PendingApproval[]; total: number; totalValue: number }> {
  const filter = { status: "PENDING" };

  const [docs, total, valueAgg] = await Promise.all([
    Transaction.find(filter)
      .sort({ createdAt: 1 })
      .skip(page.skip)
      .limit(page.limit)
      .populate<{ partyId: { _id: Types.ObjectId; name: string } | null }>("partyId", "name")
      .populate<{ createdBy: { _id: Types.ObjectId; name: string } | null }>("createdBy", "name")
      .lean(),
    Transaction.countDocuments(filter),
    Transaction.aggregate<{ total: number }>([
      { $match: filter },
      { $group: { _id: null, total: { $sum: "$grossAmount" } } },
    ]),
  ]);

  // Resolve account names once for the whole page rather than per row.
  const accountIds = docs.flatMap((d) =>
    ((d as { pendingLines?: Array<{ ledgerAccountId: Types.ObjectId }> }).pendingLines ?? []).map(
      (l) => l.ledgerAccountId,
    ),
  );
  const accounts = await LedgerAccount.find({ _id: { $in: accountIds } }).select("name").lean();
  const nameById = new Map(accounts.map((a) => [String(a._id), a.name]));

  const now = Date.now();

  return {
    items: docs.map((d) => {
      const raw = d as typeof d & {
        pendingLines?: Array<{ ledgerAccountId: Types.ObjectId; direction: string; amount: number }>;
        accountLabel?: string;
        sourceLabel?: string;
        destinationLabel?: string;
      };
      const tier = d.approvals?.[0]?.tier ?? "SUPER_ADMIN";

      return {
        id: String(d._id),
        txnNo: d.txnNo,
        type: d.type,
        typeLabel: TRANSACTION_TYPE_LABEL[d.type] ?? d.type,
        date: d.date.toISOString(),
        party: d.partyId ? { id: String(d.partyId._id), name: d.partyId.name } : null,
        accountLabel:
          raw.accountLabel ??
          (raw.sourceLabel && raw.destinationLabel
            ? `${raw.sourceLabel} → ${raw.destinationLabel}`
            : "—"),
        grossAmount: d.grossAmount,
        chargeAmount: d.chargeAmount,
        netAmount: d.netAmount,
        narration: d.narration,
        requiredTier: tier,
        // Computed per row so the UI can disable rather than hide — an approver should see
        // that something is waiting even when it is above their tier.
        canApprove: canActOn(tier, actor),
        submittedBy: d.createdBy ? { id: String(d.createdBy._id), name: d.createdBy.name } : null,
        submittedAt: d.createdAt.toISOString(),
        lines: (raw.pendingLines ?? []).map((l) => ({
          accountName: nameById.get(String(l.ledgerAccountId)) ?? "Unknown account",
          direction: l.direction,
          amount: l.amount,
        })),
        ageHours: Math.round((now - d.createdAt.getTime()) / 3_600_000),
      };
    }),
    total,
    totalValue: valueAgg[0]?.total ?? 0,
  };
}
