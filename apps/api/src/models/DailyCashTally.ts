import { Schema, model, type Document, type Types } from "mongoose";
import { TALLY_STATUS, type TallyStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions, branchField, businessDateField, moneyField } from "./fields.js";

/**
 * A counted cash drawer (§20).
 *
 * Only `actualClosing` and `notes` come from a human. Everything else is a SNAPSHOT of
 * what the ledger said at the moment of counting, frozen deliberately: if a back-dated
 * transaction later changes what "expected" would be, this record still shows the figure
 * the operator was given when they counted. That is what makes it evidence rather than a
 * number that silently rewrites its own history.
 *
 * `difference` is stored, never acted on. §62: a shortfall is a finding to investigate,
 * not something this model corrects.
 */
export interface DailyCashTallyDoc extends Document<Types.ObjectId> {
  branchId: Types.ObjectId;
  cashAccountId: Types.ObjectId;
  date: Date;

  openingCash: number;
  cashReceived: number;
  cashPaid: number;
  adjustments: number;
  expectedClosing: number;

  actualClosing: number;
  /** actual − expected. Negative is SHORT, positive is EXCESS. */
  difference: number;
  status: TallyStatus;

  countedBy?: Types.ObjectId;
  countedAt?: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const dailyCashTallySchema = new Schema<DailyCashTallyDoc>(
  {
    branchId: branchField(true),
    cashAccountId: { type: Schema.Types.ObjectId, ref: "CashAccount", required: true, index: true },
    date: businessDateField(true),

    openingCash: moneyField({ default: 0 }),
    cashReceived: moneyField({ default: 0, nonNegative: true }),
    cashPaid: moneyField({ default: 0, nonNegative: true }),
    adjustments: moneyField({ default: 0 }),
    expectedClosing: moneyField({ default: 0 }),

    actualClosing: moneyField({ required: true, nonNegative: true }),
    difference: moneyField({ default: 0 }),
    status: { type: String, enum: Object.values(TALLY_STATUS), default: TALLY_STATUS.PENDING, index: true },

    countedBy: actorField(),
    countedAt: { type: Date },
    notes: { type: String, trim: true, maxlength: 1000 },
  },
  baseSchemaOptions(),
);

/** One tally per drawer per day — recounting updates the same record rather than adding a second. */
dailyCashTallySchema.index({ cashAccountId: 1, date: 1 }, { unique: true });
dailyCashTallySchema.index({ branchId: 1, date: -1 });
dailyCashTallySchema.index({ status: 1, date: -1 });

export const DailyCashTally = model<DailyCashTallyDoc>("DailyCashTally", dailyCashTallySchema);
