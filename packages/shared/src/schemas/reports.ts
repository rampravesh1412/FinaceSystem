import { z } from "zod";
import type { AccountKind, TallyStatus } from "../enums.js";
import { businessDate, money, note, objectId, optionalObjectId } from "./common.js";

/**
 * Reports (§34), Daily Cash Tally (§20) and Daily Profit (§21).
 *
 * THE RULE THAT SHAPES THIS WHOLE FILE — §21:
 *
 *   CASH FLOW is not PROFIT.
 *
 * They are computed from different account classes by different functions and are never
 * added together:
 *
 *   Cash flow  — movement in ASSET accounts of kind BANK and CASH. Answers "what is in
 *                the drawer and the bank".
 *   Profit     — INCOME accounts less EXPENSE accounts. Answers "did the business earn".
 *
 * A branch can take ₹10,00,000 through the door in a day and make a loss; it can bank
 * nothing and be profitable. Conflating the two is the single most common way a small
 * business ends up insolvent while believing it is doing well.
 */

export const reportRangeSchema = z
  .object({
    from: businessDate,
    to: businessDate,
    branchId: optionalObjectId,
  })
  .refine((v) => v.from <= v.to, { message: "The start date must not be after the end date", path: ["from"] });
export type ReportRange = z.infer<typeof reportRangeSchema>;

export const asOfSchema = z.object({
  asOf: businessDate.optional(),
  branchId: optionalObjectId,
});
export type AsOfQuery = z.infer<typeof asOfSchema>;

/* -------------------------------------------------------------------------- */
/* Profit & Loss (§34)                                                        */
/* -------------------------------------------------------------------------- */

export interface PnLLine {
  ledgerAccountId: string;
  code: string;
  name: string;
  kind: AccountKind;
  amount: number;
  /** Share of its section total, for the bar next to each line. */
  share: number;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  branchId: string | null;

  income: PnLLine[];
  totalIncome: number;

  expenses: PnLLine[];
  totalExpenses: number;
  /** Bank fees and commission paid, split out because §18 keeps charges traceable. */
  totalCharges: number;

  /** income − expenses. The figure that answers "did we earn". */
  netProfit: number;
  /** As a percentage of income. Null when there was no income to divide by. */
  margin: number | null;

  /**
   * Cash movement over the SAME window, reported alongside but never added in.
   * Shown together precisely so the difference between the two is visible.
   */
  cashMovement: number;

  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Monthly history                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One month of trading, on the same terms as the P&L above.
 *
 * §21 still holds here and is the reason `cashNet` sits apart from `netProfit` rather than
 * near it: a month can bank a great deal and still lose money. Reading a row left to right
 * should make that gap visible, not hide it.
 */
export interface MonthlyHistoryRow {
  /** `2026-08` — sortable, and the key the UI uses. */
  month: string;
  /** `Aug 2026` — for display, so the client does not re-derive it. */
  label: string;
  from: string;
  to: string;

  income: number;
  expenses: number;
  /** Included in `expenses`, broken out because §18 keeps charges traceable. */
  charges: number;
  netProfit: number;
  margin: number | null;

  /** Movement in BANK and CASH accounts. NOT part of profit. */
  cashIn: number;
  cashOut: number;
  cashNet: number;

  /** Received from parties over the month, and paid out to them. */
  partyReceived: number;
  partyPaid: number;
  /**
   * What parties owed at the close of this month — a running position, not a movement.
   * Positive means they owe us.
   */
  partyClosing: number;

  /** Postings in the month. A zero-entry month is real information, not a gap. */
  entries: number;
}

export interface MonthlyHistory {
  from: string;
  to: string;
  branchId: string | null;
  months: MonthlyHistoryRow[];
  totals: {
    income: number;
    expenses: number;
    charges: number;
    netProfit: number;
    margin: number | null;
    cashNet: number;
    partyReceived: number;
    partyPaid: number;
  };
  /** The best and worst months by net profit, or null when there is nothing to compare. */
  bestMonth: string | null;
  worstMonth: string | null;
  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Balance Sheet (§34)                                                        */
/* -------------------------------------------------------------------------- */

export interface BalanceSheetLine {
  ledgerAccountId: string;
  code: string;
  name: string;
  kind: AccountKind;
  amount: number;
}

export interface BalanceSheet {
  asOf: string;
  branchId: string | null;

  assets: BalanceSheetLine[];
  totalAssets: number;

  liabilities: BalanceSheetLine[];
  totalLiabilities: number;

  equity: BalanceSheetLine[];
  /** Income less expenses to date. Not a stored account — computed, and it is what makes
   *  the sheet balance without a year-end closing entry. */
  retainedEarnings: number;
  totalEquity: number;

  /** assets − (liabilities + equity). Always zero in a sound ledger; surfaced regardless. */
  difference: number;
  balances: boolean;

  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Cash flow                                                                  */
/* -------------------------------------------------------------------------- */

export interface CashFlowRow {
  date: string;
  openingBalance: number;
  moneyIn: number;
  moneyOut: number;
  closingBalance: number;
}

export interface CashFlowReport {
  from: string;
  to: string;
  branchId: string | null;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  closingBalance: number;
  rows: CashFlowRow[];
  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Daily Cash Tally (§20)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Counting the drawer at end of day.
 *
 * The field names deliberately mirror the AMIRI workbook — Cash Received, Cash Paid,
 * Cash Closing, Party Given, Party Taken, Tally Difference — so the person who has been
 * keeping the spreadsheet recognises the screen.
 *
 * §62 governs the outcome: if expected is ₹10,00,000 and counted is ₹9,80,000, the tally
 * records SHORT ₹20,000 and stops. It never adjusts the expectation to match the count.
 */
export const recordTallySchema = z.object({
  date: businessDate,
  branchId: objectId,
  cashAccountId: objectId,
  /** What was physically counted in the drawer. */
  actualClosing: money.refine((v) => v >= 0, "A counted amount cannot be negative"),
  notes: note(1000),
});
export type RecordTallyInput = z.infer<typeof recordTallySchema>;

export interface CashTally {
  id: string | null;
  date: string;
  branch: { id: string; name: string; code: string };
  cashAccount: { id: string; name: string };

  /** Everything up to this line is DERIVED from the ledger — nobody types it in. */
  openingCash: number;
  cashReceived: number;
  cashPaid: number;
  adjustments: number;
  expectedClosing: number;

  /** The only figure a human enters. Null until the drawer has been counted. */
  actualClosing: number | null;
  /** actual − expected. Negative is SHORT, positive is EXCESS. */
  difference: number | null;
  status: TallyStatus;

  /** Context from the same day, as the AMIRI workbook presents it. */
  totalExpenses: number;
  partyGiven: number;
  partyTaken: number;
  netPartyMovement: number;
  todayProfit: number;

  countedBy: string | null;
  countedAt: string | null;
  notes?: string;
}

export const TALLY_STATUS_LABEL: Record<TallyStatus, string> = {
  PENDING: "Not counted",
  MATCHED: "Matched",
  SHORT: "Short",
  EXCESS: "Excess",
};


/* -------------------------------------------------------------------------- */
/* Dashboards (§31, §32, §33)                                                 */
/* -------------------------------------------------------------------------- */

export interface DashboardMetrics {
  /** Cash and bank, right now. */
  cashBalance: number;
  bankBalance: number;
  totalBalance: number;

  /** Today's movement — cash flow, NOT profit. */
  todayIn: number;
  todayOut: number;
  todayNet: number;

  /** Today's earnings — profit, NOT cash flow. */
  todayIncome: number;
  todayExpenses: number;
  todayProfit: number;

  monthIncome: number;
  monthExpenses: number;
  monthProfit: number;

  receivable: number;
  payable: number;

  pendingApprovals: number;
  unreconciledCount: number;
  overdueAmount: number;
  savingsHeld: number;

  transactionCountToday: number;
}

export interface DashboardTrendPoint {
  date: string;
  income: number;
  expenses: number;
  profit: number;
  moneyIn: number;
  moneyOut: number;
}

export interface BranchPerformance {
  branchId: string;
  code: string;
  name: string;
  balance: number;
  income: number;
  expenses: number;
  profit: number;
  receivable: number;
}

export interface DashboardResponse {
  scope: "ORGANISATION" | "BRANCH";
  branch: { id: string; name: string; code: string } | null;
  metrics: DashboardMetrics;
  /** Daily points for the trend charts, oldest first. */
  trend: DashboardTrendPoint[];
  expenseBreakdown: Array<{ name: string; amount: number }>;
  branches: BranchPerformance[];
  topParties: Array<{ id: string; name: string; balance: number; direction: string }>;
  recentTransactions: Array<{
    id: string;
    txnNo: string;
    typeLabel: string;
    date: string;
    party: string | null;
    amount: number;
    moneyIn: number;
    moneyOut: number;
    status: string;
  }>;
  agingBuckets: Record<string, number>;
  generatedAt: string;
}
