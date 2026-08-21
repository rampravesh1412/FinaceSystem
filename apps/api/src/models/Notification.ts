import { Schema, model, type Document, type Types } from "mongoose";
import { NOTIFICATION_TYPE, SEVERITY, type NotificationType, type Severity } from "@amiri/shared";
import { baseSchemaOptions, moneyField } from "./fields.js";

/**
 * A notification (§50).
 *
 * Addressed to a USER, not broadcast to a role: role membership changes, and a message
 * that re-targets itself when somebody is promoted is a message nobody owns. The fan-out
 * from "everyone who can approve" to individual rows happens once, at send time.
 *
 * Notifications are disposable — they carry no financial meaning and can be deleted
 * freely, unlike anything in the ledger or the audit trail. The TTL index below is
 * deliberate: a notifications collection that grows forever is pure cost.
 */
export interface NotificationDoc extends Document<Types.ObjectId> {
  userId: Types.ObjectId;
  type: NotificationType;
  severity: Severity;
  title: string;
  body?: string;
  /** Where clicking it should go. */
  link?: string;
  amount?: number;
  branchId?: Types.ObjectId | null;
  entity?: string;
  entityId?: string;
  readAt?: Date | null;
  createdAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: Object.values(NOTIFICATION_TYPE), required: true },
    severity: { type: String, enum: Object.values(SEVERITY), default: SEVERITY.INFO },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, trim: true, maxlength: 600 },
    link: { type: String, trim: true, maxlength: 300 },
    amount: moneyField(),
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    entity: { type: String, trim: true },
    entityId: { type: String, trim: true },
    readAt: { type: Date, default: null },
  },
  { ...baseSchemaOptions(), timestamps: { createdAt: true, updatedAt: false } },
);

/** The bell query: this user's newest first, unread ones counted separately. */
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

/**
 * Expire after 90 days.
 *
 * Safe precisely because a notification is a pointer, never a record: the transaction,
 * the approval and the audit row it refers to all survive. Applying a TTL to anything in
 * the ledger would be unthinkable.
 */
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const Notification = model<NotificationDoc>("Notification", notificationSchema);
