import { Schema, type Types } from "mongoose";
import { TRANSACTION_TYPE } from "@amiri/shared";
import { Transaction, type TransactionDoc } from "./Transaction.js";
import { moneyField } from "./fields.js";

/**
 * Transaction discriminators.
 *
 * One `transactions` collection, one voucher sequence, one DayBook query — but each
 * business event carries its own strongly-typed extra fields. Mongoose stores them all
 * together with a `type` key and applies the right schema per document.
 *
 * What lives on the BASE (Transaction.ts): everything the DayBook, approvals, reversal,
 * attachments and audit need. What lives HERE: only fields specific to one event type.
 * If a field is being added to more than one discriminator, it belongs on the base.
 */

/* -------------------------------------------------------------------------- */
/* Payment In / Payment Out                                                   */
/* -------------------------------------------------------------------------- */

export interface PaymentDoc extends TransactionDoc {
  /** BankAccount or CashAccount id — the master, not the ledger account. */
  accountId: Types.ObjectId;
  accountKind: "BANK" | "CASH";
  accountLabel: string;
  chargeRuleId?: Types.ObjectId | null;
  chargeBearer?: "SELF" | "PARTY";
  chargeBasis?: string;
}

/**
 * Payment In and Payment Out share this field set.
 *
 * NOTE the absence of `index: true` on `accountId`, and the explicitly NAMED index built
 * below instead. Discriminator indexes are created on the shared `transactions`
 * collection as partial indexes filtered by `type`. Two discriminators declaring the same
 * field inline both auto-generate the name `accountId_1`, and the second one to be built
 * fails with "An existing index has the same name as the requested index" — at boot, once
 * both discriminators are registered. Naming them per type keeps both indexes and removes
 * the collision.
 */
function paymentFields(): Record<string, unknown> {
  return {
    accountId: { type: Schema.Types.ObjectId, required: true },
    accountKind: { type: String, enum: ["BANK", "CASH"], required: true },
    /** Denormalised so the DayBook renders "HDFC ••7890" without a per-row lookup. */
    accountLabel: { type: String, required: true },
    chargeRuleId: { type: Schema.Types.ObjectId, ref: "ChargeRule", default: null },
    chargeBearer: { type: String, enum: ["SELF", "PARTY"] },
    /** Human explanation of the charge: "1.75% of ₹1,00,000". Frozen at posting time so a
     *  later edit to the rule cannot rewrite history. */
    chargeBasis: { type: String },
  };
}

function paymentSchema(indexName: string): Schema<PaymentDoc> {
  const schema = new Schema<PaymentDoc>(paymentFields() as never);
  schema.index({ accountId: 1, date: -1 }, { name: indexName });
  return schema;
}

export const PaymentIn = Transaction.discriminator<PaymentDoc>(
  TRANSACTION_TYPE.PAYMENT_IN,
  paymentSchema("paymentin_account_date"),
);

export const PaymentOut = Transaction.discriminator<PaymentDoc>(
  TRANSACTION_TYPE.PAYMENT_OUT,
  paymentSchema("paymentout_account_date"),
);

/* -------------------------------------------------------------------------- */
/* Bank transfer (§8)                                                         */
/* -------------------------------------------------------------------------- */

export interface BankTransferDoc extends TransactionDoc {
  sourceAccountId: Types.ObjectId;
  sourceAccountKind: "BANK" | "CASH";
  sourceLabel: string;
  destinationAccountId: Types.ObjectId;
  destinationAccountKind: "BANK" | "CASH";
  destinationLabel: string;
  chargeRuleId?: Types.ObjectId | null;
  chargeBasis?: string;
}

export const BankTransfer = Transaction.discriminator<BankTransferDoc>(
  TRANSACTION_TYPE.BANK_TRANSFER,
  new Schema<BankTransferDoc>({
    sourceAccountId: { type: Schema.Types.ObjectId, required: true },
    sourceAccountKind: { type: String, enum: ["BANK", "CASH"], required: true },
    sourceLabel: { type: String, required: true },
    destinationAccountId: { type: Schema.Types.ObjectId, required: true },
    destinationAccountKind: { type: String, enum: ["BANK", "CASH"], required: true },
    destinationLabel: { type: String, required: true },
    chargeRuleId: { type: Schema.Types.ObjectId, ref: "ChargeRule", default: null },
    chargeBasis: { type: String },
  })
    // Named explicitly, for the same reason as the payment indexes above.
    .index({ sourceAccountId: 1, date: -1 }, { name: "transfer_source_date" })
    .index({ destinationAccountId: 1, date: -1 }, { name: "transfer_destination_date" }),
);

/* -------------------------------------------------------------------------- */
/* Expense (§16)                                                              */
/* -------------------------------------------------------------------------- */

export interface ExpenseDoc extends TransactionDoc {
  categoryId: Types.ObjectId;
  categoryName: string;
  accountId?: Types.ObjectId | null;
  accountKind?: "BANK" | "CASH";
  accountLabel?: string;
  taxAmount: number;
  invoiceNo?: string;
  invoiceDate?: Date;
  items: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
}

interface ExpenseItemShape {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

const expenseItemSchema = new Schema<ExpenseItemShape>(
  {
    description: { type: String, required: true, trim: true, maxlength: 200 },
    // Quantity may be fractional — 2.5 hours, 1.5 kg. It is NOT money, so it does not go
    // through moneyField; the line `amount` is the figure that reaches the ledger.
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: moneyField({ required: true, nonNegative: true }),
    amount: moneyField({ required: true, nonNegative: true }),
  },
  { _id: false },
);

export const Expense = Transaction.discriminator<ExpenseDoc>(
  TRANSACTION_TYPE.EXPENSE,
  new Schema<ExpenseDoc>({
    categoryId: { type: Schema.Types.ObjectId, ref: "ExpenseCategory", required: true },
    categoryName: { type: String, required: true },
    accountId: { type: Schema.Types.ObjectId, default: null },
    accountKind: { type: String, enum: ["BANK", "CASH"] },
    accountLabel: { type: String },
    taxAmount: moneyField({ default: 0, nonNegative: true }),
    invoiceNo: { type: String, trim: true, maxlength: 60 },
    invoiceDate: { type: Date },
    items: { type: [expenseItemSchema], default: [] },
  }).index({ categoryId: 1, date: -1 }, { name: "expense_category_date" }),
);

/* -------------------------------------------------------------------------- */
/* Income (§17)                                                               */
/* -------------------------------------------------------------------------- */

export interface IncomeDoc extends TransactionDoc {
  headId: Types.ObjectId;
  headName: string;
  accountId: Types.ObjectId;
  accountKind: "BANK" | "CASH";
  accountLabel: string;
}

export const Income = Transaction.discriminator<IncomeDoc>(
  TRANSACTION_TYPE.INCOME,
  new Schema<IncomeDoc>({
    headId: { type: Schema.Types.ObjectId, ref: "IncomeHead", required: true },
    headName: { type: String, required: true },
    accountId: { type: Schema.Types.ObjectId, required: true },
    accountKind: { type: String, enum: ["BANK", "CASH"], required: true },
    accountLabel: { type: String, required: true },
  }).index({ headId: 1, date: -1 }, { name: "income_head_date" }),
);

/* -------------------------------------------------------------------------- */
/* Adjustment (§25) and Opening balance                                       */
/* -------------------------------------------------------------------------- */

export interface AdjustmentDoc extends TransactionDoc {
  adjustmentType: string;
  reason: string;
}

export const Adjustment = Transaction.discriminator<AdjustmentDoc>(
  TRANSACTION_TYPE.ADJUSTMENT,
  new Schema<AdjustmentDoc>({
    adjustmentType: { type: String, required: true },
    /** Never optional. An unexplained balance change is exactly what §25 forbids. */
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
  }),
);

export const OpeningBalance = Transaction.discriminator<TransactionDoc>(
  TRANSACTION_TYPE.OPENING_BALANCE,
  new Schema<TransactionDoc>({}),
);

/* -------------------------------------------------------------------------- */
/* Bachat Khata and Settlement                                                */
/* -------------------------------------------------------------------------- */

/**
 * EVERY value in `TRANSACTION_TYPE` needs a discriminator registered here.
 *
 * Mongoose throws `Discriminator "X" not found for model "Transaction"` the first time a
 * posting uses a type that was declared in the enum but never registered — at runtime,
 * inside the transaction, as a 500. Declaring the type and forgetting the discriminator is
 * an easy omission; the guard below turns it into a boot-time failure instead.
 */
export interface SavingsTxnDoc extends TransactionDoc {
  savingsAccountId: Types.ObjectId;
  accountNo: string;
  memberName: string;
  operation: "DEPOSIT" | "WITHDRAWAL" | "INTEREST" | "BONUS" | "ADJUSTMENT";
}

export const SavingsTxn = Transaction.discriminator<SavingsTxnDoc>(
  TRANSACTION_TYPE.SAVINGS,
  new Schema<SavingsTxnDoc>({
    savingsAccountId: { type: Schema.Types.ObjectId, ref: "SavingsAccount", required: true },
    accountNo: { type: String, required: true },
    memberName: { type: String, required: true },
    operation: {
      type: String,
      enum: ["DEPOSIT", "WITHDRAWAL", "INTEREST", "BONUS", "ADJUSTMENT"],
      required: true,
    },
  }).index({ savingsAccountId: 1, date: -1 }, { name: "savings_account_date" }),
);

export interface SettlementTxnDoc extends TransactionDoc {
  settlementId?: Types.ObjectId | null;
  settlementNo?: string;
}

export const SettlementTxn = Transaction.discriminator<SettlementTxnDoc>(
  TRANSACTION_TYPE.SETTLEMENT,
  new Schema<SettlementTxnDoc>({
    settlementId: { type: Schema.Types.ObjectId, ref: "Settlement", default: null },
    settlementNo: { type: String },
  }),
);

/**
 * Boot-time completeness check.
 *
 * Runs on import, so a type added to the enum without a discriminator fails immediately
 * and loudly rather than at the moment somebody tries to post one.
 */
const registered = new Set(Object.keys(Transaction.discriminators ?? {}));
const missing = Object.values(TRANSACTION_TYPE).filter((t) => !registered.has(t));
if (missing.length > 0) {
  throw new Error(
    `Transaction types declared without a discriminator: ${missing.join(", ")}. ` +
      `Register them in models/discriminators.ts, or posting one will fail at runtime.`,
  );
}
