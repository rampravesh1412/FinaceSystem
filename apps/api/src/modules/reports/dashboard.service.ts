import { Types } from "mongoose";
import {
  TRANSACTION_TYPE_LABEL,
  endOfDay,
  khataDirection,
  startOfDay,
  type BranchPerformance,
  type DashboardResponse,
  type DashboardTrendPoint,
} from "@amiri/shared";
import {
  Branch,
  LedgerAccount,
  LedgerEntry,
  Party,
  Reconciliation,
  Transaction,
} from "../../models/index.js";
import * as reports from "../../services/reports.service.js";
import * as khata from "../khata/khata.service.js";

/**
 * Dashboards (§31 SuperAdmin, §32 Branch, §33 Accountant).
 *
 * One builder, scoped by what the caller can see. A SuperAdmin gets the organisation and a
 * branch comparison; a scoped user gets their own branch and no comparison at all, because
 * showing them how other branches are performing is exactly the leak §3 forbids.
 *
 * §21 is visible in the shape of the response: `todayIn`/`todayOut` are CASH FLOW, while
 * `todayIncome`/`todayExpenses`/`todayProfit` are PROFIT. They sit in separate groups and
 * the UI labels them separately, because a day with ₹10,00,000 through the door can still
 * be a loss.
 */

export async function buildDashboard(options: {
  branchId?: string | null;
  isUnscoped: boolean;
  branchIds: Types.ObjectId[];
  /** Days of history for the trend charts. */
  trendDays?: number;
}): Promise<DashboardResponse> {
  const trendDays = options.trendDays ?? 30;
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const trendStart = new Date(todayStart.getTime() - (trendDays - 1) * 86_400_000);

  const branchId = options.branchId ?? undefined;

  /**
   * The scope filter for every aggregation below.
   *
   * A SuperAdmin with no branch selected sees everything. A scoped user always sees only
   * their own branches, whatever the request asked for — the filter is built from
   * `branchIds`, which came from their user record.
   */
  const branchMatch: Record<string, unknown> = branchId
    ? { branchId: new Types.ObjectId(branchId) }
    : options.isUnscoped
      ? {}
      : { branchId: { $in: options.branchIds } };

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
    reports.balanceByKind(["CASH"], branchId),
    reports.balanceByKind(["BANK"], branchId),
    reports.balanceByKind(["SAVINGS"], branchId),
    reports.partyPositions(branchId),
    reports.profitFor({ from: todayStart, to: todayEnd, branchId }),
    reports.profitFor({ from: monthStart, to: todayEnd, branchId }),
    reports.cashMovement({ from: todayStart, to: todayEnd, branchId }),
    buildTrend(branchMatch, trendStart, todayEnd),
    buildExpenseBreakdown(branchMatch, monthStart, todayEnd),
    buildRecent(branchMatch),
    buildTopParties(branchId, options.isUnscoped, options.branchIds),
    Transaction.countDocuments({ ...branchMatch, status: "PENDING" }),
    Reconciliation.countDocuments({ ...branchMatch, status: "IN_PROGRESS" }),
    Transaction.countDocuments({ ...branchMatch, date: { $gte: todayStart, $lte: todayEnd } }),
    khata.creditReport(branchMatch, { limit: 1 }),
  ]);

  // Branch comparison is for unscoped users only (§32: never show another branch's data).
  const branches = options.isUnscoped ? await buildBranchPerformance(monthStart, todayEnd) : [];

  const branch = branchId
    ? await Branch.findById(branchId).select("name code").lean()
    : null;

  return {
    scope: branchId ? "BRANCH" : "ORGANISATION",
    branch: branch ? { id: String(branch._id), name: branch.name, code: branch.code } : null,
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
    branches,
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
async function buildTrend(
  branchMatch: Record<string, unknown>,
  from: Date,
  to: Date,
): Promise<DashboardTrendPoint[]> {
  const rows = await LedgerEntry.aggregate<{
    _id: string;
    income: number;
    expenses: number;
    moneyIn: number;
    moneyOut: number;
  }>([
    { $match: { ...branchMatch, date: { $gte: from, $lte: to } } },
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
  branchMatch: Record<string, unknown>,
  from: Date,
  to: Date,
): Promise<Array<{ name: string; amount: number }>> {
  const rows = await LedgerEntry.aggregate<{ _id: Types.ObjectId; name: string; amount: number }>([
    { $match: { ...branchMatch, date: { $gte: from, $lte: to }, direction: "DEBIT" } },
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

async function buildRecent(branchMatch: Record<string, unknown>) {
  const txns = await Transaction.find(branchMatch)
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

async function buildTopParties(
  branchId: string | undefined,
  isUnscoped: boolean,
  branchIds: Types.ObjectId[],
) {
  const filter: Record<string, unknown> = { status: "ACTIVE" };
  if (branchId) filter.branchId = new Types.ObjectId(branchId);
  else if (!isUnscoped) filter.branchId = { $in: branchIds };

  const parties = await Party.find(filter).select("name ledgerAccountId").lean();
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

/** Branch comparison (§31). Unscoped callers only. */
async function buildBranchPerformance(from: Date, to: Date): Promise<BranchPerformance[]> {
  const branches = await Branch.find({ status: "ACTIVE" }).select("name code").sort({ code: 1 }).lean();

  return Promise.all(
    branches.map(async (branch) => {
      const id = String(branch._id);
      const [profit, cash, bank, positions] = await Promise.all([
        reports.profitFor({ from, to, branchId: id }),
        reports.balanceByKind(["CASH"], id),
        reports.balanceByKind(["BANK"], id),
        reports.partyPositions(id),
      ]);

      return {
        branchId: id,
        code: branch.code,
        name: branch.name,
        balance: cash + bank,
        income: profit.income,
        expenses: profit.expenses,
        profit: profit.profit,
        receivable: positions.receivable,
      };
    }),
  );
}
