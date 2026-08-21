import { z } from "zod";
import { BANK_ACCOUNT_TYPE, RECORD_STATUS } from "../enums.js";
import {
  accountNumber,
  ifsc,
  listQuery,
  money,
  note,
  objectId,
  optionalEmail,
  optionalIndianMobile,
} from "./common.js";

/* -------------------------------------------------------------------------- */
/* Bank                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A Bank is the institution (HDFC, ICICI, SBI). It holds NO balance — money lives in the
 * accounts beneath it. Keeping the institution separate is what lets "HDFC" be spelled
 * one way across every branch and every report.
 */
export const createBankSchema = z.object({
  name: z.string().trim().min(2, "Bank name is required").max(120),
  shortName: z
    .string()
    .trim()
    .toUpperCase()
    .max(20)
    .optional()
    .transform((v) => (v ? v : undefined)),
  ifscPrefix: z
    .union([z.string().trim().toUpperCase().regex(/^[A-Z]{4}$/, "The IFSC prefix is 4 letters"), z.literal("")])
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Bank-wide contact, distinct from the per-account branch contact. */
  contactPerson: z.string().trim().max(80).optional(),
  phone: optionalIndianMobile,
  email: optionalEmail,
  status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
  notes: note(),
});
export type CreateBankInput = z.infer<typeof createBankSchema>;

export const updateBankSchema = createBankSchema.partial();
export type UpdateBankInput = z.infer<typeof updateBankSchema>;

export interface BankSummary {
  id: string;
  name: string;
  shortName?: string;
  ifscPrefix?: string;
  status: string;
  accountCount: number;
  /** Sum across every account of this bank the caller is allowed to see. */
  totalBalance: number;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Bank account                                                               */
/* -------------------------------------------------------------------------- */

export const createBankAccountSchema = z.object({
  bankId: objectId,
  branchId: objectId,
  accountName: z.string().trim().min(2, "Account name is required").max(120),
  accountNumber,
  ifsc,
  bankBranchName: z.string().trim().max(120).optional(),
  accountType: z.nativeEnum(BANK_ACCOUNT_TYPE).default("CURRENT"),

  /**
   * Posted as an OPENING_BALANCE transaction against equity, never stored as a mutable
   * field. It can be negative for an overdraft account that starts drawn down.
   */
  openingBalance: money.default(0),
  openingDate: z.coerce.date().optional(),

  /**
   * Overdraft limit, as a positive number.
   *
   * The balance check permits the account to go this far below zero. A CURRENT account
   * with no limit cannot be overdrawn at all, which is what stops a payment being posted
   * from an account that does not have the money.
   */
  overdraftLimit: money.default(0).refine((v) => v >= 0, "The overdraft limit is entered as a positive amount"),

  /** Warn on the dashboard when the balance falls below this. */
  lowBalanceThreshold: money.default(0),

  status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
  notes: note(),
});
export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;

/**
 * Account number, IFSC, bank and branch are all immutable after creation.
 *
 * They identify the real-world account that historical entries were posted against.
 * Editing one would silently re-point months of reconciled transactions at a different
 * account — if the details were entered wrongly, the correct action is to close this
 * account and open the right one, leaving the audit trail intact.
 */
export const updateBankAccountSchema = createBankAccountSchema
  .omit({
    bankId: true,
    branchId: true,
    accountNumber: true,
    ifsc: true,
    openingBalance: true,
    openingDate: true,
  })
  .partial();
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;

export const bankAccountQuerySchema = listQuery.extend({
  bankId: objectId.optional(),
  branchId: objectId.optional(),
  accountType: z.nativeEnum(BANK_ACCOUNT_TYPE).optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
});
export type BankAccountQuery = z.infer<typeof bankAccountQuerySchema>;

export interface BankAccountSummary {
  id: string;
  bank: { id: string; name: string; shortName?: string };
  branch: { id: string; name: string; code: string };
  accountName: string;
  /** Masked as `XXXX XXXX 1234` unless the caller holds `finance.bank.viewFull`. */
  accountNumber: string;
  accountNumberMasked: boolean;
  ifsc: string;
  bankBranchName?: string;
  accountType: string;
  /** Derived from ledger entries, never a stored mutable field. */
  balance: number;
  availableBalance: number;
  overdraftLimit: number;
  lowBalanceThreshold: number;
  isLowBalance: boolean;
  status: string;
  ledgerAccountId: string;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Cash account                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The physical cash drawer. One per branch is typical, but several are supported for a
 * business running separate counters that tally independently.
 */
export const createCashAccountSchema = z.object({
  branchId: objectId,
  name: z.string().trim().min(2, "Name is required").max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .max(20)
    .optional()
    .transform((v) => (v ? v : undefined)),
  openingBalance: money.default(0),
  openingDate: z.coerce.date().optional(),
  /**
   * Cash cannot be negative — you cannot pay out money that is not in the drawer. This is
   * enforced on posting, unlike a bank account which may have an overdraft facility.
   */
  status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
  notes: note(),
});
export type CreateCashAccountInput = z.infer<typeof createCashAccountSchema>;

export const updateCashAccountSchema = createCashAccountSchema
  .omit({ branchId: true, openingBalance: true, openingDate: true })
  .partial();
export type UpdateCashAccountInput = z.infer<typeof updateCashAccountSchema>;

export interface CashAccountSummary {
  id: string;
  name: string;
  code?: string;
  branch: { id: string; name: string; code: string };
  balance: number;
  /**
   * The branch's default drawer — the first one opened becomes it automatically.
   *
   * Carried on the summary because it decides where a cash receipt lands when the operator
   * does not pick a drawer, and which one the Daily Cash Tally opens on. A list that hid it
   * would make two identically-named drawers indistinguishable.
   */
  isDefault: boolean;
  status: string;
  ledgerAccountId: string;
  createdAt: string;
}
