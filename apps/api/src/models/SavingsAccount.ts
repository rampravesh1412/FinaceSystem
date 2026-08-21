import { Schema, model, type Document, type Types } from "mongoose";
import { RECORD_STATUS, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions, branchField } from "./fields.js";

/**
 * Bachat Khata — a member's savings account (§13).
 *
 * Its ledger account is a LIABILITY: the money belongs to the member, we merely hold it.
 * That single classification is what makes the balance sheet come out right — savings sit
 * on the liability side against the cash they arrived as, rather than inflating our own
 * assets.
 *
 * As everywhere else: no stored balance. It is the signed sum of the ledger entries.
 */
export interface SavingsAccountDoc extends Document<Types.ObjectId> {
  accountNo: string;
  memberName: string;
  /** Set when the member is already a party on the books. */
  partyId?: Types.ObjectId | null;
  mobile?: string;
  branchId: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;
  /** Annual rate in basis points. 6.5% = 650. */
  interestRateBps: number;
  status: RecordStatus;
  notes?: string;
  openedAt: Date;
  closedAt?: Date | null;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const savingsAccountSchema = new Schema<SavingsAccountDoc>(
  {
    accountNo: { type: String, required: true, unique: true, uppercase: true, trim: true },
    memberName: { type: String, required: true, trim: true, maxlength: 140 },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", default: null, index: true },
    mobile: { type: String, trim: true, index: true },
    branchId: branchField(true),
    ledgerAccountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true, index: true },
    interestRateBps: { type: Number, default: 0, min: 0, max: 10_000 },
    status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
    notes: { type: String, trim: true, maxlength: 500 },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
    createdBy: actorField(),
  },
  baseSchemaOptions(),
);

savingsAccountSchema.index({ branchId: 1, status: 1, memberName: 1 });
savingsAccountSchema.index({ memberName: "text", accountNo: "text", mobile: "text" }, { name: "savings_search" });

export const SavingsAccount = model<SavingsAccountDoc>("SavingsAccount", savingsAccountSchema);
