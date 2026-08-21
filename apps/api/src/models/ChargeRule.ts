import { Schema, model, type Document, type Types } from "mongoose";
import {
  CHARGE_BEARER,
  CHARGE_TYPE,
  PARTY_TYPE,
  RECORD_STATUS,
  TRANSACTION_TYPE,
  type ChargeBearer,
  type ChargeType,
  type RecordStatus,
} from "@amiri/shared";
import { actorField, baseSchemaOptions, moneyField } from "./fields.js";

/**
 * A charge or commission rule (§18).
 *
 * Rates are integer BASIS POINTS, never a float percent: 1.75% is stored as `175`,
 * exactly. The same reasoning as paise — a commission that drifts by a paisa per
 * transaction becomes a month-end reconciliation problem nobody can explain.
 *
 * A rule is a TEMPLATE. Once a transaction is posted, the computed charge and a frozen
 * human-readable basis string live on the transaction itself, so editing the rule later
 * cannot rewrite what was already charged.
 */
export interface ChargeRuleDoc extends Document<Types.ObjectId> {
  name: string;
  code: string;
  description?: string;
  type: ChargeType;
  rateBps?: number;
  fixedAmount?: number;
  tiers: Array<{ upTo: number | null; rateBps?: number; fixedAmount?: number }>;
  minCharge: number;
  maxCharge: number;
  bearer: ChargeBearer;
  appliesTo: string[];
  partyTypes: string[];
  branchId?: Types.ObjectId | null;
  status: RecordStatus;
  notes?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/** Typed explicitly: without a generic, Mongoose infers a shape that `moneyField()`'s
 *  return type cannot satisfy, and the definition fails to compile. */
interface TierShape {
  upTo: number | null;
  rateBps?: number;
  fixedAmount?: number;
}

const tierSchema = new Schema<TierShape>(
  {
    /** Inclusive ceiling. `null` on the final, open-ended band. */
    upTo: { type: Number, default: null },
    rateBps: { type: Number, min: 0, max: 10_000 },
    fixedAmount: moneyField({ nonNegative: true }),
  },
  { _id: false },
);

const chargeRuleSchema = new Schema<ChargeRuleDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 24 },
    description: { type: String, trim: true, maxlength: 300 },

    type: { type: String, enum: Object.values(CHARGE_TYPE), required: true },
    rateBps: { type: Number, min: 0, max: 10_000 },
    fixedAmount: moneyField({ nonNegative: true }),
    tiers: { type: [tierSchema], default: [] },

    /** Floor and ceiling applied after the base calculation. 0 means "no bound". */
    minCharge: moneyField({ default: 0, nonNegative: true }),
    maxCharge: moneyField({ default: 0, nonNegative: true }),

    /** SELF = our expense, PARTY = our income. Decides which side of the ledger it hits. */
    bearer: { type: String, enum: Object.values(CHARGE_BEARER), default: CHARGE_BEARER.SELF },

    appliesTo: [{ type: String, enum: Object.values(TRANSACTION_TYPE) }],
    partyTypes: [{ type: String, enum: Object.values(PARTY_TYPE) }],

    /** Null makes the rule organisation-wide. */
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
    notes: { type: String, trim: true, maxlength: 500 },
    createdBy: actorField(),
  },
  baseSchemaOptions(),
);

chargeRuleSchema.index({ status: 1, appliesTo: 1 });

export const ChargeRule = model<ChargeRuleDoc>("ChargeRule", chargeRuleSchema);
