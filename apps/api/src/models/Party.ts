import { Schema, model, type Document, type Types } from "mongoose";
import { PARTY_TYPE, RECORD_STATUS, type PartyType, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions, moneyField } from "./fields.js";

/**
 * Party master (§10).
 *
 * Customer, vendor, distributor, agent, employee — all one collection with one ledger
 * account each. A business that both buys from and sells to you should show ONE net
 * position, not two rows with opposite signs that somebody has to mentally offset.
 *
 * As everywhere else: no stored balance. The party's position is the signed sum of their
 * ledger entries, cached on their LedgerAccount. The sign convention is the Khata's:
 *
 *     POSITIVE  they owe us   LENA HAI
 *     NEGATIVE  we owe them   DENA HAI
 *     ZERO      settled       CLEAR
 */
export interface PartyDoc extends Document<Types.ObjectId> {
  name: string;
  code: string;
  type: PartyType;
  branchId: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;

  mobile?: string;
  altMobile?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;

  gstin?: string;
  pan?: string;

  /**
   * Credit limit as a positive amount; 0 means no limit.
   * Checked when a posting would increase what they owe us.
   */
  creditLimit: number;
  /** Payment terms in days — drives the due date and therefore the aging bucket. */
  creditDays: number;

  status: RecordStatus;
  notes?: string;

  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const partySchema = new Schema<PartyDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 140 },

    /** Generated as PTY-000123 when not supplied. Unique per branch, not globally —
     *  two branches may legitimately run their own numbering. */
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 24 },

    type: { type: String, enum: Object.values(PARTY_TYPE), default: PARTY_TYPE.CUSTOMER, index: true },

    /**
     * Immutable. Moving a party between branches would strand their historical ledger
     * entries in the branch that posted them, so that branch's trial balance would
     * reference an account it no longer owns.
     */
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
      immutable: true,
    },
    ledgerAccountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true, index: true },

    mobile: { type: String, trim: true, index: true },
    altMobile: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true, maxlength: 300 },
    city: { type: String, trim: true, maxlength: 80 },
    state: { type: String, trim: true, maxlength: 80 },
    pincode: { type: String, trim: true, match: /^\d{6}$/ },

    gstin: { type: String, trim: true, uppercase: true },
    pan: { type: String, trim: true, uppercase: true },

    creditLimit: moneyField({ default: 0, nonNegative: true }),
    creditDays: { type: Number, default: 0, min: 0, max: 365 },

    status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
    notes: { type: String, trim: true, maxlength: 1000 },

    createdBy: actorField(),
    updatedBy: actorField(),
  },
  baseSchemaOptions(),
);

partySchema.index({ branchId: 1, code: 1 }, { unique: true });
partySchema.index({ branchId: 1, status: 1, name: 1 });
partySchema.index({ branchId: 1, type: 1 });
/**
 * A mobile number is the fastest way a counter clerk finds a party. Sparse and
 * non-unique on purpose: the same number can legitimately belong to two parties (a
 * proprietor with two firms), and refusing that would block real data entry.
 */
partySchema.index({ mobile: 1, branchId: 1 }, { sparse: true });
partySchema.index({ name: "text", code: "text", mobile: "text" }, { name: "party_search" });

export const Party = model<PartyDoc>("Party", partySchema);
