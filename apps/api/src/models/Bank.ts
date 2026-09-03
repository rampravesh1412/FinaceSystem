import { Schema, model, type Document, type Types } from "mongoose";
import { RECORD_STATUS, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions } from "./fields.js";

/**
 * A banking institution — HDFC, ICICI, SBI, Axis.
 *
 * Holds NO balance. Money lives in the BankAccounts beneath it. Keeping the institution
 * separate means "HDFC" is spelled one way on every report and in the bank-wise summary
 * on the dashboard.
 */
export interface BankDoc extends Document<Types.ObjectId> {
  name: string;
  shortName?: string;
  ifscPrefix?: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  status: RecordStatus;
  notes?: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const bankSchema = new Schema<BankDoc>(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 120 },
    shortName: { type: String, trim: true, uppercase: true, maxlength: 20 },
    /** The first four characters of every IFSC at this bank, e.g. HDFC. Used to validate
     *  that an account's IFSC actually belongs to the bank it was filed under. */
    ifscPrefix: { type: String, trim: true, uppercase: true, match: /^[A-Z]{4}$/ },
    contactPerson: { type: String, trim: true, maxlength: 80 },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
    notes: { type: String, trim: true, maxlength: 500 },
    createdBy: actorField(),
    updatedBy: actorField(),
  },
  baseSchemaOptions(),
);

bankSchema.index({ name: "text", shortName: "text" }, { name: "bank_search" });

export const Bank = model<BankDoc>("Bank", bankSchema);
