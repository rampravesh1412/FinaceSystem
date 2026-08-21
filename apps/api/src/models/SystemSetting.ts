import { Schema, model, type Document, type Types } from "mongoose";
import { actorField, baseSchemaOptions } from "./fields.js";

/**
 * Runtime configuration (§35, §27).
 *
 * A key/value store rather than a fixed schema, because the things that belong here —
 * approval thresholds, organisation details, feature switches — are exactly the things
 * that change without a deploy. Each row is audited on write like anything else.
 */
export interface SystemSettingDoc extends Document<Types.ObjectId> {
  key: string;
  value: unknown;
  description?: string;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const systemSettingSchema = new Schema<SystemSettingDoc>(
  {
    key: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String, trim: true, maxlength: 300 },
    updatedBy: actorField(),
  },
  baseSchemaOptions(),
);

export const SystemSetting = model<SystemSettingDoc>("SystemSetting", systemSettingSchema);

/** Setting keys used by the application. Referenced rather than typed as string literals. */
export const SETTING_KEYS = {
  APPROVAL: "approval.settings",
  ORGANISATION: "org.profile",
} as const;
