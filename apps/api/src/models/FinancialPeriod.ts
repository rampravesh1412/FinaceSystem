import { Schema, model, type Document, type Types } from "mongoose";
import { PERIOD_STATUS, type PeriodStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions, businessDateField } from "./fields.js";

/**
 * An accounting period (§35).
 *
 * Once CLOSED, nothing may be posted into it — including a reversal. That is deliberate
 * and it is the whole point of closing: figures somebody has already reported on must not
 * change underneath them. A correction for a closed period is posted in the CURRENT
 * period, referencing the original.
 *
 * LOCKED goes further — reopening requires a super admin. It is for a year that has been
 * filed with the tax authority.
 *
 * Periods are organisation-wide. One office closing its books
 * independently would make a consolidated report meaningless, since half the
 * organisation could still be posting into a month the other half had finalised.
 */
export interface FinancialPeriodDoc extends Document<Types.ObjectId> {
  name: string;
  startDate: Date;
  endDate: Date;
  status: PeriodStatus;
  closedBy?: Types.ObjectId | null;
  closedAt?: Date | null;
  closeReason?: string;
  reopenedBy?: Types.ObjectId | null;
  reopenedAt?: Date | null;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const financialPeriodSchema = new Schema<FinancialPeriodDoc>(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    startDate: businessDateField(true),
    endDate: businessDateField(true),
    status: {
      type: String,
      enum: Object.values(PERIOD_STATUS),
      default: PERIOD_STATUS.OPEN,
      index: true,
    },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, trim: true, maxlength: 1000 },
    reopenedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reopenedAt: { type: Date, default: null },
    createdBy: actorField(),
  },
  baseSchemaOptions(),
);

/**
 * The lookup the posting engine performs on EVERY transaction, so it must be indexed.
 * Ranged on both bounds: "which period contains this date".
 */
financialPeriodSchema.index({ startDate: 1, endDate: 1 });
financialPeriodSchema.index({ status: 1, startDate: -1 });

export const FinancialPeriod = model<FinancialPeriodDoc>("FinancialPeriod", financialPeriodSchema);
