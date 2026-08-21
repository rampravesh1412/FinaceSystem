import { Schema, model, type Document, type Types } from "mongoose";
import {
  ACCOUNT_CLASS,
  ACCOUNT_KIND,
  RECORD_STATUS,
  type AccountClass,
  type AccountKind,
  type RecordStatus,
} from "@amiri/shared";
import { actorField, baseSchemaOptions, moneyField } from "./fields.js";

/**
 * The chart of accounts.
 *
 * EVERY balance-bearing thing in the system is one row here — a bank account, the cash
 * drawer, a party, an expense head, an income head, a savings account, equity. That
 * uniformity is the point: the trial balance, the balance sheet and the P&L are all one
 * aggregation over `ledgerentries` grouped by this collection, with no special cases per
 * entity type.
 *
 * `refKind` + `refId` point back at the master record. The master and its ledger account
 * are always created together inside one transaction, so neither can exist without the
 * other.
 */
export interface LedgerAccountDoc extends Document<Types.ObjectId> {
  code: string;
  name: string;
  kind: AccountKind;
  accountClass: AccountClass;

  /** Null for organisation-wide accounts (equity, suspense). */
  branchId?: Types.ObjectId | null;
  refKind?: string;
  refId?: Types.ObjectId;

  /**
   * Denormalised balance, signed against the account's normal side.
   *
   * A CACHE, not the truth. Updated inside the same transaction as the postings that
   * change it, and reconciled against a full replay of `ledgerentries` by the integrity
   * job. On disagreement the ledger wins and an alert is raised — the cache is never
   * "corrected" by overwriting the ledger (§62).
   */
  cachedBalance: number;
  cachedEntryCount: number;
  cachedAt?: Date;

  /**
   * How far below zero this account may go, as a positive number.
   * 0 for cash and most current accounts; the sanctioned limit for an OD/CC account.
   */
  overdraftLimit: number;
  /** Blocks postings that would take the balance below `-overdraftLimit`. */
  enforceBalance: boolean;

  /** System accounts (equity, suspense, bank charges) cannot be deleted or renamed. */
  isSystem: boolean;
  status: RecordStatus;

  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ledgerAccountSchema = new Schema<LedgerAccountDoc>(
  {
    /**
     * A stable, human-readable account code: `BANK-105-0007`, `PARTY-105-0042`,
     * `EQUITY-OPENING`. It appears on the trial balance and in exports, so it must
     * survive a rename of the underlying master record.
     */
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 160 },

    kind: { type: String, enum: Object.values(ACCOUNT_KIND), required: true, index: true },
    accountClass: { type: String, enum: Object.values(ACCOUNT_CLASS), required: true, index: true },

    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    refKind: { type: String, trim: true },
    refId: { type: Schema.Types.ObjectId, index: true },

    cachedBalance: moneyField({ default: 0 }),
    cachedEntryCount: { type: Number, default: 0, min: 0 },
    cachedAt: { type: Date },

    overdraftLimit: moneyField({ default: 0, nonNegative: true }),
    enforceBalance: { type: Boolean, default: false },

    isSystem: { type: Boolean, default: false },
    status: {
      type: String,
      enum: Object.values(RECORD_STATUS),
      default: RECORD_STATUS.ACTIVE,
      index: true,
    },

    createdBy: actorField(),
  },
  baseSchemaOptions(),
);

/**
 * One ledger account per master record.
 *
 * A partial unique index, because system accounts have no `refId` and several would
 * otherwise collide on null.
 */
ledgerAccountSchema.index(
  { refKind: 1, refId: 1 },
  { unique: true, partialFilterExpression: { refId: { $exists: true } } },
);

ledgerAccountSchema.index({ branchId: 1, kind: 1, status: 1 });
ledgerAccountSchema.index({ name: "text", code: "text" }, { name: "ledger_account_search" });

export const LedgerAccount = model<LedgerAccountDoc>("LedgerAccount", ledgerAccountSchema);

/* -------------------------------------------------------------------------- */
/* System accounts                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Accounts the engine itself posts against.
 *
 * `EQUITY-OPENING` is the counterweight for every opening balance: when a bank account
 * opens with ₹5,00,000, that money has to come from somewhere for the books to balance,
 * and in double-entry it comes from owner's equity. Without it, day-zero figures would be
 * single-sided and the trial balance would never tie.
 */
export const SYSTEM_ACCOUNTS = {
  OPENING_EQUITY: {
    code: "EQUITY-OPENING",
    name: "Opening Balance Equity",
    kind: ACCOUNT_KIND.EQUITY,
    accountClass: ACCOUNT_CLASS.EQUITY,
  },
  BANK_CHARGES: {
    code: "EXP-BANK-CHARGES",
    name: "Bank Charges",
    kind: ACCOUNT_KIND.CHARGE,
    accountClass: ACCOUNT_CLASS.EXPENSE,
  },
  COMMISSION_INCOME: {
    code: "INC-COMMISSION",
    name: "Commission Income",
    kind: ACCOUNT_KIND.INCOME,
    accountClass: ACCOUNT_CLASS.INCOME,
  },
  /** Holds a reconciliation difference until it is investigated and explained (§62). */
  SUSPENSE: {
    code: "SUSPENSE",
    name: "Suspense",
    kind: ACCOUNT_KIND.SUSPENSE,
    accountClass: ACCOUNT_CLASS.ASSET,
  },
  /** Absorbs a counted cash shortage or excess, pending investigation. */
  CASH_DIFFERENCE: {
    code: "EXP-CASH-DIFFERENCE",
    name: "Cash Difference",
    kind: ACCOUNT_KIND.CHARGE,
    accountClass: ACCOUNT_CLASS.EXPENSE,
  },
} as const;

export type SystemAccountKey = keyof typeof SYSTEM_ACCOUNTS;
