import { Schema, model, type Document, type Types } from "mongoose";
import {
  APPROVAL_STATUS,
  PAYMENT_MODE,
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
  type ApprovalStatus,
  type PaymentMode,
  type TransactionStatus,
  type TransactionType,
} from "@amiri/shared";
import {
  actorField, attachmentSchema, baseSchemaOptions,
  businessDateField, moneyField, noteSchema,
} from "./fields.js";

/**
 * The journal header — one document per business event.
 *
 * A single collection with Mongoose discriminators per type, rather than eight separate
 * collections. That choice buys three things that matter daily:
 *
 *   • one numbering sequence and one uniqueness guarantee across all vouchers
 *   • the DayBook is `find({ branchId, date })` — not an eight-way union
 *   • status, approval, attachments, reversal and audit behave identically everywhere
 *
 * Type-specific fields live on the discriminator schemas registered in Phase 3.
 */
export interface TransactionDoc extends Document<Types.ObjectId> {
  txnNo: string;
  type: TransactionType;
  date: Date;
  /**
   * The branch that transacted.
   *
   * Null on an organisation-level posting — the opening balance of a shared account or
   * party. Those belong to the business, not to an office, and stamping one with an
   * arbitrary branch would put a figure nobody at that branch recognises on its books.
   */
  branchId?: Types.ObjectId | null;
  status: TransactionStatus;

  /**
   * The three money fields, always all three, always separate (§18).
   *
   *   gross  — the headline amount the parties agreed
   *   charge — commission, bank fee, deduction
   *   net    — what actually settles
   *
   * A charge NEVER silently modifies the gross. A distributor being charged 1.75% on
   * ₹1,00,000 sees ₹1,00,000 / ₹1,750 / ₹98,250, not a mysterious ₹98,250.
   */
  grossAmount: number;
  chargeAmount: number;
  netAmount: number;

  paymentMode?: PaymentMode;
  referenceNo?: string;
  narration?: string;

  partyId?: Types.ObjectId | null;
  /** Ledger accounts touched, denormalised for filtering the DayBook without a join. */
  accountIds: Types.ObjectId[];

  attachments: Array<{ filename: string; url: string; mimeType: string; size: number }>;
  notes: Array<{ text: string; createdBy: Types.ObjectId; createdAt: Date }>;

  approvals: Array<{
    tier: string;
    status: ApprovalStatus;
    actedBy?: Types.ObjectId;
    actedAt?: Date;
    comment?: string;
  }>;
  approvedBy?: Types.ObjectId | null;
  approvedAt?: Date | null;

  postedAt?: Date | null;
  periodId?: Types.ObjectId | null;

  /** Set on a reversal document, pointing at what it cancels. */
  reversalOf?: Types.ObjectId | null;
  /** Set on the original when a reversal is posted against it. */
  reversedBy?: Types.ObjectId | null;
  reversalReason?: string;

  /**
   * The postings that WILL be written when this transaction is approved (§27).
   *
   * Populated only while status is PENDING, and cleared on approval. A transaction
   * awaiting sign-off has no ledger entries at all — money nobody authorised must not
   * move, not even briefly. Storing the lines rather than recomputing them means the
   * approver signs off exactly what the submitter saw, even if a charge rule changes in
   * between.
   */
  pendingLines: Array<{
    ledgerAccountId: Types.ObjectId;
    direction: string;
    amount: number;
    narration?: string;
  }>;

  fiscalYear: number;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

interface PendingLineShape {
  ledgerAccountId: Types.ObjectId;
  direction: string;
  amount: number;
  narration?: string;
}

const approvalStepSchema = new Schema(
  {
    tier: { type: String, required: true },
    status: { type: String, enum: Object.values(APPROVAL_STATUS), default: APPROVAL_STATUS.PENDING },
    actedBy: actorField(),
    actedAt: { type: Date },
    comment: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const transactionSchema = new Schema<TransactionDoc>(
  {
    txnNo: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: Object.values(TRANSACTION_TYPE), required: true, index: true },
    date: businessDateField(true),
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null, index: true },

    status: {
      type: String,
      enum: Object.values(TRANSACTION_STATUS),
      default: TRANSACTION_STATUS.DRAFT,
      index: true,
    },

    grossAmount: moneyField({ required: true, nonNegative: true }),
    chargeAmount: moneyField({ default: 0, nonNegative: true }),
    netAmount: moneyField({ required: true, nonNegative: true }),

    paymentMode: { type: String, enum: Object.values(PAYMENT_MODE) },
    referenceNo: { type: String, trim: true, maxlength: 80, index: true },
    narration: { type: String, trim: true, maxlength: 1000 },

    partyId: { type: Schema.Types.ObjectId, ref: "Party", default: null, index: true },
    accountIds: [{ type: Schema.Types.ObjectId, ref: "LedgerAccount", index: true }],

    attachments: { type: [attachmentSchema], default: [] },
    notes: { type: [noteSchema], default: [] },

    approvals: { type: [approvalStepSchema], default: [] },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },

    postedAt: { type: Date, default: null },
    periodId: { type: Schema.Types.ObjectId, ref: "FinancialPeriod", default: null },

    reversalOf: { type: Schema.Types.ObjectId, ref: "Transaction", default: null, index: true },
    reversedBy: { type: Schema.Types.ObjectId, ref: "Transaction", default: null },
    reversalReason: { type: String, trim: true, maxlength: 1000 },

    pendingLines: {
      type: [
        new Schema<PendingLineShape>(
          {
            ledgerAccountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
            direction: { type: String, enum: ["DEBIT", "CREDIT"], required: true },
            amount: moneyField({ required: true, positive: true }),
            narration: { type: String, trim: true, maxlength: 500 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    fiscalYear: { type: Number, required: true, index: true },

    createdBy: actorField(true),
    updatedBy: actorField(),
  },
  {
    ...baseSchemaOptions(),
    discriminatorKey: "type",
  },
);

/**
 * Arithmetic invariant, enforced at the model layer.
 *
 * The net must differ from the gross by EXACTLY the charge, in one direction or the
 * other — because a charge either comes out of the amount or is paid on top of it:
 *
 *     net = gross − charge     the charge is DEDUCTED (the counterparty gets less)
 *     net = gross + charge     the charge is ADDED    (we pay the fee on top)
 *
 * The check used to demand `gross − charge` unconditionally, which silently accepted a
 * wrong header on the second shape: a ₹50,000 payment out with a ₹750 fee we bear moves
 * ₹50,750 through the bank, yet the transaction recorded ₹49,250 as its net — a number
 * that matched none of its own ledger entries. `chargeEffect` in @amiri/shared decides the
 * direction; this is the guard that stops a service getting it wrong again.
 */
transactionSchema.pre("validate", function checkAmounts(next) {
  if (Math.abs(this.netAmount - this.grossAmount) !== this.chargeAmount) {
    next(
      new Error(
        `Transaction amounts do not reconcile: net (${this.netAmount}) must be gross ` +
          `(${this.grossAmount}) either minus or plus the charge (${this.chargeAmount}), ` +
          `depending on whether the charge is deducted from the amount or paid on top of it.`,
      ),
    );
    return;
  }
  next();
});

/* Indexes, named after the screen each one serves. */
transactionSchema.index({ branchId: 1, date: -1, _id: -1 }); // DayBook
transactionSchema.index({ branchId: 1, status: 1, date: -1 }); // approval queue
transactionSchema.index({ branchId: 1, type: 1, date: -1 }); // per-type listings
transactionSchema.index({ partyId: 1, date: -1 }); // party statement
transactionSchema.index({ fiscalYear: 1, type: 1 });
transactionSchema.index({ narration: "text", referenceNo: "text" }, { name: "txn_search" });

export const Transaction = model<TransactionDoc>("Transaction", transactionSchema);
