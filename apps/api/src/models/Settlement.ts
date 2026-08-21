import { Schema, model, type Document, type Types } from "mongoose";
import { SETTLEMENT_KIND, SETTLEMENT_STATUS, type SettlementKind, type SettlementStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions, branchField, businessDateField, moneyField } from "./fields.js";

/**
 * Settlement (§24).
 *
 * A settlement is a WRAPPER around one or more postings, not a posting itself. It records
 * the intent ("clear ₹2,40,000 owed to EDDIGO") and links to the transactions that
 * actually moved the money.
 *
 * Keeping it separate from the ledger is what allows a PARTIAL settlement: the intent
 * stays open at ₹2,40,000 while ₹1,00,000 of transactions hang off it, and `settledAmount`
 * is the sum of those links rather than a number anyone types in.
 */
export interface SettlementDoc extends Document<Types.ObjectId> {
  settlementNo: string;
  date: Date;
  branchId: Types.ObjectId;
  kind: SettlementKind;

  partyId?: Types.ObjectId | null;
  sourceAccountId?: Types.ObjectId | null;
  sourceLabel?: string;
  destinationAccountId?: Types.ObjectId | null;
  destinationLabel?: string;

  amount: number;
  charges: number;
  netAmount: number;
  /** Sum of the linked transactions. Derived, never typed in. */
  settledAmount: number;

  transactionIds: Types.ObjectId[];
  status: SettlementStatus;

  referenceNo?: string;
  narration?: string;
  approvedBy?: Types.ObjectId | null;
  approvedAt?: Date | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const settlementSchema = new Schema<SettlementDoc>(
  {
    settlementNo: { type: String, required: true, unique: true, uppercase: true, trim: true },
    date: businessDateField(true),
    branchId: branchField(true),
    kind: { type: String, enum: Object.values(SETTLEMENT_KIND), required: true, index: true },

    partyId: { type: Schema.Types.ObjectId, ref: "Party", default: null, index: true },
    sourceAccountId: { type: Schema.Types.ObjectId, default: null },
    sourceLabel: { type: String },
    destinationAccountId: { type: Schema.Types.ObjectId, default: null },
    destinationLabel: { type: String },

    amount: moneyField({ required: true, positive: true }),
    charges: moneyField({ default: 0, nonNegative: true }),
    netAmount: moneyField({ required: true, nonNegative: true }),
    settledAmount: moneyField({ default: 0, nonNegative: true }),

    transactionIds: [{ type: Schema.Types.ObjectId, ref: "Transaction" }],
    status: {
      type: String,
      enum: Object.values(SETTLEMENT_STATUS),
      default: SETTLEMENT_STATUS.PENDING,
      index: true,
    },

    referenceNo: { type: String, trim: true, maxlength: 80 },
    narration: { type: String, trim: true, maxlength: 1000 },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    createdBy: actorField(true),
  },
  baseSchemaOptions(),
);

settlementSchema.index({ branchId: 1, date: -1 });
settlementSchema.index({ branchId: 1, status: 1, date: -1 });

export const Settlement = model<SettlementDoc>("Settlement", settlementSchema);
