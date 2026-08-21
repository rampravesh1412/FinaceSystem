import { Schema, model, type Document, type Types } from "mongoose";
import { RECORD_STATUS, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions, branchField } from "./fields.js";

/**
 * The physical cash drawer for a branch.
 *
 * Its ledger account is created with `enforceBalance: true` and no overdraft: you cannot
 * pay out cash that is not in the drawer. That is the one hard difference from a bank
 * account, which may have a sanctioned overdraft facility.
 *
 * Most branches have one, but several are supported for a business running separate
 * counters that tally independently at end of day.
 */
export interface CashAccountDoc extends Document<Types.ObjectId> {
  branchId: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;
  name: string;
  code?: string;
  /** The branch's primary drawer — the default target for a cash payment. */
  isDefault: boolean;
  status: RecordStatus;
  notes?: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const cashAccountSchema = new Schema<CashAccountDoc>(
  {
    branchId: branchField(true),
    ledgerAccountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, trim: true, uppercase: true, maxlength: 20 },
    isDefault: { type: Boolean, default: false },
    status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
    notes: { type: String, trim: true, maxlength: 500 },
    createdBy: actorField(),
    updatedBy: actorField(),
  },
  baseSchemaOptions(),
);

cashAccountSchema.index({ branchId: 1, name: 1 }, { unique: true });
/** At most one default drawer per branch, enforced by a partial unique index rather than
 *  by application logic that two concurrent writes could both pass. */
cashAccountSchema.index(
  { branchId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

export const CashAccount = model<CashAccountDoc>("CashAccount", cashAccountSchema);
