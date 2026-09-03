import { Schema, model, type Document, type Types } from "mongoose";
import { BANK_ACCOUNT_TYPE, RECORD_STATUS, type BankAccountType, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions, moneyField } from "./fields.js";

/**
 * A real bank account, owned by the organisation.
 *
 * NOT branch-scoped. One HDFC current account is one account: every counter pays into it
 * and draws on it, and the bank prints one statement for it. Filing a copy per branch
 * would split that single real balance across several ledgers, and none of them would
 * reconcile against the statement. The branch that transacted is recorded on each posting
 * instead, which is what per-branch reporting reads.
 *
 * Note what is NOT here: no `currentBalance`, no `availableBalance`. The balance is the
 * signed sum of this account's ledger entries, cached on its LedgerAccount row. Storing a
 * mutable balance on this document would create a second number that services could
 * update directly — and the moment two places can change a balance, they disagree.
 *
 * `ledgerAccountId` is required and set at creation inside the same transaction, so an
 * account that cannot be posted against cannot exist.
 */
export interface BankAccountDoc extends Document<Types.ObjectId> {
  bankId: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;

  accountName: string;
  accountNumber: string;
  ifsc: string;
  bankBranchName?: string;
  accountType: BankAccountType;

  overdraftLimit: number;
  lowBalanceThreshold: number;

  status: RecordStatus;
  notes?: string;

  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const bankAccountSchema = new Schema<BankAccountDoc>(
  {
    bankId: { type: Schema.Types.ObjectId, ref: "Bank", required: true, index: true, immutable: true },
    ledgerAccountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true, index: true },

    accountName: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * Immutable. Historical entries were posted against the real-world account this
     * number identifies; editing it would silently re-point months of reconciled
     * transactions at a different account. A wrongly-entered number is fixed by closing
     * this account and opening the correct one, which keeps the trail intact.
     */
    accountNumber: { type: String, required: true, trim: true, immutable: true },
    ifsc: { type: String, required: true, trim: true, uppercase: true, immutable: true },

    bankBranchName: { type: String, trim: true, maxlength: 120 },
    accountType: {
      type: String,
      enum: Object.values(BANK_ACCOUNT_TYPE),
      default: BANK_ACCOUNT_TYPE.CURRENT,
    },

    overdraftLimit: moneyField({ default: 0, nonNegative: true }),
    lowBalanceThreshold: moneyField({ default: 0, nonNegative: true }),

    status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
    notes: { type: String, trim: true, maxlength: 500 },

    createdBy: actorField(),
    updatedBy: actorField(),
  },
  baseSchemaOptions(),
);

/**
 * The same account number at the same bank cannot be filed twice.
 *
 * Scoped to {bank, accountNumber} rather than the number alone, because account numbers
 * are only unique within an institution. Without this, the same real account entered
 * twice would split one balance across two ledgers and neither would reconcile.
 */
bankAccountSchema.index({ bankId: 1, accountNumber: 1 }, { unique: true });
bankAccountSchema.index({ status: 1, accountName: 1 });
bankAccountSchema.index({ accountName: "text", accountNumber: "text" }, { name: "bank_account_search" });

export const BankAccount = model<BankAccountDoc>("BankAccount", bankAccountSchema);
