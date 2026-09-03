import { Types } from "mongoose";
import { formatINR, type NotificationType, type Severity } from "@amiri/shared";
import { Notification, Role, User } from "../../models/index.js";
import { logger } from "../../config/logger.js";

/**
 * Notifications (§50).
 *
 * Every send is BEST-EFFORT and never throws into a caller. A notification is a courtesy
 * that points at something that already happened; a failure to deliver one must not roll
 * back the payment that triggered it. That is why nothing here takes a session — it runs
 * after commit, deliberately outside the financial transaction.
 */

export interface NotifyInput {
  type: NotificationType;
  severity?: Severity;
  title: string;
  body?: string;
  link?: string;
  amount?: number;
  entity?: string;
  entityId?: string;
}

/** Send to specific users. */
export async function notify(userIds: string[], input: NotifyInput): Promise<void> {
  if (userIds.length === 0) return;

  try {
    await Notification.insertMany(
      userIds.map((userId) => ({
        userId: new Types.ObjectId(userId),
        type: input.type,
        severity: input.severity ?? "INFO",
        title: input.title,
        body: input.body,
        link: input.link,
        amount: input.amount,
        entity: input.entity,
        entityId: input.entityId,
      })),
      { ordered: false },
    );
  } catch (err) {
    // Logged, never rethrown — see the note at the top of this file.
    logger.error({ err, type: input.type }, "failed to send notifications");
  }
}

/**
 * Send to everyone holding a permission.
 *
 * Resolves role membership at SEND time and writes one row per user. Storing "notify
 * whoever can approve" and resolving it at read time would silently re-target the message
 * whenever somebody changed role, so a message about last week's payment could surface
 * for a person who had nothing to do with it.
 */
export async function notifyPermission(permission: string, input: NotifyInput): Promise<void> {
  try {
    const roles = await Role.find({
      $or: [{ permissions: permission }, { permissions: "*" }],
    })
      .select("_id")
      .lean();

    if (roles.length === 0) return;

    const filter: Record<string, unknown> = {
      roleId: { $in: roles.map((r) => r._id) },
      status: "ACTIVE",
    };
    const users = await User.find(filter).select("_id").lean();
    await notify(users.map((u) => String(u._id)), input);
  } catch (err) {
    logger.error({ err, permission }, "failed to resolve notification recipients");
  }
}

/* ── The events worth telling somebody about ─────────────────────────────── */

export async function notifyApprovalRequired(options: {
  transactionId: string;
  txnNo: string;
  typeLabel: string;
  amount: number;
  submittedBy: string;
}): Promise<void> {
  await notifyPermission("approvals.act", {
    type: "APPROVAL_REQUIRED",
    severity: "WARNING",
    title: `${options.typeLabel} of ${formatINR(options.amount)} needs approval`,
    body: `Raised by ${options.submittedBy}. Nothing has been posted yet.`,
    link: "/approvals",
    amount: options.amount,
    entity: "Transaction",
    entityId: options.transactionId,
  });
}

export async function notifyApprovalDecided(options: {
  userId: string;
  approved: boolean;
  txnNo: string;
  amount: number;
  decidedBy: string;
  reason?: string;
  transactionId: string;
}): Promise<void> {
  await notify([options.userId], {
    type: options.approved ? "APPROVAL_COMPLETED" : "APPROVAL_REJECTED",
    severity: options.approved ? "SUCCESS" : "DANGER",
    title: options.approved
      ? `Your ${formatINR(options.amount)} request was approved`
      : `Your ${formatINR(options.amount)} request was rejected`,
    body: options.approved
      ? `Approved by ${options.decidedBy} and posted as ${options.txnNo}.`
      : `Rejected by ${options.decidedBy}. ${options.reason ?? ""}`.trim(),
    link: options.approved ? `/daybook?q=${options.txnNo}` : "/approvals",
    amount: options.amount,
    entity: "Transaction",
    entityId: options.transactionId,
  });
}

/** A drawer that did not tally. Everyone holding `finance.cash.view` is told. */
export async function notifyCashTallyMismatch(options: {
  drawer: string;
  difference: number;
  status: string;
  countedBy: string;
}): Promise<void> {
  await notifyPermission("finance.cash.view", {
    type: "CASH_TALLY_MISMATCH",
    severity: "WARNING",
    title: `Cash ${options.status.toLowerCase()} by ${formatINR(Math.abs(options.difference))}`,
    body: `${options.drawer} was counted by ${options.countedBy}. The expected figure has not been changed — the difference needs investigating.`,
    link: "/cash-tally",
    amount: options.difference,
  });
}

export async function notifyReversal(options: {
  originalNo: string;
  reversalNo: string;
  amount: number;
  reversedBy: string;
  reason: string;
}): Promise<void> {
  await notifyPermission("finance.daybook.view", {
    type: "TRANSACTION_REVERSED",
    severity: "WARNING",
    title: `${options.originalNo} was reversed`,
    body: `${formatINR(options.amount)} cancelled by ${options.reversedBy} — ${options.reason}`,
    link: `/daybook?q=${options.reversalNo}`,
    amount: options.amount,
  });
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listForUser(userId: string, limit = 30) {
  const [items, unread] = await Promise.all([
    Notification.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ userId, readAt: null }),
  ]);

  return {
    items: items.map((n) => ({
      id: String(n._id),
      type: n.type,
      severity: n.severity,
      title: n.title,
      body: n.body,
      link: n.link,
      amount: n.amount,
      read: Boolean(n.readAt),
      createdAt: n.createdAt.toISOString(),
    })),
    unread,
  };
}

export async function markRead(userId: string, ids?: string[]): Promise<number> {
  const filter: Record<string, unknown> = { userId, readAt: null };
  if (ids?.length) filter._id = { $in: ids };
  const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  return result.modifiedCount;
}
