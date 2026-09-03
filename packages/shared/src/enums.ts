/**
 * Domain vocabulary shared by the API and the web app.
 *
 * These are `as const` objects rather than TS `enum`s so they survive `isolatedModules`,
 * erase cleanly to plain strings in the database, and can be iterated to build select
 * options in the UI without a reverse-mapping dance.
 */

/* -------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a ledger account *is*. Every balance-bearing entity in the system — a bank
 * account, the cash drawer, a party, an expense head — is one row in `ledgeraccounts`
 * carrying one of these kinds. That uniformity is what makes the trial balance and
 * balance sheet fall out of a single aggregation.
 */
export const ACCOUNT_KIND = {
  BANK: "BANK",
  CASH: "CASH",
  PARTY: "PARTY",
  EXPENSE: "EXPENSE",
  INCOME: "INCOME",
  SAVINGS: "SAVINGS",
  CHARGE: "CHARGE",
  EQUITY: "EQUITY",
  SUSPENSE: "SUSPENSE",
} as const;
export type AccountKind = (typeof ACCOUNT_KIND)[keyof typeof ACCOUNT_KIND];

/** The five classical account classes. Determines the normal balance side. */
export const ACCOUNT_CLASS = {
  ASSET: "ASSET",
  LIABILITY: "LIABILITY",
  EQUITY: "EQUITY",
  INCOME: "INCOME",
  EXPENSE: "EXPENSE",
} as const;
export type AccountClass = (typeof ACCOUNT_CLASS)[keyof typeof ACCOUNT_CLASS];

export const ACCOUNT_KIND_CLASS: Record<AccountKind, AccountClass> = {
  BANK: "ASSET",
  CASH: "ASSET",
  // A party account swings between asset (they owe us) and liability (we owe them).
  // It is classified as ASSET so debits increase it, and the sign of the balance tells
  // you which side of the relationship you are on. See `PartyBalanceDirection`.
  PARTY: "ASSET",
  EXPENSE: "EXPENSE",
  INCOME: "INCOME",
  SAVINGS: "LIABILITY",
  CHARGE: "EXPENSE",
  EQUITY: "EQUITY",
  SUSPENSE: "ASSET",
};

export const DIRECTION = {
  DEBIT: "DEBIT",
  CREDIT: "CREDIT",
} as const;
export type Direction = (typeof DIRECTION)[keyof typeof DIRECTION];

/**
 * Which side increases the balance of an account class.
 * ASSET and EXPENSE grow on the debit side; LIABILITY, EQUITY and INCOME on the credit side.
 */
export const NORMAL_SIDE: Record<AccountClass, Direction> = {
  ASSET: "DEBIT",
  EXPENSE: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  INCOME: "CREDIT",
};

/** +1 if the entry increases the account's balance, -1 if it decreases it. */
export function signFor(accountClass: AccountClass, direction: Direction): 1 | -1 {
  return NORMAL_SIDE[accountClass] === direction ? 1 : -1;
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

export const TRANSACTION_TYPE = {
  PAYMENT_IN: "PAYMENT_IN",
  PAYMENT_OUT: "PAYMENT_OUT",
  BANK_TRANSFER: "BANK_TRANSFER",
  EXPENSE: "EXPENSE",
  INCOME: "INCOME",
  ADJUSTMENT: "ADJUSTMENT",
  SETTLEMENT: "SETTLEMENT",
  SAVINGS: "SAVINGS",
  OPENING_BALANCE: "OPENING_BALANCE",
} as const;
export type TransactionType = (typeof TRANSACTION_TYPE)[keyof typeof TRANSACTION_TYPE];

export const TRANSACTION_TYPE_LABEL: Record<TransactionType, string> = {
  PAYMENT_IN: "Payment In",
  PAYMENT_OUT: "Payment Out",
  BANK_TRANSFER: "Bank to Bank",
  EXPENSE: "Expense",
  INCOME: "Income",
  ADJUSTMENT: "Adjustment",
  SETTLEMENT: "Settlement",
  SAVINGS: "Bachat Khata",
  OPENING_BALANCE: "Opening Balance",
};

/**
 * Document number prefixes. `EXP-2026-000001`, `BANK-TRF-2026-000001`, and so on.
 * The fiscal year and a zero-padded, gap-free sequence are appended by the numbering
 * service using an atomic counter.
 */
export const TXN_PREFIX: Record<TransactionType, string> = {
  PAYMENT_IN: "PAY-IN",
  PAYMENT_OUT: "PAY-OUT",
  BANK_TRANSFER: "BANK-TRF",
  EXPENSE: "EXP",
  INCOME: "INC",
  ADJUSTMENT: "ADJ",
  SETTLEMENT: "SET",
  SAVINGS: "SAV",
  OPENING_BALANCE: "OPN",
};

/** Prefix for the mirror document created by a reversal. `REV-2026-000001`. */
export const REVERSAL_PREFIX = "REV";

export const TRANSACTION_STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  REVERSED: "REVERSED",
} as const;
export type TransactionStatus = (typeof TRANSACTION_STATUS)[keyof typeof TRANSACTION_STATUS];

/**
 * Legal status transitions. The service layer asserts against this map instead of
 * scattering `if (status === ...)` checks through controllers.
 *
 * Ledger entries are written on APPROVED -> COMPLETED and on no other edge. Nothing
 * before COMPLETED has touched a balance, which is why DRAFT and PENDING documents are
 * safely editable and COMPLETED ones are not.
 */
export const TRANSACTION_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
  DRAFT: ["PENDING", "COMPLETED", "CANCELLED"],
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: ["REVERSED"],
  REJECTED: ["DRAFT", "CANCELLED"],
  FAILED: ["PENDING", "CANCELLED"],
  CANCELLED: [],
  REVERSED: [],
};

export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return TRANSACTION_TRANSITIONS[from].includes(to);
}

/** Statuses whose entries are on the books and therefore affect balances and reports. */
export const POSTED_STATUSES: TransactionStatus[] = ["COMPLETED", "REVERSED"];

/** Statuses that must never be edited in place — correct them with a reversal instead. */
export const IMMUTABLE_STATUSES: TransactionStatus[] = ["COMPLETED", "REVERSED", "CANCELLED"];

/* -------------------------------------------------------------------------- */
/* Payment                                                                    */
/* -------------------------------------------------------------------------- */

export const PAYMENT_MODE = {
  CASH: "CASH",
  BANK_TRANSFER: "BANK_TRANSFER",
  UPI: "UPI",
  NEFT: "NEFT",
  RTGS: "RTGS",
  IMPS: "IMPS",
  CHEQUE: "CHEQUE",
  CARD: "CARD",
  OTHER: "OTHER",
} as const;
export type PaymentMode = (typeof PAYMENT_MODE)[keyof typeof PAYMENT_MODE];

export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank Transfer",
  UPI: "UPI",
  NEFT: "NEFT",
  RTGS: "RTGS",
  IMPS: "IMPS",
  CHEQUE: "Cheque",
  CARD: "Card",
  OTHER: "Other",
};

/** Modes that settle through a bank account rather than the cash drawer. */
export const BANK_MODES: PaymentMode[] = [
  "BANK_TRANSFER", "UPI", "NEFT", "RTGS", "IMPS", "CHEQUE", "CARD",
];

/* -------------------------------------------------------------------------- */
/* Parties                                                                    */
/* -------------------------------------------------------------------------- */

export const PARTY_TYPE = {
  CUSTOMER: "CUSTOMER",
  VENDOR: "VENDOR",
  DISTRIBUTOR: "DISTRIBUTOR",
  AGENT: "AGENT",
  EMPLOYEE: "EMPLOYEE",
  OTHER: "OTHER",
} as const;
export type PartyType = (typeof PARTY_TYPE)[keyof typeof PARTY_TYPE];

export const PARTY_TYPE_LABEL: Record<PartyType, string> = {
  CUSTOMER: "Customer",
  VENDOR: "Vendor",
  DISTRIBUTOR: "Distributor",
  AGENT: "Agent",
  EMPLOYEE: "Employee",
  OTHER: "Other",
};

/**
 * Which way a party balance points, in the Digital Khata's own vocabulary.
 *
 * A positive party balance means they owe us — LENA HAI ("to receive").
 * A negative balance means we owe them — DENA HAI ("to give").
 */
export const KHATA_DIRECTION = {
  LENA: "LENA",
  DENA: "DENA",
  CLEAR: "CLEAR",
} as const;
export type KhataDirection = (typeof KHATA_DIRECTION)[keyof typeof KHATA_DIRECTION];

export const KHATA_LABEL: Record<KhataDirection, string> = {
  LENA: "Lena Hai",
  DENA: "Dena Hai",
  CLEAR: "Clear",
};

export function khataDirection(balancePaise: number): KhataDirection {
  if (balancePaise > 0) return "LENA";
  if (balancePaise < 0) return "DENA";
  return "CLEAR";
}

/* -------------------------------------------------------------------------- */
/* Banking                                                                    */
/* -------------------------------------------------------------------------- */

export const BANK_ACCOUNT_TYPE = {
  CURRENT: "CURRENT",
  SAVINGS: "SAVINGS",
  OD: "OD",
  CC: "CC",
  WALLET: "WALLET",
  OTHER: "OTHER",
} as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPE)[keyof typeof BANK_ACCOUNT_TYPE];

export const RECON_LINE_STATUS = {
  MATCHED: "MATCHED",
  UNMATCHED: "UNMATCHED",
  MISSING_IN_SYSTEM: "MISSING_IN_SYSTEM",
  MISSING_IN_BANK: "MISSING_IN_BANK",
  DUPLICATE: "DUPLICATE",
  NEEDS_REVIEW: "NEEDS_REVIEW",
} as const;
export type ReconLineStatus = (typeof RECON_LINE_STATUS)[keyof typeof RECON_LINE_STATUS];

export const RECON_LINE_STATUS_LABEL: Record<ReconLineStatus, string> = {
  MATCHED: "Matched",
  UNMATCHED: "Unmatched",
  MISSING_IN_SYSTEM: "Missing in System",
  MISSING_IN_BANK: "Missing in Bank",
  DUPLICATE: "Duplicate",
  NEEDS_REVIEW: "Needs Review",
};

/* -------------------------------------------------------------------------- */
/* Charges                                                                    */
/* -------------------------------------------------------------------------- */

export const CHARGE_TYPE = {
  PERCENTAGE: "PERCENTAGE",
  FIXED: "FIXED",
  TIERED: "TIERED",
} as const;
export type ChargeType = (typeof CHARGE_TYPE)[keyof typeof CHARGE_TYPE];

/** Who absorbs the charge — it changes which side of the entry the charge lands on. */
export const CHARGE_BEARER = {
  /** We pay it; it is our expense and reduces the source account by more than the gross. */
  SELF: "SELF",
  /** The party pays it; the gross is reduced and the charge becomes our income. */
  PARTY: "PARTY",
} as const;
export type ChargeBearer = (typeof CHARGE_BEARER)[keyof typeof CHARGE_BEARER];

/* -------------------------------------------------------------------------- */
/* Adjustments                                                                */
/* -------------------------------------------------------------------------- */

export const ADJUSTMENT_TYPE = {
  OPENING: "OPENING",
  BALANCE_CORRECTION: "BALANCE_CORRECTION",
  BANK: "BANK",
  CASH: "CASH",
  PARTY: "PARTY",
  EXPENSE: "EXPENSE",
  WRITE_OFF: "WRITE_OFF",
} as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPE)[keyof typeof ADJUSTMENT_TYPE];

/* -------------------------------------------------------------------------- */
/* Cash tally                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Daily cash tally outcome.
 *
 * Per §62 the system never "fixes" a mismatch by moving the expectation. It reports
 * SHORT or EXCESS and the difference stands until a human posts an explaining entry.
 */
export const TALLY_STATUS = {
  PENDING: "PENDING",
  MATCHED: "MATCHED",
  SHORT: "SHORT",
  EXCESS: "EXCESS",
} as const;
export type TallyStatus = (typeof TALLY_STATUS)[keyof typeof TALLY_STATUS];

export function tallyStatus(differencePaise: number): TallyStatus {
  if (differencePaise === 0) return "MATCHED";
  return differencePaise < 0 ? "SHORT" : "EXCESS";
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                  */
/* -------------------------------------------------------------------------- */

export const APPROVAL_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  SKIPPED: "SKIPPED",
} as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS];

export const APPROVER_TIER = {
  BRANCH_ADMIN: "BRANCH_ADMIN",
  SUPER_ADMIN: "SUPER_ADMIN",
} as const;
export type ApproverTier = (typeof APPROVER_TIER)[keyof typeof APPROVER_TIER];

/* -------------------------------------------------------------------------- */
/* Settlement                                                                 */
/* -------------------------------------------------------------------------- */

export const SETTLEMENT_KIND = {
  PARTY: "PARTY",
  BANK: "BANK",
} as const;
export type SettlementKind = (typeof SETTLEMENT_KIND)[keyof typeof SETTLEMENT_KIND];

export const SETTLEMENT_STATUS = {
  PENDING: "PENDING",
  PARTIAL: "PARTIAL",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUS)[keyof typeof SETTLEMENT_STATUS];

/* -------------------------------------------------------------------------- */
/* Savings (Bachat Khata)                                                     */
/* -------------------------------------------------------------------------- */

export const SAVINGS_OPERATION = {
  DEPOSIT: "DEPOSIT",
  WITHDRAWAL: "WITHDRAWAL",
  INTEREST: "INTEREST",
  BONUS: "BONUS",
  ADJUSTMENT: "ADJUSTMENT",
} as const;
export type SavingsOperation = (typeof SAVINGS_OPERATION)[keyof typeof SAVINGS_OPERATION];

/* -------------------------------------------------------------------------- */
/* Credit aging                                                               */
/* -------------------------------------------------------------------------- */

export const AGING_BUCKETS = [
  { key: "current", label: "0–30 days", from: 0, to: 30 },
  { key: "b31_60", label: "31–60 days", from: 31, to: 60 },
  { key: "b61_90", label: "61–90 days", from: 61, to: 90 },
  { key: "b90plus", label: "90+ days", from: 91, to: Number.POSITIVE_INFINITY },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]["key"];

export function agingBucket(daysOverdue: number): AgingBucketKey {
  if (daysOverdue <= 30) return "current";
  if (daysOverdue <= 60) return "b31_60";
  if (daysOverdue <= 90) return "b61_90";
  return "b90plus";
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

export const RECORD_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  BLOCKED: "BLOCKED",
} as const;
export type RecordStatus = (typeof RECORD_STATUS)[keyof typeof RECORD_STATUS];

export const PERIOD_STATUS = {
  OPEN: "OPEN",
  CLOSED: "CLOSED",
  LOCKED: "LOCKED",
} as const;
export type PeriodStatus = (typeof PERIOD_STATUS)[keyof typeof PERIOD_STATUS];

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export const AUDIT_ACTION = {
  LOGIN: "LOGIN",
  LOGIN_FAILURE: "LOGIN_FAILURE",
  LOGOUT: "LOGOUT",
  PASSWORD_CHANGE: "PASSWORD_CHANGE",
  PASSWORD_RESET: "PASSWORD_RESET",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",

  CREATE: "CREATE",
  UPDATE: "UPDATE",
  DELETE_REQUEST: "DELETE_REQUEST",
  DELETE: "DELETE",

  SUBMIT: "SUBMIT",
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  POST: "POST",
  REVERSE: "REVERSE",

  ROLE_CHANGE: "ROLE_CHANGE",
  PERMISSION_CHANGE: "PERMISSION_CHANGE",

  BALANCE_ADJUSTED: "BALANCE_ADJUSTED",
  RECONCILED: "RECONCILED",
  PERIOD_CLOSED: "PERIOD_CLOSED",
  PERIOD_REOPENED: "PERIOD_REOPENED",

  EXPORT: "EXPORT",
  IMPORT: "IMPORT",
  SETTINGS_UPDATED: "SETTINGS_UPDATED",
} as const;
export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

export const NOTIFICATION_TYPE = {
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  PAYMENT_SENT: "PAYMENT_SENT",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  APPROVAL_COMPLETED: "APPROVAL_COMPLETED",
  APPROVAL_REJECTED: "APPROVAL_REJECTED",
  EXPENSE_CREATED: "EXPENSE_CREATED",
  TRANSACTION_REVERSED: "TRANSACTION_REVERSED",
  RECONCILIATION_ISSUE: "RECONCILIATION_ISSUE",
  LOW_BALANCE: "LOW_BALANCE",
  CREDIT_OVERDUE: "CREDIT_OVERDUE",
  CASH_TALLY_MISMATCH: "CASH_TALLY_MISMATCH",
} as const;
export type NotificationType = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

export const SEVERITY = {
  INFO: "INFO",
  SUCCESS: "SUCCESS",
  WARNING: "WARNING",
  DANGER: "DANGER",
} as const;
export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];
