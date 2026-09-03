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
  /** Charge comes out of the amount (true) or is levied on top of it (false). */
  deductFromAmount: boolean;
  /** An ExpenseCategory or IncomeHead. Null falls back to the built-in system account. */
  chargeAccountId?: Types.ObjectId | null;
  appliesTo: string[];
  partyTypes: string[];
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

    /**
     * Defaults to true — a rate quoted "on" an amount comes out of it.
     *
     * Existing rules created before this field predate the distinction and were behaving
     * as ADDED on a payout. They pick up `true` on read, which changes that behaviour, and
     * that is the intended correction rather than an accident: `false` is the special case
     * (a bank's own transfer fee) and is now stated explicitly by whoever wants it.
     */
    deductFromAmount: { type: Boolean, default: true },

    /** Refs either collection; resolved by id, since both are account heads. */
    chargeAccountId: { type: Schema.Types.ObjectId, default: null },

    appliesTo: [{ type: String, enum: Object.values(TRANSACTION_TYPE) }],
    partyTypes: [{ type: String, enum: Object.values(PARTY_TYPE) }],

    /** Null makes the rule organisation-wide. */
    status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
    notes: { type: String, trim: true, maxlength: 500 },
    createdBy: actorField(),
  },
  baseSchemaOptions(),
);

chargeRuleSchema.index({ status: 1, appliesTo: 1 });

export const ChargeRule = model<ChargeRuleDoc>("ChargeRule", chargeRuleSchema);
