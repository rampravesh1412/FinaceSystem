import { z } from "zod";
import { ADJUSTMENT_TYPE, PAYMENT_MODE, type AgingBucketKey, type KhataDirection } from "../enums.js";
import {
  booleanFlag,
  businessDate,
  dateRange,
  listQuery,
  money,
  objectId,
  optionalObjectId,
  positiveMoney,
  reason as reasonSchema,
} from "./common.js";

/**
 * Digital Khata (§11) and Credit (§12).
 *
 * The Khata is a VIEW over the party's ledger account, not a second store. §11's formula
 * — opening + given + taken + adjustments = current balance — is precisely what the ledger
 * already computes. A parallel khata table would produce a second number that drifts from
 * the first, and then nobody could say which one the party actually owes.
 *
 * What this file adds is the vocabulary: LENA HAI / DENA HAI, "given" and "taken", and the
 * aging buckets that turn a balance into a collections worklist.
 */

/* -------------------------------------------------------------------------- */
/* Khata statement                                                            */
/* -------------------------------------------------------------------------- */

export const khataQuerySchema = listQuery.and(dateRange);
export type KhataQuery = z.infer<typeof khataQuerySchema>;

export interface KhataEntry {
  id: string;
  date: string;
  txnNo: string;
  transactionType: string;
  typeLabel: string;
  narration?: string;
  /** They owe us more — we gave. */
  given: number;
  /** They owe us less — we took. */
  taken: number;
  balance: number;
  direction: KhataDirection;
  createdBy: string | null;
  isReversed: boolean;
}

export interface KhataStatement {
  party: {
    id: string;
    name: string;
    code: string;
    type: string;
    mobile?: string;
  };

  /** Balance immediately before the window. Without it a filtered statement starts at zero. */
  openingBalance: number;
  openingDirection: KhataDirection;

  totalGiven: number;
  totalTaken: number;

  closingBalance: number;
  closingDirection: KhataDirection;
  /** "₹50,000 Lena Hai" — the sentence a shopkeeper actually reads. */
  closingLabel: string;

  creditLimit: number;
  availableCredit: number;
  isOverLimit: boolean;

  entries: KhataEntry[];
  from: string | null;
  to: string | null;
  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Adjustments (§25)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A balance correction.
 *
 * Never a direct write to a balance — an adjustment is a posted, double-entry transaction
 * against a counter account, exactly like every other movement. `reason` is mandatory and
 * lands verbatim in the audit trail, because an unexplained balance change is the single
 * thing §25 and §62 exist to prevent.
 */
export const createAdjustmentSchema = z
  .object({
    date: businessDate,
    branchId: objectId,
    adjustmentType: z.nativeEnum(ADJUSTMENT_TYPE),

    /** Exactly one target must be named. */
    partyId: optionalObjectId,
    accountId: optionalObjectId,

    /**
     * Signed. POSITIVE increases the target's balance, NEGATIVE decreases it.
     *
     * For a party that reads in Khata terms: positive means they owe us more.
     */
    amount: money.refine((v) => v !== 0, "An adjustment of zero would change nothing"),

    /**
     * Where the other side lands. Omit to use the suspense account, which is the correct
     * home for a difference that is not yet explained (§23) — it keeps the books balanced
     * while making the unexplained amount impossible to overlook.
     */
    counterAccountId: optionalObjectId,

    reason: reasonSchema,
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((v) => Boolean(v.partyId) !== Boolean(v.accountId), {
    message: "Adjust either a party or an account, not both",
    path: ["partyId"],
  });
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

/* -------------------------------------------------------------------------- */
/* Credit and aging (§12)                                                     */
/* -------------------------------------------------------------------------- */

export const creditQuerySchema = listQuery.extend({
  /** Only parties past their limit. */
  overLimit: booleanFlag.optional(),
  /** Only parties with something overdue. */
  overdueOnly: booleanFlag.optional(),
  bucket: z.enum(["current", "b31_60", "b61_90", "b90plus"]).optional(),
});
export type CreditQuery = z.infer<typeof creditQuerySchema>;

export interface AgingRow {
  partyId: string;
  name: string;
  code: string;
  type: string;
  mobile?: string;

  balance: number;
  creditLimit: number;
  creditDays: number;
  availableCredit: number;
  isOverLimit: boolean;

  /** Outstanding split by how long it has been owed. Sums to `balance` when positive. */
  buckets: Record<AgingBucketKey, number>;
  /** Days since the oldest unsettled amount fell due. Zero when nothing is overdue. */
  daysOverdue: number;
  overdueAmount: number;
  /** When the current balance falls due, from the oldest open item plus credit days. */
  dueDate: string | null;
  lastTransactionAt: string | null;
}

export interface CreditSummary {
  totalOutstanding: number;
  totalOverdue: number;
  dueToday: number;
  dueThisWeek: number;
  buckets: Record<AgingBucketKey, number>;
  partyCount: number;
  overLimitCount: number;
  topDebtors: Array<{ id: string; name: string; balance: number }>;
  topCreditors: Array<{ id: string; name: string; balance: number }>;
}

/* -------------------------------------------------------------------------- */
/* Bachat Khata — savings (§13)                                               */
/* -------------------------------------------------------------------------- */

export const createSavingsAccountSchema = z.object({
  memberName: z.string().trim().min(2, "Member name is required").max(140),
  /** Link to an existing party when the member is already on the books. */
  partyId: optionalObjectId,
  branchId: objectId,
  mobile: z
    .union([z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a 10-digit mobile number"), z.literal("")])
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Annual interest rate in basis points. 6.5% = 650. */
  interestRateBps: z.number().int().min(0).max(10_000).default(0),
  openingBalance: money.default(0).refine((v) => v >= 0, "A savings account cannot open in deficit"),
  openingDate: businessDate.optional(),
  notes: z.string().trim().max(500).optional(),
});
export type CreateSavingsAccountInput = z.infer<typeof createSavingsAccountSchema>;

export const savingsTransactionSchema = z.object({
  date: businessDate,
  savingsAccountId: objectId,
  operation: z.enum(["DEPOSIT", "WITHDRAWAL", "INTEREST", "BONUS"]),
  amount: positiveMoney,
  /** Where the cash physically moves. Not needed for INTEREST or BONUS, which are accrued. */
  accountId: optionalObjectId,
  paymentMode: z.nativeEnum(PAYMENT_MODE).optional(),
  referenceNo: z.string().trim().max(80).optional(),
  narration: z.string().trim().max(500).optional(),
});
export type SavingsTransactionInput = z.infer<typeof savingsTransactionSchema>;

export interface SavingsAccountSummary {
  id: string;
  accountNo: string;
  memberName: string;
  mobile?: string;
  branch: { id: string; name: string; code: string };
  balance: number;
  interestRateBps: number;
  /**
   * The linked ledger account, as every other balance-bearing summary carries.
   *
   * Consistency matters here: a caller that has a bank account, a cash drawer or a party
   * can always reach its ledger account from the summary, and a savings account being the
   * one exception is a trap rather than a saving.
   */
  ledgerAccountId: string;
  status: string;
  lastTransactionAt: string | null;
  openedAt: string;
}

export interface SavingsSummary {
  totalSavings: number;
  todayCollection: number;
  todayWithdrawal: number;
  memberCount: number;
  activeCount: number;
}

/* -------------------------------------------------------------------------- */
/* Settlement (§24)                                                           */
/* -------------------------------------------------------------------------- */

export const createSettlementSchema = z
  .object({
    date: businessDate,
    branchId: objectId,
    kind: z.enum(["PARTY", "BANK", "BRANCH"]),

    partyId: optionalObjectId,
    sourceAccountId: optionalObjectId,
    destinationAccountId: optionalObjectId,

    amount: positiveMoney,
    chargeRuleId: optionalObjectId,
    manualCharge: money.default(0).refine((v) => v >= 0, "A charge cannot be negative"),

    referenceNo: z.string().trim().max(80).optional(),
    narration: z.string().trim().max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "PARTY" && !v.partyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partyId"], message: "Choose the party to settle" });
    }
    if (v.kind !== "PARTY" && (!v.sourceAccountId || !v.destinationAccountId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destinationAccountId"],
        message: "A bank or branch settlement needs both a source and a destination",
      });
    }
  });
export type CreateSettlementInput = z.infer<typeof createSettlementSchema>;

export interface SettlementRow {
  id: string;
  settlementNo: string;
  date: string;
  kind: string;
  party: { id: string; name: string } | null;
  sourceLabel: string;
  destinationLabel: string;
  amount: number;
  charges: number;
  netAmount: number;
  /**
   * What has actually been paid against `netAmount` so far.
   *
   * Carried on the row rather than left implicit in the status, because PARTIAL alone
   * does not tell an operator whether ₹5,000 or ₹4,95,000 is still outstanding.
   */
  settledAmount: number;
  status: string;
  approvedBy: string | null;
  createdBy: string | null;
}

/* -------------------------------------------------------------------------- */
/* Reconciliation (§23)                                                       */
/* -------------------------------------------------------------------------- */

export const startReconciliationSchema = z.object({
  bankAccountId: objectId,
  from: businessDate,
  to: businessDate,
  /** The closing balance printed on the bank's own statement. */
  statementBalance: money,
});
export type StartReconciliationInput = z.infer<typeof startReconciliationSchema>;

/** One line lifted from the bank statement, to be matched against the ledger. */
export const statementLineSchema = z.object({
  date: businessDate,
  description: z.string().trim().max(300),
  referenceNo: z.string().trim().max(80).optional(),
  /** Signed: positive is a credit on the bank statement (money in). */
  amount: money.refine((v) => v !== 0, "A statement line of zero is not meaningful"),
});
export type StatementLineInput = z.infer<typeof statementLineSchema>;

export const importStatementSchema = z.object({
  lines: z.array(statementLineSchema).min(1, "Add at least one statement line").max(2000),
});
export type ImportStatementInput = z.infer<typeof importStatementSchema>;

export const matchLineSchema = z.object({
  lineId: objectId,
  ledgerEntryId: objectId.nullable(),
  status: z
    .enum(["MATCHED", "UNMATCHED", "MISSING_IN_SYSTEM", "MISSING_IN_BANK", "DUPLICATE", "NEEDS_REVIEW"])
    .optional(),
});
export type MatchLineInput = z.infer<typeof matchLineSchema>;

export interface ReconciliationSummary {
  id: string;
  bankAccount: { id: string; label: string };
  from: string;
  to: string;
  /** What the bank says. */
  statementBalance: number;
  /** What our ledger says, computed as at `to`. */
  systemBalance: number;
  /**
   * statement − system. NEVER auto-corrected: §62 requires that the difference is shown
   * and investigated, not silently absorbed.
   */
  difference: number;
  status: string;
  counts: {
    matched: number;
    unmatched: number;
    missingInSystem: number;
    missingInBank: number;
    duplicate: number;
    needsReview: number;
  };
  completedAt: string | null;
  createdAt: string;
}

export interface ReconciliationLineRow {
  id: string;
  date: string;
  description: string;
  referenceNo?: string;
  amount: number;
  status: string;
  ledgerEntry: {
    id: string;
    txnNo: string;
    amount: number;
    date: string;
    narration?: string;
  } | null;
  /** Ledger entries the matcher thinks this line could be, best first. */
  suggestions: Array<{ id: string; txnNo: string; amount: number; date: string; confidence: number }>;
}
