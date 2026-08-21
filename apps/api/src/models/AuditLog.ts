import { Schema, model, type Document, type Types } from "mongoose";
import { AUDIT_ACTION, type AuditAction } from "@amiri/shared";

export interface AuditLogDoc extends Document<Types.ObjectId> {
  userId?: Types.ObjectId;
  userName: string;
  userEmail?: string;
  roleName?: string;
  branchId?: Types.ObjectId;

  action: AuditAction;
  entity: string;
  entityId?: string;
  entityLabel?: string;

  oldValue?: unknown;
  newValue?: unknown;
  /** Only the paths that actually changed — see `diff()` in audit.service. */
  changedFields?: string[];

  reason?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  /** For a money-moving action, the amount in paise, so the log is filterable by value. */
  amount?: number;

  success: boolean;
  errorCode?: string;

  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    /**
     * The actor's name and role are DENORMALISED, on purpose.
     *
     * An audit record must remain readable years later even if the user is deleted,
     * renamed, or moved to a different role. A populated reference would show today's
     * role against a two-year-old action, which is exactly the wrong answer to
     * "who had permission to do this, at the time?".
     */
    userName: { type: String, required: true },
    userEmail: { type: String },
    roleName: { type: String },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", index: true },

    action: { type: String, enum: Object.values(AUDIT_ACTION), required: true, index: true },
    entity: { type: String, required: true, index: true },
    entityId: { type: String, index: true },
    entityLabel: { type: String },

    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    changedFields: { type: [String], default: undefined },

    reason: { type: String, maxlength: 1000 },
    ip: { type: String },
    userAgent: { type: String, maxlength: 400 },
    requestId: { type: String, index: true },
    amount: { type: Number },

    success: { type: Boolean, default: true, index: true },
    errorCode: { type: String },
  },
  {
    // `createdAt` only. An audit row has no `updatedAt` because it is never updated.
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

/**
 * APPEND-ONLY ENFORCEMENT (§26).
 *
 * Mongoose middleware cannot stop someone with a mongo shell, but it does make it
 * impossible for application code to tamper with the trail by accident or through a
 * generic "update this collection" helper. The real guarantee in production comes from a
 * database role that grants `insert` and `find` on this collection and withholds
 * `update` and `remove`; this is the in-process half of that pair.
 */
const blockMutation = function blockMutation(this: unknown, next: (err?: Error) => void): void {
  next(
    new Error(
      "AuditLog is append-only. Audit records cannot be updated or deleted — " +
        "if a record is wrong, write a corrective entry alongside it.",
    ),
  );
};

for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  auditLogSchema.pre(op, blockMutation);
}

auditLogSchema.pre("save", function preventEdit(next) {
  if (!this.isNew) {
    next(new Error("AuditLog is append-only. An existing audit record cannot be modified."));
    return;
  }
  next();
});

/* Query patterns the audit screen actually uses. */
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 }); // record timeline (§51)
auditLogSchema.index({ userId: 1, createdAt: -1 }); // user activity report
auditLogSchema.index({ branchId: 1, createdAt: -1 }); // branch-scoped audit view
auditLogSchema.index({ action: 1, createdAt: -1 });

export const AuditLog = model<AuditLogDoc>("AuditLog", auditLogSchema);
