import { Types } from "mongoose";
import {
  TRANSACTION_TYPE_LABEL,
  endOfDay,
  khataDirection,
  startOfDay,
  type DashboardResponse,
  type DashboardTrendPoint,
} from "@amiri/shared";
import {
  LedgerAccount,
  LedgerEntry,
  Party,
  Reconciliation,
  Transaction,
} from "../../models/index.js";
import * as reports from "../../services/reports.service.js";
import * as khata from "../khata/khata.service.js";

/**
 * The dashboard (§31, §33).
 *
 * One builder over one set of books. Every figure describes the whole business, because
 * there is no longer any dimension to slice it by.
 *
 * §21 is visible in the shape of the response: `todayIn`/`todayOut` are CASH FLOW, while
 * `todayIncome`/`todayExpenses`/`todayProfit` are PROFIT. They sit in separate groups and
 * the UI labels them separately, because a day with ₹10,00,000 through the door can still
 * be a loss.
 */

export async function buildDashboard(options: {
  /** Days of history for the trend charts. */
  trendDays?: number;
}): Promise<DashboardResponse> {
  const trendDays = options.trendDays ?? 30;
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const trendStart = new Date(todayStart.getTime() - (trendDays - 1) * 86_400_000);

  const [
    cashBalance,
    bankBalance,
    savingsHeld,
    positions,
    todayProfit,
    monthProfit,
    todayFlow,
    trend,
    expenseBreakdown,
    recentTransactions,
    topParties,
    pendingApprovals,
    unreconciledCount,
    transactionCountToday,
    credit,
  ] = await Promise.all([
    reports.balanceByKind(["CASH"]),
    reports.balanceByKind(["BANK"]),
    reports.balanceByKind(["SAVINGS"]),
    reports.partyPositions(),
    reports.profitFor({ from: todayStart, to: todayEnd }),
    reports.profitFor({ from: monthStart, to: todayEnd }),
    reports.cashMovement({ from: todayStart, to: todayEnd }),
    buildTrend(trendStart, todayEnd),
    buildExpenseBreakdown(monthStart, todayEnd),
    buildRecent(),
    buildTopParties(),
    Transaction.countDocuments({ status: "PENDING" }),
    Reconciliation.countDocuments({ status: "IN_PROGRESS" }),
    Transaction.countDocuments({ date: { $gte: todayStart, $lte: todayEnd } }),
    khata.creditReport({ limit: 1 }),
  ]);

  return {
    metrics: {
      cashBalance,
      bankBalance,
      totalBalance: cashBalance + bankBalance,

      // CASH FLOW — what moved through the accounts.
      todayIn: todayFlow.in,
      todayOut: todayFlow.out,
      todayNet: todayFlow.net,

      // PROFIT — what the business earned. A different question entirely (§21).
      todayIncome: todayProfit.income,
      todayExpenses: todayProfit.expenses,
      todayProfit: todayProfit.profit,

      monthIncome: monthProfit.income,
      monthExpenses: monthProfit.expenses,
      monthProfit: monthProfit.profit,

      receivable: positions.receivable,
      payable: positions.payable,

      pendingApprovals,
      unreconciledCount,
      overdueAmount: credit.summary.totalOverdue,
      savingsHeld,

      transactionCountToday,
    },
    trend,
    expenseBreakdown,
    topParties,
    recentTransactions,
    agingBuckets: credit.summary.buckets,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Daily income, expense and cash movement for the trend charts.
 *
 * Days with no activity are filled in with zeros so the chart has an even x-axis — a line
 * chart that silently skips quiet days compresses time and misrepresents a trend.
 */
async function buildTrend(from: Date, to: Date): Promise<DashboardTrendPoint[]> {
  const rows = await LedgerEntry.aggregate<{
    _id: string;
    income: number;
    expenses: number;
    moneyIn: number;
    moneyOut: number;
  }>([
    { $match: { date: { $gte: from, $lte: to } } },
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
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: "UTC" } },
        income: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ["$account.kind", "INCOME"] }, { $eq: ["$direction", "CREDIT"] }] },
              "$amount",
              0,
            ],
          },
        },
        expenses: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $in: ["$account.kind", ["EXPENSE", "CHARGE"]] },
                  { $eq: ["$direction", "DEBIT"] },
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        moneyIn: {
          $sum: {
            $cond: [
              { $and: [{ $in: ["$account.kind", ["BANK", "CASH"]] }, { $eq: ["$direction", "DEBIT"] }] },
              "$amount",
              0,
            ],
          },
        },
        moneyOut: {
          $sum: {
            $cond: [
              { $and: [{ $in: ["$account.kind", ["BANK", "CASH"]] }, { $eq: ["$direction", "CREDIT"] }] },
              "$amount",
              0,
            ],
          },
        },
      },
    },
  ]);

  const byDate = new Map(rows.map((r) => [r._id, r]));
  const points: DashboardTrendPoint[] = [];

  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) {
    const key = d.toISOString().slice(0, 10);
    const row = byDate.get(key);
    points.push({
      date: key,
      income: row?.income ?? 0,
      expenses: row?.expenses ?? 0,
      profit: (row?.income ?? 0) - (row?.expenses ?? 0),
      moneyIn: row?.moneyIn ?? 0,
      moneyOut: row?.moneyOut ?? 0,
    });
  }

  return points;
}

async function buildExpenseBreakdown(
  from: Date,
  to: Date,
): Promise<Array<{ name: string; amount: number }>> {
  const rows = await LedgerEntry.aggregate<{ _id: Types.ObjectId; name: string; amount: number }>([
    { $match: { date: { $gte: from, $lte: to }, direction: "DEBIT" } },
    {
      $lookup: {
        from: "ledgeraccounts",
        localField: "ledgerAccountId",
        foreignField: "_id",
        as: "account",
        pipeline: [{ $project: { kind: 1, name: 1 } }],
      },
    },
    { $unwind: "$account" },
    { $match: { "account.kind": { $in: ["EXPENSE", "CHARGE"] } } },
    { $group: { _id: "$ledgerAccountId", name: { $first: "$account.name" }, amount: { $sum: "$amount" } } },
    { $sort: { amount: -1 } },
    { $limit: 8 },
  ]);

  return rows.map((r) => ({ name: r.name, amount: r.amount }));
}

async function buildRecent() {
  const txns = await Transaction.find({})
    .sort({ date: -1, _id: -1 })
    .limit(8)
    .populate<{ partyId: { name: string } | null }>("partyId", "name")
    .lean();

  return txns.map((t) => {
    const isIn = t.type === "PAYMENT_IN" || t.type === "INCOME";
    const isOut = t.type === "PAYMENT_OUT" || t.type === "EXPENSE";
    return {
      id: String(t._id),
      txnNo: t.txnNo,
      typeLabel: TRANSACTION_TYPE_LABEL[t.type] ?? t.type,
      date: t.date.toISOString(),
      party: t.partyId?.name ?? null,
      amount: t.netAmount,
      moneyIn: isIn ? t.netAmount : 0,
      moneyOut: isOut ? t.netAmount : 0,
      status: t.status,
    };
  });
}

/** The parties with the largest positions, by magnitude. */
async function buildTopParties() {
  const parties = await Party.find({ status: "ACTIVE" }).select("name ledgerAccountId").lean();
  const balances = await LedgerAccount.find({ _id: { $in: parties.map((p) => p.ledgerAccountId) } })
    .select("cachedBalance")
    .lean();
  const byId = new Map(balances.map((b) => [String(b._id), b.cachedBalance]));

  return parties
    .map((p) => ({
      id: String(p._id),
      name: p.name,
      balance: byId.get(String(p.ledgerAccountId)) ?? 0,
      direction: khataDirection(byId.get(String(p.ledgerAccountId)) ?? 0) as string,
    }))
    // Ranked by magnitude, so the largest payable is as visible as the largest receivable.
    .filter((p) => p.balance !== 0)
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
    .slice(0, 6);
}
