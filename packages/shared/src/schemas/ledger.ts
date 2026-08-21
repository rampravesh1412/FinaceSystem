import { z } from "zod";
import { ACCOUNT_KIND, type AccountClass, type AccountKind, type Direction } from "../enums.js";
import { dateRange, listQuery, objectId } from "./common.js";

/**
 * Ledger read contracts.
 *
 * There is deliberately NO "create ledger entry" schema. Entries are never authored
 * directly — they are produced by a posting service from a business transaction, in a
 * balanced set, inside one database transaction. Exposing an endpoint that writes a
 * single entry would be an endpoint for putting the books out of balance.
 */

export const ledgerAccountQuerySchema = listQuery.extend({
  kind: z.nativeEnum(ACCOUNT_KIND).optional(),
  branchId: objectId.optional(),
  /** Hide accounts with no entries and a zero balance — the trial balance's usual view. */
  activeOnly: z.coerce.boolean().optional(),
});
export type LedgerAccountQuery = z.infer<typeof ledgerAccountQuerySchema>;

export const ledgerEntryQuerySchema = listQuery
  .extend({
    ledgerAccountId: objectId.optional(),
    branchId: objectId.optional(),
    transactionId: objectId.optional(),
  })
  .and(dateRange);
export type LedgerEntryQuery = z.infer<typeof ledgerEntryQuerySchema>;

export interface LedgerAccountSummary {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  accountClass: AccountClass;
  branchId: string | null;
  /** Signed against the account's normal side: positive means a normal balance. */
  balance: number;
  entryCount: number;
  status: string;
}

export interface LedgerEntryRow {
  id: string;
  transactionId: string;
  txnNo: string;
  transactionType: string;
  date: string;
  ledgerAccountId: string;
  accountName: string;
  direction: Direction;
  debit: number;
  credit: number;
  /** Balance of this account immediately after the entry. */
  runningBalance: number;
  narration?: string;
  /** The other side(s) of the same transaction — "paid to whom", in one glance. */
  contra: string[];
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

/** A trial balance row (§34). Debits and credits must total to the same figure. */
export interface TrialBalanceRow {
  ledgerAccountId: string;
  code: string;
  name: string;
  kind: AccountKind;
  accountClass: AccountClass;
  debit: number;
  credit: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** Always zero in a correct system. Non-zero is a bug, and is surfaced, not hidden. */
  difference: number;
  asOf: string;
  branchId: string | null;
}
