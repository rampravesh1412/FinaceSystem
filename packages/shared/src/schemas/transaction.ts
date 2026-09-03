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
  /**
   * Optional. The account already says how the money moved — a receipt into the cash
   * drawer was cash, one into a bank account came by transfer — so the mode is recorded
   * when it is known and left off when it adds nothing.
   */
  paymentMode: z.nativeEnum(PAYMENT_MODE).optional(),
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
  /** Optional — see `createPaymentInSchema`. */
  paymentMode: z.nativeEnum(PAYMENT_MODE).optional(),
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
/* Editing a posted payment                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Change a Payment In or Payment Out that has already posted.
 *
 * Every field is editable, but they are not all editable the same way, and the split is
 * the whole design:
 *
 *   MONEY FIELDS — date, amount, party, account, charge
 *     Cannot be rewritten. Saving one reverses the original and posts a corrected
 *     replacement, atomically and linked both ways. The original stays on the books,
 *     struck through, next to the reversal that cancels it and the version that replaced
 *     it. That is the only way to change an amount and still be able to answer "why is
 *     this balance what it is" from the entries alone.
 *
 *   LABEL FIELDS — reference no, narration, payment mode, notes
 *     Carry no money and move no balance, so they are updated in place. Reversing a
 *     transaction to fix a typo in a reference number would be noise in the ledger.
 *
 * `reason` is mandatory either way. An unexplained change to a posted transaction is
 * exactly what §25 and §62 exist to prevent, and it is what the audit row quotes.
 */
export const updatePaymentSchema = z.object({
  // Money fields — any of these triggers reverse-and-repost.
  date: businessDate.optional(),
  amount: positiveMoney.optional(),
  partyId: optionalObjectId,
  accountId: optionalObjectId,
  chargeRuleId: optionalObjectId,
  manualCharge: nonNegativeMoney.optional(),

  // Label fields — updated in place.
  paymentMode: z.nativeEnum(PAYMENT_MODE).optional(),
  referenceNo: z.string().trim().max(80).optional(),
  narration: z.string().trim().max(1000).optional(),
  notes: note(1000),

  reason: reasonSchema,
});
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

/** Which fields, if changed, force a reverse-and-repost rather than an in-place update. */
export const PAYMENT_MONEY_FIELDS = [
  "date",
  "amount",
  "partyId",
  "accountId",
  "chargeRuleId",
  "manualCharge",
] as const;

/** What the server did with an edit, so the UI can say so plainly. */
export interface PaymentEditResult {
  /** `REPOSTED` when the money changed; `UPDATED` when only labels did. */
  outcome: "REPOSTED" | "UPDATED";
  transaction: { id: string; txnNo: string };
  /** Present on a repost: the original, now reversed, and the reversal that cancels it. */
  replaced?: { id: string; txnNo: string };
  reversal?: { id: string; txnNo: string };
}

/* -------------------------------------------------------------------------- */
/* Account heads                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rename, re-parent or RETIRE an expense or income head.
 *
 * Retiring is what `status` is for: a head with history cannot be deleted, because every
 * posting made under it would lose the account it was booked to. Setting it INACTIVE takes
 * it out of the pickers for new entries and leaves every past entry exactly where it is.
 */
export const updateAccountHeadSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(80).optional(),
  description: z.string().trim().max(300).optional(),
  parentId: optionalObjectId,
  status: z.nativeEnum(RECORD_STATUS).optional(),
});
export type UpdateAccountHeadInput = z.infer<typeof updateAccountHeadSchema>;

/* -------------------------------------------------------------------------- */
/* Listing                                                                    */
/* -------------------------------------------------------------------------- */

export const transactionQuerySchema = listQuery
  .extend({
    type: z.nativeEnum(TRANSACTION_TYPE).optional(),
    status: z.nativeEnum(TRANSACTION_STATUS).optional(),
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

  /**
   * The edit chain. `supersededBy` is set on a transaction that was corrected;
   * `supersedes` on the correction. A row carrying either is part of an edit rather than a
   * plain reversal, and the UI says so — the two look identical without this.
   */
  supersededBy: string | null;
  supersedes: string | null;

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
  /**
   * Who did what to this transaction, oldest first, straight from the audit log.
   *
   * `changedFields` and the before/after snapshots come through so an edit reads as
   * "Anita changed amount and party, because …" rather than an unexplained "UPDATE".
   */
  timeline: Array<{
    action: string;
    at: string;
    by: string;
    role?: string;
    reason?: string;
    changedFields?: string[];
    oldValue?: unknown;
    newValue?: unknown;
  }>;
  /** The corrected version of this transaction, and the one it corrected. */
  supersededByTxn: { id: string; txnNo: string } | null;
  supersedesTxn: { id: string; txnNo: string } | null;
  items?: ExpenseItemInput[];
  chargeRule?: { id: string; name: string; basis: string } | null;
  approvedBy: { id: string; name: string } | null;
  postedAt: string | null;
}
