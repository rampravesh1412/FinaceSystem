import { Schema, model, type Document, type Types } from "mongoose";
import { RECORD_STATUS, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions } from "./fields.js";

/**
 * A physical cash drawer.
 *
 * Its ledger account is created with `enforceBalance: true` and no overdraft: you cannot
 * pay out cash that is not in the drawer. That is the one hard difference from a bank
 * account, which may have a sanctioned overdraft facility.
 *
 * NOT branch-scoped, for the same reason as a bank account: a drawer is a named thing
 * counted on its own, and its tally is per drawer per day. Several are supported for a
 * business running separate counters that tally independently — they are told apart by
 * name, not by which office they sit in. The branch that transacted is recorded on each
 * posting, so a branch's cash movement is still reportable.
 */
export interface CashAccountDoc extends Document<Types.ObjectId> {
  ledgerAccountId: Types.ObjectId;
  name: string;
  code?: string;
  /** The primary drawer — the default target for a cash payment. */
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

/** Two drawers cannot share a name — the name is how an operator picks one. */
cashAccountSchema.index({ name: 1 }, { unique: true });
/** At most one default drawer, enforced by a partial unique index rather than by
 *  application logic that two concurrent writes could both pass. */
cashAccountSchema.index({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

export const CashAccount = model<CashAccountDoc>("CashAccount", cashAccountSchema);
