import { Types } from "mongoose";
import {
  endOfDay,
  startOfDay,
  type AccountKind,
  type BalanceSheet,
  type CashFlowReport,
  type CashFlowRow,
  type MonthlyHistory,
  type MonthlyHistoryRow,
  type PnLLine,
  type ProfitAndLoss,
} from "@amiri/shared";
import { LedgerAccount, LedgerEntry } from "../models/index.js";

/**
 * The reporting engine (§34) — and §21 made concrete.
 *
 * CASH FLOW IS NOT PROFIT. The two are computed here by separate functions over separate
 * account classes, and nothing in this file ever adds one to the other:
 *
 *   `cashFlow`        — movement in BANK and CASH accounts. What is in the drawer.
 *   `profitAndLoss`   — INCOME less EXPENSE accounts. What the business earned.
 *
 * A branch can push ₹10,00,000 through its accounts in a day and lose money; it can bank
 * nothing all week and be profitable. The P&L reports cash movement ALONGSIDE the profit
 * figure — never inside it — precisely so the gap between the two is visible on the page.
 *
 * Every figure comes from `ledgerentries`, not from cached balances. A report whose job is
 * to state the financial position must not depend on the denormalisation it could be used
 * to validate.
 */

interface AccountTotal {
  _id: Types.ObjectId;
  debit: number;
  credit: number;
  account: { code: string; name: string; kind: AccountKind; accountClass: string };
}

/**
 * Sum every account's debits and credits over a window.
 *
 * One aggregation for the whole report rather than a query per account — a P&L over a
 * year with fifty heads would otherwise be fifty round trips.
 */
async function totalsByAccount(options: {
  from?: Date;
  to?: Date;
  branchId?: string | Types.ObjectId;
  kinds?: AccountKind[];
}): Promise<AccountTotal[]> {
  const match: Record<string, unknown> = {};

  if (options.from || options.to) {
    match.date = {
      ...(options.from ? { $gte: startOfDay(options.from) } : {}),
      ...(options.to ? { $lte: endOfDay(options.to) } : {}),
    };
  }
  if (options.branchId) match.branchId = new Types.ObjectId(String(options.branchId));

  return LedgerEntry.aggregate<AccountTotal>([
    { $match: match },
    {
      $group: {
        _id: "$ledgerAccountId",
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
      },
    },
    {
      $lookup: {
        from: "ledgeraccounts",
        localField: "_id",
        foreignField: "_id",
        as: "account",
        pipeline: [{ $project: { code: 1, name: 1, kind: 1, accountClass: 1 } }],
      },
    },
    { $unwind: "$account" },
    ...(options.kinds ? [{ $match: { "account.kind": { $in: options.kinds } } }] : []),
    { $sort: { "account.code": 1 } },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Profit & Loss                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Profit & Loss over a period.
 *
 * Income accounts are credit-normal, so their earnings are `credit − debit`. Expense
 * accounts are debit-normal, so their cost is `debit − credit`. Both are reported as
 * positive figures — a "negative expense" on a report is a puzzle nobody should have to
 * solve — and the sign lives in which section the line sits in.
 */
export async function profitAndLoss(options: {
  from: Date;
  to: Date;
  branchId?: string;
}): Promise<ProfitAndLoss> {
  const totals = await totalsByAccount({
    from: options.from,
    to: options.to,
    branchId: options.branchId,
    kinds: ["INCOME", "EXPENSE", "CHARGE"],
  });

  const income: PnLLine[] = [];
  const expenses: PnLLine[] = [];
  let totalIncome = 0;
  let totalExpenses = 0;
  let totalCharges = 0;

  for (const row of totals) {
    const isIncome = row.account.kind === "INCOME";
    const amount = isIncome ? row.credit - row.debit : row.debit - row.credit;

    // An account with no net movement adds a row of zeros and nothing else.
    if (amount === 0) continue;

    const line: PnLLine = {
      ledgerAccountId: String(row._id),
      code: row.account.code,
      name: row.account.name,
      kind: row.account.kind,
      amount,
      share: 0,
    };

    if (isIncome) {
      income.push(line);
      totalIncome += amount;
    } else {
      expenses.push(line);
      totalExpenses += amount;
      // Bank fees and commission are shown as their own subtotal — §18 requires charges
      // to stay traceable rather than dissolving into "other expenses".
      if (row.account.kind === "CHARGE") totalCharges += amount;
    }
  }

  for (const line of income) line.share = totalIncome > 0 ? (line.amount / totalIncome) * 100 : 0;
  for (const line of expenses) line.share = totalExpenses > 0 ? (line.amount / totalExpenses) * 100 : 0;

  income.sort((a, b) => b.amount - a.amount);
  expenses.sort((a, b) => b.amount - a.amount);

  const netProfit = totalIncome - totalExpenses;

  // Computed separately, reported alongside, never added in (§21).
  const cash = await cashMovement({ from: options.from, to: options.to, branchId: options.branchId });

  return {
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    branchId: options.branchId ?? null,
    income,
    totalIncome,
    expenses,
    totalExpenses,
    totalCharges,
    netProfit,
    margin: totalIncome > 0 ? (netProfit / totalIncome) * 100 : null,
    cashMovement: cash.net,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Balance Sheet                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Balance Sheet as at a date.
 *
 * `retainedEarnings` is computed rather than stored, and it is what makes the sheet
 * balance. Income and expense accounts are never closed into equity by this system — that
 * would mean rewriting history at year end — so their net is folded into equity at report
 * time instead. Without it, assets would exceed liabilities plus equity by exactly the
 * profit earned to date.
 *
 * A party with a positive balance is an asset (they owe us); a negative one is a
 * liability (we owe them). The same account therefore appears on different sides of the
 * sheet depending on where the relationship stands, which is correct.
 */
export async function balanceSheet(options: {
  asOf: Date;
  branchId?: string;
}): Promise<BalanceSheet> {
  const totals = await totalsByAccount({ to: options.asOf, branchId: options.branchId });

  const assets: BalanceSheet["assets"] = [];
  const liabilities: BalanceSheet["liabilities"] = [];
  const equity: BalanceSheet["equity"] = [];

  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquityAccounts = 0;
  let retainedEarnings = 0;

  for (const row of totals) {
    const { kind, accountClass, code, name } = row.account;
    const line = { ledgerAccountId: String(row._id), code, name, kind };

    if (kind === "INCOME") {
      retainedEarnings += row.credit - row.debit;
      continue;
    }
    if (kind === "EXPENSE" || kind === "CHARGE") {
      retainedEarnings -= row.debit - row.credit;
      continue;
    }

    if (accountClass === "EQUITY") {
      const amount = row.credit - row.debit;
      if (amount !== 0) {
        equity.push({ ...line, amount });
        totalEquityAccounts += amount;
      }
      continue;
    }

    if (accountClass === "LIABILITY") {
      const amount = row.credit - row.debit;
      if (amount !== 0) {
        liabilities.push({ ...line, amount });
        totalLiabilities += amount;
      }
      continue;
    }

    // ASSET class — bank, cash, party, suspense.
    const amount = row.debit - row.credit;
    if (amount === 0) continue;

    if (amount < 0 && kind === "PARTY") {
      // A party in credit is money we owe, which belongs on the liability side.
      liabilities.push({ ...line, amount: -amount });
      totalLiabilities += -amount;
    } else {
      assets.push({ ...line, amount });
      totalAssets += amount;
    }
  }

  assets.sort((a, b) => b.amount - a.amount);
  liabilities.sort((a, b) => b.amount - a.amount);

  const totalEquity = totalEquityAccounts + retainedEarnings;
  const difference = totalAssets - (totalLiabilities + totalEquity);

  return {
    asOf: options.asOf.toISOString(),
    branchId: options.branchId ?? null,
    assets,
    totalAssets,
    liabilities,
    totalLiabilities,
    equity,
    retainedEarnings,
    totalEquity,
    // Always zero in a sound ledger. Reported regardless — a balance sheet that quietly
    // forced itself to balance would be worthless.
    difference,
    balances: difference === 0,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Cash flow                                                                  */
/* -------------------------------------------------------------------------- */

/** Net movement across cash and bank over a window. Used by the P&L's context figure. */
export async function cashMovement(options: {
  from: Date;
  to: Date;
  branchId?: string;
}): Promise<{ in: number; out: number; net: number }> {
  const totals = await totalsByAccount({
    from: options.from,
    to: options.to,
    branchId: options.branchId,
    kinds: ["BANK", "CASH"],
  });

  let inflow = 0;
  let outflow = 0;
  for (const row of totals) {
    // Cash and bank are asset accounts: a debit is money arriving.
    inflow += row.debit;
    outflow += row.credit;
  }

  return { in: inflow, out: outflow, net: inflow - outflow };
}

/* -------------------------------------------------------------------------- */
/* Monthly history                                                            */
/* -------------------------------------------------------------------------- */

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface MonthlyBucket {
  _id: { year: number; month: number; kind: AccountKind };
  debit: number;
  credit: number;
  entries: number;
}

/**
 * Month-by-month trading history.
 *
 * ONE aggregation for the entire range, not one per month. A two-year view is 24 months ×
 * several account kinds; querying per month would be dozens of round trips returning data
 * the database could have grouped itself in a single pass.
 *
 * Months with no postings are emitted as explicit zero rows rather than omitted. A gap in a
 * history table reads as missing data — "did the report break?" — whereas a row of zeros
 * says plainly that nothing traded that month, which is itself a finding.
 *
 * `partyClosing` is a POSITION, not a movement, so it cannot be read from this range alone:
 * it needs what parties owed before the window opened. That opening figure is fetched
 * separately and the monthly nets are accumulated onto it.
 */
export async function monthlyHistory(options: {
  from: Date;
  to: Date;
  branchId?: string;
}): Promise<MonthlyHistory> {
  const from = startOfDay(options.from);
  const to = endOfDay(options.to);

  const match: Record<string, unknown> = { date: { $gte: from, $lte: to } };
  if (options.branchId) match.branchId = new Types.ObjectId(String(options.branchId));

  const buckets = await LedgerEntry.aggregate<MonthlyBucket>([
    { $match: match },
    {
      $lookup: {
        from: "ledgeraccounts",
        localField: "ledgerAccountId",
        foreignField: "_id",
        as: "account",
        pipeline: [{ $project: { kind: 1 } }],
      },
    },
    { $unwind: "$account" },
    {
      $group: {
        // Grouped in UTC, matching how every other report in this file reads `date`.
        _id: {
          year: { $year: { date: "$date", timezone: "UTC" } },
          month: { $month: { date: "$date", timezone: "UTC" } },
          kind: "$account.kind",
        },
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
        entries: { $sum: 1 },
      },
    },
  ]);

  const byMonth = new Map<string, MonthlyBucket[]>();
  for (const bucket of buckets) {
    const key = `${bucket._id.year}-${String(bucket._id.month).padStart(2, "0")}`;
    const list = byMonth.get(key);
    if (list) list.push(bucket);
    else byMonth.set(key, [bucket]);
  }

  /**
   * What parties owed at the instant before the window.
   *
   * Party accounts are asset-normal: a debit increases what they owe us. Without this the
   * first month's closing figure would be that month's movement wearing the label of a
   * balance — the same mistake `cashFlow` avoids with its opening figure.
   */
  const openingRows = await totalsByAccount({
    to: new Date(from.getTime() - 1),
    branchId: options.branchId,
    kinds: ["PARTY"],
  });
  let partyRunning = openingRows.reduce((sum, r) => sum + (r.debit - r.credit), 0);

  const months: MonthlyHistoryRow[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));

  while (cursor <= last) {
    const year = cursor.getUTCFullYear();
    const monthIndex = cursor.getUTCMonth();
    const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
    const rows = byMonth.get(key) ?? [];

    const of = (kind: AccountKind) => rows.find((r) => r._id.kind === kind);
    const sum = (kinds: AccountKind[], pick: (b: MonthlyBucket) => number) =>
      kinds.reduce((total, kind) => {
        const bucket = of(kind);
        return total + (bucket ? pick(bucket) : 0);
      }, 0);

    // Income is credit-normal; expense and charge are debit-normal. Both reported positive.
    const income = sum(["INCOME"], (b) => b.credit - b.debit);
    const charges = sum(["CHARGE"], (b) => b.debit - b.credit);
    const expenses = sum(["EXPENSE"], (b) => b.debit - b.credit) + charges;

    const cashIn = sum(["BANK", "CASH"], (b) => b.debit);
    const cashOut = sum(["BANK", "CASH"], (b) => b.credit);

    // A party debit is what they took on; a credit is what they settled.
    const partyPaid = sum(["PARTY"], (b) => b.debit);
    const partyReceived = sum(["PARTY"], (b) => b.credit);
    partyRunning += partyPaid - partyReceived;

    const netProfit = income - expenses;

    months.push({
      month: key,
      label: `${MONTH_NAMES[monthIndex]} ${year}`,
      from: new Date(Date.UTC(year, monthIndex, 1)).toISOString(),
      // Day 0 of the next month is the last day of this one, leap years included.
      to: endOfDay(new Date(Date.UTC(year, monthIndex + 1, 0))).toISOString(),
      income,
      expenses,
      charges,
      netProfit,
      margin: income > 0 ? (netProfit / income) * 100 : null,
      cashIn,
      cashOut,
      cashNet: cashIn - cashOut,
      partyReceived,
      partyPaid,
      partyClosing: partyRunning,
      entries: rows.reduce((total, r) => total + r.entries, 0),
    });

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const totalIncome = months.reduce((s, m) => s + m.income, 0);
  const totalExpenses = months.reduce((s, m) => s + m.expenses, 0);
  const netProfit = totalIncome - totalExpenses;

  // Only months that actually traded compete for best and worst — otherwise an untraded
  // month of zeros would win "worst" over a month that genuinely lost money.
  const traded = months.filter((m) => m.entries > 0);
  const ranked = [...traded].sort((a, b) => b.netProfit - a.netProfit);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    branchId: options.branchId ?? null,
    months,
    totals: {
      income: totalIncome,
      expenses: totalExpenses,
      charges: months.reduce((s, m) => s + m.charges, 0),
      netProfit,
      margin: totalIncome > 0 ? (netProfit / totalIncome) * 100 : null,
      cashNet: months.reduce((s, m) => s + m.cashNet, 0),
      partyReceived: months.reduce((s, m) => s + m.partyReceived, 0),
      partyPaid: months.reduce((s, m) => s + m.partyPaid, 0),
    },
    bestMonth: ranked.length > 0 ? ranked[0]!.month : null,
    worstMonth: ranked.length > 0 ? ranked[ranked.length - 1]!.month : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Day-by-day cash and bank movement, with a running balance.
 *
 * The opening figure is the position at the instant BEFORE the window, so the first row's
 * closing balance is genuinely the balance at the end of that day rather than the day's
 * movement mistaken for a balance.
 */
export async function cashFlow(options: {
  from: Date;
  to: Date;
  branchId?: string;
}): Promise<CashFlowReport> {
  const cashAccounts = await LedgerAccount.find({
    kind: { $in: ["BANK", "CASH"] },
    ...(options.branchId ? { branchId: new Types.ObjectId(options.branchId) } : {}),
  })
    .select("_id")
    .lean();

  const ids = cashAccounts.map((a) => a._id);

  const [openingAgg] = await LedgerEntry.aggregate<{ debit: number; credit: number }>([
    {
      $match: {
        ledgerAccountId: { $in: ids },
        date: { $lt: startOfDay(options.from) },
      },
    },
    {
      $group: {
        _id: null,
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
      },
    },
  ]);

  const openingBalance = (openingAgg?.debit ?? 0) - (openingAgg?.credit ?? 0);

  const daily = await LedgerEntry.aggregate<{ _id: string; moneyIn: number; moneyOut: number }>([
    {
      $match: {
        ledgerAccountId: { $in: ids },
        date: { $gte: startOfDay(options.from), $lte: endOfDay(options.to) },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: "UTC" } },
        moneyIn: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        moneyOut: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  let running = openingBalance;
  const rows: CashFlowRow[] = daily.map((day) => {
    const opening = running;
    running = opening + day.moneyIn - day.moneyOut;
    return {
      date: day._id,
      openingBalance: opening,
      moneyIn: day.moneyIn,
      moneyOut: day.moneyOut,
      closingBalance: running,
    };
  });

  return {
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    branchId: options.branchId ?? null,
    openingBalance,
    totalIn: rows.reduce((s, r) => s + r.moneyIn, 0),
    totalOut: rows.reduce((s, r) => s + r.moneyOut, 0),
    closingBalance: running,
    rows,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Shared building blocks                                                     */
/* -------------------------------------------------------------------------- */

/** Profit over a window. Used by the dashboards and the cash tally's context panel. */
export async function profitFor(options: {
  from: Date;
  to: Date;
  branchId?: string;
}): Promise<{ income: number; expenses: number; profit: number }> {
  const totals = await totalsByAccount({
    from: options.from,
    to: options.to,
    branchId: options.branchId,
    kinds: ["INCOME", "EXPENSE", "CHARGE"],
  });

  let income = 0;
  let expenses = 0;
  for (const row of totals) {
    if (row.account.kind === "INCOME") income += row.credit - row.debit;
    else expenses += row.debit - row.credit;
  }

  return { income, expenses, profit: income - expenses };
}

/** Current balance across a set of account kinds. */
export async function balanceByKind(
  kinds: AccountKind[],
  branchId?: string,
): Promise<number> {
  const accounts = await LedgerAccount.find({
    kind: { $in: kinds },
    ...(branchId ? { branchId: new Types.ObjectId(branchId) } : {}),
  })
    .select("cachedBalance")
    .lean();

  return accounts.reduce((sum, a) => sum + a.cachedBalance, 0);
}

/** Receivable and payable, split from the same party balances (§10). */
export async function partyPositions(
  branchId?: string,
): Promise<{ receivable: number; payable: number }> {
  const accounts = await LedgerAccount.find({
    kind: "PARTY",
    ...(branchId ? { branchId: new Types.ObjectId(branchId) } : {}),
  })
    .select("cachedBalance")
    .lean();

  let receivable = 0;
  let payable = 0;
  for (const a of accounts) {
    if (a.cachedBalance > 0) receivable += a.cachedBalance;
    else payable += -a.cachedBalance;
  }

  return { receivable, payable };
}
