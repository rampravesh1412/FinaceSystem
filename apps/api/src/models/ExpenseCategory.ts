import { Schema, model, type Document, type Types } from "mongoose";
import { RECORD_STATUS, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions } from "./fields.js";

/**
 * Expense heads and income heads (§16, §17).
 *
 * Both are the same shape, so one schema builds two models. Each carries a
 * `ledgerAccountId`, because a head IS a ledger account — that is what makes the P&L a
 * plain aggregation over entries grouped by account rather than a special-cased report.
 *
 * Custom heads are supported by design: the brief lists Panel Expense, Ram Ji Expense and
 * Domain alongside Salary and Rent, and a business will keep inventing more.
 */
export interface AccountHeadDoc extends Document<Types.ObjectId> {
  name: string;
  code: string;
  description?: string;
  parentId?: Types.ObjectId | null;
  ledgerAccountId: Types.ObjectId;
  /** Seeded heads cannot be deleted; they can be renamed and deactivated. */
  isSystem: boolean;
  status: RecordStatus;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

function headSchema(refName: string) {
  const schema = new Schema<AccountHeadDoc>(
    {
      name: { type: String, required: true, trim: true, maxlength: 80 },
      code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 24 },
      description: { type: String, trim: true, maxlength: 300 },
      /** Sub-heads: "Panel Expense" beneath "Operations". One level is enough in practice. */
      parentId: { type: Schema.Types.ObjectId, ref: refName, default: null, index: true },
      ledgerAccountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true, index: true },
      isSystem: { type: Boolean, default: false },
      status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
      createdBy: actorField(),
    },
    baseSchemaOptions(),
  );
  schema.index({ status: 1, name: 1 });
  return schema;
}

export const ExpenseCategory = model<AccountHeadDoc>("ExpenseCategory", headSchema("ExpenseCategory"));
export const IncomeHead = model<AccountHeadDoc>("IncomeHead", headSchema("IncomeHead"));
