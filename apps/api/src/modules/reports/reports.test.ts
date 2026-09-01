import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { formatINR, type MonthlyHistory } from "@amiri/shared";
import { createApp } from "../../app.js";
import { CashAccount, ExpenseCategory, IncomeHead } from "../../models/index.js";
import { ensureSystemAccounts, trialBalance } from "../../services/ledger.service.js";
import { TestClient, clearFixtures, seedFixtures, type Fixtures } from "../../test/helpers.js";

/**
 * Phase 5 acceptance: reports, dashboards and the daily cash tally.
 *
 * Two things carry the weight here.
 *
 * §21 — CASH FLOW IS NOT PROFIT. The suite deliberately constructs a day where the two
 * diverge sharply, then asserts that the system reports them as different numbers.
 *
 * §62 — a cash shortfall is REPORTED, not absorbed. The tally must record SHORT and leave
 * the ledger untouched.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;
let token: string;
let branchId: string;
let hdfcId: string;
let cashId: string;
let cashAccountId: string;
let partyId: string;
let salaryHeadId: string;
let commissionHeadId: string;

beforeAll(async () => {
  await clearFixtures();
  fx = await seedFixtures();
  await ensureSystemAccounts();

  app = createApp();
  client = new TestClient();
  await client.start(app);
  token = await client.loginAs("super@test.co");
  branchId = fx.branches["105"]!;

  const bank = await client.post<{ data: { id: string } }>(
    "/banks",
    { name: "HDFC Bank", shortName: "HDFC", ifscPrefix: "HDFC" },
    { token },
  );
  const acc = await client.post<{ data: { id: string } }>(
    "/bank-accounts",
    {
      bankId: bank.body.data.id, branchId, accountName: "HDFC Current",
      accountNumber: "50100234567890", ifsc: "HDFC0001234",
      openingBalance: "10,00,000", openingDate: "2026-04-01",
    },
    { token },
  );
  hdfcId = acc.body.data.id;

  const cash = await client.post<{ data: { id: string } }>(
    "/cash-accounts",
    { branchId, name: "Main Counter", openingBalance: "1,00,000", openingDate: "2026-04-01" },
    { token },
  );
  cashId = cash.body.data.id;
  cashAccountId = cashId;

  const party = await client.post<{ data: { id: string } }>(
    "/parties",
    {
      name: "Sharma Traders", branchId, type: "CUSTOMER",
      openingBalance: "5,00,000", openingDate: "2026-04-01", creditDays: 30,
    },
    { token },
  );
  partyId = party.body.data.id;

  const salary = await client.post<{ data: { id: string } }>(
    "/expenses/categories", { name: "Salary" }, { token },
  );
  salaryHeadId = salary.body.data.id;

  const commission = await client.post<{ data: { id: string } }>(
    "/income/heads", { name: "Commission" }, { token },
  );
  commissionHeadId = commission.body.data.id;
});

afterAll(async () => {
  await client.stop();
  await clearFixtures();
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("cash flow is not profit (§21)", () => {
  it("reports a large cash inflow that produces no profit at all", async () => {
    const day = "2026-08-19";

    /**
     * A party settling ₹4,00,000 of what they already owed.
     *
     * ₹4,00,000 arrives in the bank — a large cash inflow. But no income was EARNED: the
     * receivable simply turned into cash. Profit for the day is zero. A system that
     * counted receipts as revenue would report a spectacular and entirely fictional day.
     */
    await client.post(
      "/payment-in",
      { date: day, branchId, partyId, accountId: hdfcId, amount: "4,00,000", paymentMode: "NEFT" },
      { token },
    );

    const pnl = await client.get<{
      data: { totalIncome: number; totalExpenses: number; netProfit: number; cashMovement: number };
    }>(`/reports/profit-loss?from=${day}&to=${day}&branchId=${branchId}`, { token });

    expect(pnl.status).toBe(200);
    // No income was earned.
    expect(pnl.body.data.totalIncome).toBe(0);
    expect(pnl.body.data.netProfit).toBe(0);
    // But ₹4,00,000 of cash moved — reported ALONGSIDE the profit, never inside it.
    expect(pnl.body.data.cashMovement).toBe(400_000_00);
  });

  it("reports profit on a day where barely any cash moves", async () => {
    const day = "2026-08-20";

    // Commission earned, but booked against the party rather than banked. Income is real;
    // cash movement is nil.
    await client.post(
      "/expenses",
      { date: day, branchId, categoryId: salaryHeadId, partyId, amount: "20,000", taxAmount: "0" },
      { token },
    );
    await client.post(
      "/income",
      { date: day, branchId, headId: commissionHeadId, accountId: hdfcId, amount: "1,50,000", paymentMode: "UPI" },
      { token },
    );

    const pnl = await client.get<{
      data: { totalIncome: number; totalExpenses: number; netProfit: number; cashMovement: number; margin: number };
    }>(`/reports/profit-loss?from=${day}&to=${day}&branchId=${branchId}`, { token });

    expect(pnl.body.data.totalIncome).toBe(150_000_00);
    expect(pnl.body.data.totalExpenses).toBe(20_000_00);
    expect(pnl.body.data.netProfit).toBe(130_000_00);

    // The salary was booked as a payable, so only the ₹1,50,000 commission touched cash —
    // profit ₹1,30,000 against cash movement ₹1,50,000. Two different numbers, correctly.
    expect(pnl.body.data.cashMovement).toBe(150_000_00);
    expect(pnl.body.data.netProfit).not.toBe(pnl.body.data.cashMovement);
  });

  it("expresses margin as a share of income", async () => {
    const pnl = await client.get<{ data: { margin: number; netProfit: number; totalIncome: number } }>(
      `/reports/profit-loss?from=2026-08-20&to=2026-08-20&branchId=${branchId}`,
      { token },
    );
    const { margin, netProfit, totalIncome } = pnl.body.data;
    expect(margin).toBeCloseTo((netProfit / totalIncome) * 100, 5);
  });

  it("splits charges out of expenses so commission stays traceable (§18)", async () => {
    const day = "2026-08-21";
    await client.post(
      "/bank-transfers",
      {
        date: day, branchId, sourceAccountId: hdfcId, destinationAccountId: cashId,
        amount: "50,000", manualCharge: "50",
      },
      { token },
    );

    const pnl = await client.get<{ data: { totalExpenses: number; totalCharges: number } }>(
      `/reports/profit-loss?from=${day}&to=${day}&branchId=${branchId}`,
      { token },
    );

    expect(pnl.body.data.totalCharges).toBe(50_00);
    // Charges are part of expenses, but reported as their own subtotal rather than
    // dissolving into "other".
    expect(pnl.body.data.totalExpenses).toBeGreaterThanOrEqual(pnl.body.data.totalCharges);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("balance sheet (§34)", () => {
  it("balances: assets equal liabilities plus equity", async () => {
    const res = await client.get<{
      data: {
        totalAssets: number; totalLiabilities: number; totalEquity: number;
        retainedEarnings: number; difference: number; balances: boolean;
      };
    }>("/reports/balance-sheet", { token });

    expect(res.status).toBe(200);
    // The accounting identity. Any other result means the ledger is broken.
    expect(res.body.data.difference).toBe(0);
    expect(res.body.data.balances).toBe(true);
    expect(res.body.data.totalAssets).toBe(
      res.body.data.totalLiabilities + res.body.data.totalEquity,
    );
  });

  it("folds profit into equity as retained earnings", async () => {
    const [sheet, pnl] = await Promise.all([
      client.get<{ data: { retainedEarnings: number } }>("/reports/balance-sheet", { token }),
      client.get<{ data: { netProfit: number } }>(
        "/reports/profit-loss?from=2026-04-01&to=2026-12-31",
        { token },
      ),
    ]);

    // Income and expense accounts are never closed into equity by this system — doing so
    // would rewrite history at year end. They are folded in at report time instead, which
    // is exactly what makes the sheet balance.
    expect(sheet.body.data.retainedEarnings).toBe(pnl.body.data.netProfit);
  });

  it("puts a party we owe on the liability side", async () => {
    const vendor = await client.post<{ data: { id: string } }>(
      "/parties",
      { name: "Vendor We Owe", branchId, type: "VENDOR", openingBalance: "-75,000", openingDate: "2026-04-01" },
      { token },
    );
    expect(vendor.status).toBe(201);

    const res = await client.get<{
      data: { liabilities: Array<{ name: string; amount: number }>; assets: Array<{ name: string }>; difference: number };
    }>("/reports/balance-sheet", { token });

    const liability = res.body.data.liabilities.find((l) => l.name.includes("Vendor We Owe"));
    expect(liability).toBeTruthy();
    // Shown as a positive amount on the liability side, not a negative asset.
    expect(liability!.amount).toBe(75_000_00);
    expect(res.body.data.assets.some((a) => a.name.includes("Vendor We Owe"))).toBe(false);
    expect(res.body.data.difference).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("cash flow report", () => {
  it("walks a running balance day by day from the opening position", async () => {
    const res = await client.get<{
      data: {
        openingBalance: number; totalIn: number; totalOut: number; closingBalance: number;
        rows: Array<{ date: string; openingBalance: number; closingBalance: number; moneyIn: number; moneyOut: number }>;
      };
    }>(`/reports/cash-flow?from=2026-08-19&to=2026-08-21&branchId=${branchId}`, { token });

    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);

    // Each day opens where the previous one closed.
    for (let i = 1; i < res.body.data.rows.length; i += 1) {
      expect(res.body.data.rows[i]!.openingBalance).toBe(res.body.data.rows[i - 1]!.closingBalance);
    }

    // And the arithmetic holds end to end.
    const last = res.body.data.rows.at(-1)!;
    expect(last.closingBalance).toBe(
      res.body.data.openingBalance + res.body.data.totalIn - res.body.data.totalOut,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("daily cash tally (§20, §62)", () => {
  const day = "2026-08-21";

  it("derives the expected closing from the ledger, not from anything typed in", async () => {
    const res = await client.get<{
      data: {
        openingCash: number; cashReceived: number; cashPaid: number;
        adjustments: number; expectedClosing: number; actualClosing: number | null; status: string;
      };
    }>(`/cash-tally?cashAccountId=${cashAccountId}&date=${day}`, { token });

    expect(res.status).toBe(200);
    const t = res.body.data;

    // The ₹50,000 transfer landed in the drawer on this day.
    expect(t.cashReceived).toBe(50_000_00);
    expect(t.expectedClosing).toBe(t.openingCash + t.cashReceived - t.cashPaid + t.adjustments);
    // Nothing counted yet.
    expect(t.actualClosing).toBeNull();
    expect(t.status).toBe("PENDING");
  });

  it("records SHORT when the drawer holds less than expected — and does not touch the ledger", async () => {
    const before = await client.get<{ data: { expectedClosing: number } }>(
      `/cash-tally?cashAccountId=${cashAccountId}&date=${day}`,
      { token },
    );
    const expected = before.body.data.expectedClosing;

    const cashAccount = await CashAccount.findById(cashAccountId).lean();
    const { LedgerAccount } = await import("../../models/index.js");
    const ledgerBefore =
      (await LedgerAccount.findById(cashAccount!.ledgerAccountId).select("cachedBalance").lean())!.cachedBalance;

    const res = await client.post<{
      data: { expectedClosing: number; actualClosing: number; difference: number; status: string };
      message: string;
    }>(
      "/cash-tally",
      {
        date: day, branchId, cashAccountId,
        actualClosing: String((expected - 20_000_00) / 100),
        notes: "Counted twice; ₹20,000 unaccounted for",
      },
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SHORT");
    expect(res.body.data.difference).toBe(-20_000_00);
    expect(formatINR(res.body.data.difference)).toBe("-₹20,000.00");
    expect(res.body.message).toMatch(/SHORT/);

    /**
     * THE POINT OF §62.
     *
     * The expectation was NOT lowered to match the count, and no adjustment was quietly
     * posted to make the drawer agree. The ledger is exactly as it was; the discrepancy
     * stands on the record until somebody finds the missing transaction.
     */
    expect(res.body.data.expectedClosing).toBe(expected);
    const ledgerAfter =
      (await LedgerAccount.findById(cashAccount!.ledgerAccountId).select("cachedBalance").lean())!.cachedBalance;
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  it("records EXCESS when the drawer holds more than expected", async () => {
    const t = await client.get<{ data: { expectedClosing: number } }>(
      `/cash-tally?cashAccountId=${cashAccountId}&date=2026-08-22`,
      { token },
    );

    const res = await client.post<{ data: { status: string; difference: number } }>(
      "/cash-tally",
      {
        date: "2026-08-22", branchId, cashAccountId,
        actualClosing: String((t.body.data.expectedClosing + 500_00) / 100),
        notes: "Extra ₹500 in the drawer, source unknown",
      },
      { token },
    );

    expect(res.body.data.status).toBe("EXCESS");
    expect(res.body.data.difference).toBe(500_00);
  });

  it("records MATCHED when the count agrees exactly", async () => {
    const t = await client.get<{ data: { expectedClosing: number } }>(
      `/cash-tally?cashAccountId=${cashAccountId}&date=2026-08-23`,
      { token },
    );

    const res = await client.post<{ data: { status: string; difference: number }; message: string }>(
      "/cash-tally",
      {
        date: "2026-08-23", branchId, cashAccountId,
        actualClosing: String(t.body.data.expectedClosing / 100),
      },
      { token },
    );

    expect(res.body.data.status).toBe("MATCHED");
    expect(res.body.data.difference).toBe(0);
    expect(res.body.message).toMatch(/tallies exactly/i);
  });

  it("shows the day's profit alongside the cash figures, computed separately (§21)", async () => {
    const res = await client.get<{
      data: { todayProfit: number; totalExpenses: number; partyGiven: number; partyTaken: number; netPartyMovement: number };
    }>(`/cash-tally?cashAccountId=${cashAccountId}&date=2026-08-20`, { token });

    // The AMIRI workbook's own fields, preserved.
    expect(res.body.data).toHaveProperty("todayProfit");
    expect(res.body.data).toHaveProperty("partyGiven");
    expect(res.body.data.netPartyMovement).toBe(
      res.body.data.partyGiven - res.body.data.partyTaken,
    );
  });

  it("writes an audit row naming the counted and expected figures", async () => {
    const { AuditLog } = await import("../../models/index.js");
    const entry = await AuditLog.findOne({ entity: "DailyCashTally", action: "BALANCE_ADJUSTED" })
      .sort({ createdAt: -1 })
      .lean();

    expect(entry).toBeTruthy();
    expect(entry!.reason).toMatch(/Counted .* expected .* (SHORT|EXCESS)/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("dashboard (§31, §32, §33)", () => {
  it("separates cash flow from profit in the metrics", async () => {
    const res = await client.get<{
      data: {
        scope: string;
        metrics: {
          todayIn: number; todayOut: number; todayNet: number;
          todayIncome: number; todayExpenses: number; todayProfit: number;
          cashBalance: number; bankBalance: number; totalBalance: number;
          receivable: number; payable: number;
        };
        branches: unknown[];
        trend: Array<{ date: string }>;
      };
    }>("/dashboard", { token });

    expect(res.status).toBe(200);
    const m = res.body.data.metrics;

    // Two distinct groups. Nothing in the response adds one to the other.
    expect(m.todayNet).toBe(m.todayIn - m.todayOut);
    expect(m.todayProfit).toBe(m.todayIncome - m.todayExpenses);
    expect(m.totalBalance).toBe(m.cashBalance + m.bankBalance);

    // A super admin sees the organisation and the branch comparison.
    expect(res.body.data.scope).toBe("ORGANISATION");
    expect(res.body.data.branches.length).toBeGreaterThan(0);
  });

  it("fills quiet days in the trend so the axis stays even", async () => {
    const res = await client.get<{ data: { trend: Array<{ date: string }> } }>(
      "/dashboard?days=14",
      { token },
    );
    expect(res.body.data.trend).toHaveLength(14);

    // Consecutive, with no gaps where nothing happened.
    for (let i = 1; i < res.body.data.trend.length; i += 1) {
      const prev = new Date(res.body.data.trend[i - 1]!.date).getTime();
      const curr = new Date(res.body.data.trend[i]!.date).getTime();
      expect(curr - prev).toBe(86_400_000);
    }
  });

  it("gives a scoped user their own branch and NO branch comparison (§32)", async () => {
    const accountant = await client.loginAs("acct@test.co");
    const res = await client.get<{
      data: { scope: string; branch: { code: string } | null; branches: unknown[] };
    }>("/dashboard", { token: accountant });

    expect(res.status).toBe(200);
    expect(res.body.data.scope).toBe("BRANCH");
    expect(res.body.data.branch?.code).toBe("105");
    // Showing another branch's performance to a scoped user is exactly the leak §3 forbids.
    expect(res.body.data.branches).toHaveLength(0);
  });

  it("refuses a scoped user's request for another branch's dashboard", async () => {
    const accountant = await client.loginAs("acct@test.co");
    const res = await client.get<{ error: { code: string } }>(
      `/dashboard?branchId=${fx.branches["107"]}`,
      { token: accountant },
    );
    expect(res.status).toBe(403);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("export", () => {
  it("serves a real P&L export, replacing the phase-5 placeholder", async () => {
    // This assertion used to check for an honest 501 while export was unbuilt (§66).
    // Phase 7 implemented it, so the test now checks the real thing rather than being
    // deleted — the behaviour it guarded moved rather than disappeared.
    const res = await fetch(
      `${client.baseUrl}/api/v1/export/profit-loss?from=2026-08-01&to=2026-08-31&format=csv`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("Profit & Loss");
    expect(text).toContain("NET PROFIT");
    // §21 survives into the file: cash movement is labelled as the different question.
    expect(text).toMatch(/Cash movement.*NOT profit/i);
  });
});

describe("monthly history", () => {
  const RANGE = "from=2026-04-01&to=2026-08-31";

  async function history() {
    const res = await client.get<{ data: MonthlyHistory }>(
      `/reports/monthly-history?${RANGE}&branchId=${branchId}`,
      { token },
    );
    expect(res.status).toBe(200);
    return res.body.data;
  }

  it("returns every month in the range, including ones with no trading at all", async () => {
    const data = await history();

    // April through August inclusive — five rows, in order, with no gaps.
    expect(data.months.map((m) => m.month)).toEqual([
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
    ]);
    expect(data.months[0]!.label).toBe("Apr 2026");

    // A month nobody traded in is a row of zeros, not a missing row. The distinction is
    // the difference between "nothing happened" and "the report is broken".
    for (const month of data.months) {
      if (month.entries === 0) {
        expect(month.income).toBe(0);
        expect(month.expenses).toBe(0);
        expect(month.netProfit).toBe(0);
      }
    }
  });

  /**
   * The figure that matters most: a month's row must say the same thing the P&L says for
   * that identical window. Two code paths computing profit differently is precisely how a
   * summary table drifts from the report it summarises.
   */
  it("agrees with the P&L run over the same window", async () => {
    const data = await history();
    const august = data.months.find((m) => m.month === "2026-08")!;

    const pnl = await client.get<{
      data: { totalIncome: number; totalExpenses: number; netProfit: number; totalCharges: number };
    }>(`/reports/profit-loss?from=2026-08-01&to=2026-08-31&branchId=${branchId}`, { token });

    expect(august.income).toBe(pnl.body.data.totalIncome);
    expect(august.expenses).toBe(pnl.body.data.totalExpenses);
    expect(august.netProfit).toBe(pnl.body.data.netProfit);
    expect(august.charges).toBe(pnl.body.data.totalCharges);
  });

  it("totals the months rather than recomputing them", async () => {
    const data = await history();

    expect(data.totals.income).toBe(data.months.reduce((s, m) => s + m.income, 0));
    expect(data.totals.expenses).toBe(data.months.reduce((s, m) => s + m.expenses, 0));
    expect(data.totals.netProfit).toBe(data.totals.income - data.totals.expenses);
  });

  /**
   * `partyClosing` is a position carried forward, not a movement. Each month must equal
   * the previous close plus that month's net — otherwise it is just the month's activity
   * mislabelled as a balance, which is the bug this assertion exists to catch.
   */
  it("carries the party balance forward month to month", async () => {
    const data = await history();

    for (let i = 1; i < data.months.length; i += 1) {
      const previous = data.months[i - 1]!;
      const current = data.months[i]!;
      expect(current.partyClosing).toBe(
        previous.partyClosing + current.partyPaid - current.partyReceived,
      );
    }

    // The opening balance was posted on 2026-04-01, so April must already carry it.
    expect(data.months[0]!.partyClosing).not.toBe(0);
  });

  it("ranks the best and worst months only among those that traded", async () => {
    const data = await history();
    const traded = data.months.filter((m) => m.entries > 0);

    if (traded.length > 0) {
      const best = data.months.find((m) => m.month === data.bestMonth)!;
      const worst = data.months.find((m) => m.month === data.worstMonth)!;
      expect(best.entries).toBeGreaterThan(0);
      expect(worst.entries).toBeGreaterThan(0);
      for (const month of traded) {
        expect(best.netProfit).toBeGreaterThanOrEqual(month.netProfit);
        expect(worst.netProfit).toBeLessThanOrEqual(month.netProfit);
      }
    }
  });

  it("refuses a caller who may see reports but not the P&L", async () => {
    // ACCOUNTANT holds `reports.view` but not `reports.pnl`. These rows carry the profit
    // figure, so the narrower permission is the one that governs them.
    const acctToken = await client.loginAs("acct@test.co");
    const res = await client.get<{ error: { code: string } }>(
      `/reports/monthly-history?${RANGE}`,
      { token: acctToken },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("the books still tie after Phase 5", () => {
  it("keeps the trial balance at zero difference", async () => {
    const tb = await trialBalance();
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.difference).toBe(0);
  });

  it("keeps the seeded heads intact", async () => {
    expect(await ExpenseCategory.countDocuments({})).toBeGreaterThan(0);
    expect(await IncomeHead.countDocuments({})).toBeGreaterThan(0);
  });
});
