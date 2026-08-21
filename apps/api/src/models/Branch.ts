import { Schema, model, type Document, type Types } from "mongoose";
import { RECORD_STATUS, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions } from "./fields.js";

export interface BranchDoc extends Document<Types.ObjectId> {
  name: string;
  code: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
  email?: string;
  managerId?: Types.ObjectId;
  status: RecordStatus;
  notes?: string;
  /** The date the branch's books start. Postings before this are rejected. */
  booksFromDate?: Date;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const branchSchema = new Schema<BranchDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * The branch code (101, 102, 105 … in the AMIRI workbook).
     *
     * Unique and never updatable: it is printed on statements, quoted in reconciliation
     * and used as the human key across the whole business. Changing it would silently
     * invalidate every document already issued under the old code, so the update schema
     * omits the field entirely and this index is the backstop.
     */
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: 12,
      immutable: true,
    },

    address: { type: String, trim: true, maxlength: 300 },
    city: { type: String, trim: true, maxlength: 80, index: true },
    state: { type: String, trim: true, maxlength: 80 },
    pincode: { type: String, trim: true, match: /^\d{6}$/ },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },

    managerId: { type: Schema.Types.ObjectId, ref: "User", index: true },

    status: {
      type: String,
      enum: Object.values(RECORD_STATUS),
      default: RECORD_STATUS.ACTIVE,
      index: true,
    },

    notes: { type: String, trim: true, maxlength: 500 },
    booksFromDate: { type: Date },

    createdBy: actorField(),
    updatedBy: actorField(),
  },
  baseSchemaOptions(),
);

/**
 * Note what is NOT here: no `cashBalance`, no `bankBalance`, no `openingBalance`.
 *
 * A branch's balances are the sum of its ledger entries, computed on demand and cached on
 * the LedgerAccount rows. Storing a mutable balance on the branch would create a second
 * source of truth that drifts from the ledger, and "fix the number on the branch record"
 * is exactly the shortcut §62 forbids. Opening balances are posted as a dated
 * OPENING_BALANCE transaction against equity, so even day zero is double-entry.
 */

branchSchema.index({ name: "text", code: "text", city: "text" }, { name: "branch_search" });
branchSchema.index({ status: 1, name: 1 });

export const Branch = model<BranchDoc>("Branch", branchSchema);
