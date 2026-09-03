import { z } from "zod";
import {
  PAYMENT_MODE,
  RECORD_STATUS,
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
} from "../enums.js";
import {
  attachmentInput,
  businessDate,
  dateRange,
  listQuery,
  nonNegativeMoney,
  note,
  objectId,
  optionalObjectId,
  positiveMoney,
  reason as reasonSchema,
} from "./common.js";

/**
 * Business transaction contracts.
 *
 * A note on `accountId`: the client sends the id of a BankAccount or a CashAccount and the
 * server resolves it to a ledger account. Clients never reference a ledger account
 * directly — the chart of accounts is an internal structure, and letting an API caller
 * name an arbitrary ledger account would let them post against equity or suspense.
 */

const baseTransactionFields = {
  date: businessDate,
  branchId: objectId,
  referenceNo: z.string().trim().max(80).optional(),
  narration: z.string().trim().max(1000).optional(),
  attachments: z.array(attachmentInput).max(10).default([]),
};

/* -------------------------------------------------------------------------- */
/* Payment In (§14)                                                           */
/* -------------------------------------------------------------------------- */

export const createPaymentInSchema = z.object({
  ...baseTransactionFields,
  partyId: objectId,
  /** BankAccount or CashAccount receiving the money. */
  accountId: objectId,
  amount: positiveMoney,
  paymentMode: z.nativeEnum(PAYMENT_MODE),
  /** Optional charge rule; the charge is computed server-side, never sent by the client. */
  chargeRuleId: optionalObjectId,
  /** Manual charge override, used when no rule fits. Requires a narration. */
  manualCharge: nonNegativeMoney.optional(),
  notes: note(1000),
});
export type CreatePaymentInInput = z.infer<typeof createPaymentInSchema>;

/* -------------------------------------------------------------------------- */
/* Payment Out (§15)                                                          */
/* -------------------------------------------------------------------------- */

export const createPaymentOutSchema = z.object({
  ...baseTransactionFields,
  partyId: objectId,
  /** BankAccount or CashAccount the money leaves from. */
  accountId: objectId,
  amount: positiveMoney,
  paymentMode: z.nativeEnum(PAYMENT_MODE),
  chargeRuleId: optionalObjectId,
  manualCharge: nonNegativeMoney.optional(),
  notes: note(1000),
});
export type CreatePaymentOutInput = z.infer<typeof createPaymentOutSchema>;

/* -------------------------------------------------------------------------- */
/* Bank transfer (§8)                                                         */
/* -------------------------------------------------------------------------- */

export const createBankTransferSchema = z
  .object({
    ...baseTransactionFields,
    sourceAccountId: objectId,
    destinationAccountId: objectId,
    amount: positiveMoney,
    paymentMode: z.nativeEnum(PAYMENT_MODE).default("NEFT"),
    chargeRuleId: optionalObjectId,
    manualCharge: nonNegativeMoney.optional(),
    notes: note(1000),
  })
  .refine((v) => v.sourceAccountId !== v.destinationAccountId, {
    message: "The source and destination accounts must be different",
    path: ["destinationAccountId"],
  });
export type CreateBankTransferInput = z.infer<typeof createBankTransferSchema>;

/* -------------------------------------------------------------------------- */
/* Expense (§16)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * An itemised expense line.
 *
 * `amount` is sent rather than derived from qty × rate, because a supplier invoice may
 * round its own line total. The server checks that the parts agree and rejects a line
 * that does not — silently trusting either side would let an invoice be recorded for an
 * amount nobody entered.
 */
export const expenseItemSchema = z.object({
  description: z.string().trim().min(1, "Describe the item").max(200),
  quantity: z.number().positive("Quantity must be greater than zero").default(1),
  unitPrice: nonNegativeMoney,
  amount: nonNegativeMoney,
});
export type ExpenseItemInput = z.infer<typeof expenseItemSchema>;

export const createExpenseSchema = z
  .object({
    ...baseTransactionFields,
    categoryId: objectId,
    /** The vendor, when the expense is owed to or paid to a party. */
    partyId: optionalObjectId,
    /** Account the expense is paid from. Omit to book it as payable to the party. */
    accountId: optionalObjectId,

    amount: positiveMoney,
    taxAmount: nonNegativeMoney.default(0),
    paymentMode: z.nativeEnum(PAYMENT_MODE).optional(),

    invoiceNo: z.string().trim().max(60).optional(),
    invoiceDate: businessDate.optional(),

    items: z.array(expenseItemSchema).max(50).default([]),
    notes: note(1000),
  })
  .superRefine((v, ctx) => {
    // An expense must either be paid from an account or booked against a party. With
    // neither, there is nothing to credit and the entry cannot balance.
    if (!v.accountId && !v.partyId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accountId"],
        message: "Choose an account to pay from, or a party to book this against",
      });
    }
    if (v.items.length > 0) {
      const itemTotal = v.items.reduce((sum, i) => sum + i.amount, 0);
      if (itemTotal !== v.amount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["amount"],
          message: `The items total ${itemTotal / 100} but the expense amount is ${v.amount / 100}`,
        });
      }
    }
  });
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .max(24)
    .regex(/^[A-Z0-9_-]*$/, "Use letters, digits, hyphens and underscores")
    .optional()
    .transform((v) => (v ? v : undefined)),
  description: z.string().trim().max(300).optional(),
  /** Sub-heads: "Panel Expense" beneath "Operations". */
  parentId: optionalObjectId,
  status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
});
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

/* -------------------------------------------------------------------------- */
/* Income (§17)                                                               */
/* -------------------------------------------------------------------------- */

export const createIncomeSchema = z.object({
  ...baseTransactionFields,
  headId: objectId,
  partyId: optionalObjectId,
  accountId: objectId,
  amount: positiveMoney,
  paymentMode: z.nativeEnum(PAYMENT_MODE),
  notes: note(1000),
});
export type CreateIncomeInput = z.infer<typeof createIncomeSchema>;

export const createIncomeHeadSchema = createExpenseCategorySchema;
export type CreateIncomeHeadInput = z.infer<typeof createIncomeHeadSchema>;

/* -------------------------------------------------------------------------- */
/* Reversal (§28)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reversal, never deletion.
 *
 * The original transaction stays visible forever and gains a link to its reversal. The
 * reason is mandatory and lands verbatim in the audit trail — "why was ₹9,50,000 undone"
 * must be answerable years later.
 */
export const reverseTransactionSchema = z.object({
  reason: reasonSchema,
  /** Defaults to today. A back-dated reversal must land in an open period. */
  date: businessDate.optional(),
});
export type ReverseTransactionInput = z.infer<typeof reverseTransactionSchema>;

/* -------------------------------------------------------------------------- */
/* Listing                                                                    */
/* -------------------------------------------------------------------------- */

export const transactionQuerySchema = listQuery
  .extend({
    type: z.nativeEnum(TRANSACTION_TYPE).optional(),
    status: z.nativeEnum(TRANSACTION_STATUS).optional(),
    branchId: optionalObjectId,
    partyId: optionalObjectId,
    accountId: optionalObjectId,
    paymentMode: z.nativeEnum(PAYMENT_MODE).optional(),
    createdBy: optionalObjectId,
    minAmount: nonNegativeMoney.optional(),
    maxAmount: nonNegativeMoney.optional(),
  })
  .and(dateRange);
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;

export interface TransactionRow {
  id: string;
  txnNo: string;
  type: string;
  typeLabel: string;
  date: string;
  /**
   * The branch that transacted. Null on an organisation-level posting — the opening
   * balance of a party or an account, which belongs to the business rather than to any
   * one office.
   */
  branch: { id: string; name: string; code: string } | null;
  party: { id: string; name: string; code: string } | null;
  /** Human name of the counter account: "HDFC ••7890", "Cash — Main Counter". */
  accountLabel: string;
  paymentMode: string | null;
  referenceNo?: string;
  narration?: string;

  grossAmount: number;
  chargeAmount: number;
  netAmount: number;
  /** Signed for the DayBook's Money In / Money Out columns. */
  moneyIn: number;
  moneyOut: number;

  status: string;
  isReversal: boolean;
  reversedBy: string | null;
  reversalOf: string | null;

  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

/** Everything the details drawer shows (§46). */
export interface TransactionDetail extends TransactionRow {
  entries: Array<{
    id: string;
    accountName: string;
    accountCode: string;
    direction: string;
    debit: number;
    credit: number;
    runningBalance: number;
  }>;
  attachments: Array<{ filename: string; url: string; mimeType: string; size: number }>;
  notes: Array<{ text: string; createdBy: string; createdAt: string }>;
  timeline: Array<{
    action: string;
    at: string;
    by: string;
    role?: string;
    reason?: string;
  }>;
  items?: ExpenseItemInput[];
  chargeRule?: { id: string; name: string; basis: string } | null;
  approvedBy: { id: string; name: string } | null;
  postedAt: string | null;
}
