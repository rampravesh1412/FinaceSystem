import { Schema, type SchemaDefinitionProperty } from "mongoose";

/**
 * Reusable schema fragments.
 *
 * Centralising these is not just tidiness — `moneyField` in particular is the guard that
 * stops a float ever reaching the database. If an amount is written anywhere, it is
 * written through this definition, and the validator rejects a non-integer at the
 * Mongoose layer even if a service somewhere forgot to go through `asPaise`.
 */

export interface MoneyFieldOptions {
  required?: boolean;
  default?: number;
  /** Reject negatives. Correct for a transaction amount, wrong for a running balance. */
  nonNegative?: boolean;
  /** Reject zero as well. Correct for the amount on a posting. */
  positive?: boolean;
}

export function moneyField(options: MoneyFieldOptions = {}): SchemaDefinitionProperty<number> {
  const { required = false, default: def, nonNegative = false, positive = false } = options;

  return {
    type: Number,
    required,
    ...(def !== undefined ? { default: def } : {}),
    validate: [
      {
        validator: (v: number) => v === null || v === undefined || Number.isInteger(v),
        message:
          "Money must be a whole number of paise. A fractional value here means a float " +
          "leaked into a financial calculation.",
      },
      {
        validator: (v: number) =>
          v === null || v === undefined || Math.abs(v) <= Number.MAX_SAFE_INTEGER,
        message: "Amount is outside the range that can be represented exactly.",
      },
      ...(nonNegative
        ? [
            {
              validator: (v: number) => v === null || v === undefined || v >= 0,
              message: "Amount cannot be negative.",
            },
          ]
        : []),
      ...(positive
        ? [
            {
              validator: (v: number) => v === null || v === undefined || v > 0,
              message: "Amount must be greater than zero.",
            },
          ]
        : []),
    ],
  } as SchemaDefinitionProperty<number>;
}

/**
 * A business date, normalised to UTC midnight.
 *
 * Financial dates are calendar days, not instants. A payment entered at 11:40pm IST on
 * the 19th belongs in the 19th's DayBook; storing the raw instant would put it in the
 * 19th at UTC+5:30 but the 18th at UTC, and the DayBook total would depend on where the
 * server happens to run. The setter strips the time component so a `$gte`/`$lt` day
 * range is exact everywhere.
 */
export const businessDateField = (required = true): SchemaDefinitionProperty<Date> =>
  ({
    type: Date,
    required,
    set: (v: Date | string | undefined) => {
      if (!v) return v;
      const d = v instanceof Date ? v : new Date(v);
      if (Number.isNaN(d.getTime())) return v;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    },
  }) as SchemaDefinitionProperty<Date>;

/** `createdBy` / `updatedBy`. Present on everything a human can change. */
export const actorField = (required = false): SchemaDefinitionProperty =>
  ({
    type: Schema.Types.ObjectId,
    ref: "User",
    required,
    index: true,
  }) as SchemaDefinitionProperty;

/** The branch ownership field. Every branch-scoped model carries exactly this. */
export const branchField = (required = true): SchemaDefinitionProperty =>
  ({
    type: Schema.Types.ObjectId,
    ref: "Branch",
    required,
    index: true,
  }) as SchemaDefinitionProperty;

export const attachmentSchema = new Schema(
  {
    filename: { type: String, required: true, trim: true, maxlength: 255 },
    url: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    uploadedBy: actorField(true),
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

export const noteSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    createdBy: actorField(true),
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

/**
 * Standard `toJSON`.
 *
 * Renames `_id` to `id`, drops `__v`, and removes any path the model marked as secret.
 * Applied through `baseSchemaOptions` so no model can forget it and accidentally ship a
 * password hash to a client.
 */
export function jsonTransform(hidden: string[] = []) {
  return {
    virtuals: true,
    versionKey: false,
    transform(_doc: unknown, ret: Record<string, unknown>) {
      ret.id = String(ret._id);
      delete ret._id;
      for (const path of hidden) delete ret[path];
      return ret;
    },
  };
}

export function baseSchemaOptions(hidden: string[] = []) {
  return {
    timestamps: true,
    toJSON: jsonTransform(hidden),
    toObject: jsonTransform(hidden),
  };
}
