import { Schema, model, type Document, type Types } from "mongoose";
import { RECON_LINE_STATUS, type ReconLineStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions, branchField, businessDateField, moneyField } from "./fields.js";

/**
 * Bank reconciliation (§23).
 *
 * Compares what the BANK says against what our LEDGER says, for one account over one
 * window, and lists every line that does not agree.
 *
 * The `difference` field is the whole point of the module, and it is never auto-corrected.
 * §62 is explicit: if expected is ₹10,00,000 and actual is ₹9,80,000, the system reports
 * SHORT ₹20,000 and a human investigates. Quietly writing the bank's figure over ours
 * would destroy the only evidence that something is wrong.
 */
export interface ReconciliationDoc extends Document<Types.ObjectId> {
  bankAccountId: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;
  branchId: Types.ObjectId;
  from: Date;
  to: Date;
  statementBalance: number;
  /** Our ledger balance as at `to`, frozen when the reconciliation was opened. */
  systemBalance: number;
  difference: number;
  status: "IN_PROGRESS" | "COMPLETED" | "ABANDONED";
  completedAt?: Date | null;
  completedBy?: Types.ObjectId | null;
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const reconciliationSchema = new Schema<ReconciliationDoc>(
  {
    bankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true, index: true },
    ledgerAccountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    branchId: branchField(true),
    from: businessDateField(true),
    to: businessDateField(true),
    statementBalance: moneyField({ required: true }),
    systemBalance: moneyField({ required: true }),
    difference: moneyField({ required: true }),
    status: {
      type: String,
      enum: ["IN_PROGRESS", "COMPLETED", "ABANDONED"],
      default: "IN_PROGRESS",
      index: true,
    },
    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: String, trim: true, maxlength: 1000 },
    createdBy: actorField(true),
  },
  baseSchemaOptions(),
);

reconciliationSchema.index({ bankAccountId: 1, to: -1 });

export const Reconciliation = model<ReconciliationDoc>("Reconciliation", reconciliationSchema);

/* -------------------------------------------------------------------------- */

/** One line from the bank's statement, and what it was matched to. */
export interface ReconciliationLineDoc extends Document<Types.ObjectId> {
  reconciliationId: Types.ObjectId;
  date: Date;
  description: string;
  referenceNo?: string;
  /** Signed as the bank prints it: positive is a credit (money into the account). */
  amount: number;
  status: ReconLineStatus;
  ledgerEntryId?: Types.ObjectId | null;
  matchedBy?: Types.ObjectId | null;
  matchedAt?: Date | null;
  createdAt: Date;
}

const reconciliationLineSchema = new Schema<ReconciliationLineDoc>(
  {
    reconciliationId: { type: Schema.Types.ObjectId, ref: "Reconciliation", required: true, index: true },
    date: businessDateField(true),
    description: { type: String, required: true, trim: true, maxlength: 300 },
    referenceNo: { type: String, trim: true, maxlength: 80, index: true },
    amount: moneyField({ required: true }),
    status: {
      type: String,
      enum: Object.values(RECON_LINE_STATUS),
      default: RECON_LINE_STATUS.UNMATCHED,
      index: true,
    },
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
    matchedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    matchedAt: { type: Date, default: null },
  },
  // A statement line is written once and only ever reclassified, so `updatedAt`
  // carries no information. Spread first, then override, or the option is discarded.
  { ...baseSchemaOptions(), timestamps: { createdAt: true, updatedAt: false } },
);

reconciliationLineSchema.index({ reconciliationId: 1, status: 1 });

export const ReconciliationLine = model<ReconciliationLineDoc>(
  "ReconciliationLine",
  reconciliationLineSchema,
);
