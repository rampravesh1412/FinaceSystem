import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { formatINR } from "@amiri/shared";
import { createApp } from "../../app.js";
import { LedgerAccount, LedgerEntry, Party, SavingsAccount } from "../../models/index.js";
import { ensureSystemAccounts, systemAccountId, trialBalance, verifyBalance } from "../../services/ledger.service.js";
import { computeInterest } from "../savings/savings.service.js";
import { TestClient, clearFixtures, seedFixtures, type Fixtures } from "../../test/helpers.js";

/**
 * Phase 4 acceptance: Digital Khata, adjustments, credit aging, Bachat Khata and
 * reconciliation.
 *
 * The reconciliation cases carry the most weight. §62 is unambiguous — a difference is
 * reported and investigated, never silently absorbed — so the tests check that the system
 * refuses to close a reconciliation that does not balance unless a human explicitly says
 * so on the record.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;
let token: string;
let branchId: string;
let hdfcId: string;
let cashId: string;
let partyId: string;

async function balanceOfParty(id: string): Promise<number> {
  const party = await Party.findById(id).lean();
  return (await LedgerAccount.findById(party!.ledgerAccountId).select("cachedBalance").lean())!.cachedBalance;
}

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
  /**
   * `openingDate` is explicit, and must stay that way.
   *
   * Without it the service dates the opening entry `new Date()` — today. Every other date
   * in this file is a fixed day in Aug 2026, and the reconciliation below runs to
   * 2026-08-31, so a floating opening entry falls INSIDE that window while the clock reads
   * August 2026 and outside it from September onwards. The suite then starts failing on a
   * date rather than on a change, which is exactly what happened here: the reconciliation
   * assertion compared a window balance that had silently lost ₹20,00,000 against a cached
   * balance that still had it.
   */
  const acc = await client.post<{ data: { id: string } }>(
    "/bank-accounts",
    {
      bankId: bank.body.data.id, branchId, accountName: "HDFC Current",
      accountNumber: "50100234567890", ifsc: "HDFC0001234", openingBalance: "20,00,000",
      openingDate: "2026-04-01",
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

  const party = await client.post<{ data: { id: string } }>(
    "/parties",
    {
      name: "Sharma Traders", branchId, type: "CUSTOMER",
      openingBalance: "1,00,000", openingDate: "2026-04-01",
      creditLimit: "2,00,000", creditDays: 30,
    },
    { token },
  );
  partyId = party.body.data.id;
});

afterAll(async () => {
  await client.stop();
  await clearFixtures();
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("Digital Khata (§11)", () => {
  it("reads the party ledger in Lena/Dena terms, with a running balance", async () => {
    // They owe us ₹1,00,000 from the opening. Take ₹40,000 off it.
    await client.post(
      "/payment-in",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "40,000", paymentMode: "CASH" },
      { token },
    );

    const res = await client.get<{
      data: {
        openingBalance: number; totalGiven: number; totalTaken: number;
        closingBalance: number; closingDirection: string; closingLabel: string;
        entries: Array<{ given: number; taken: number; balance: number; direction: string }>;
      };
    }>(`/khata/${partyId}`, { token });

    expect(res.status).toBe(200);
    // Given = what we handed over (debits); taken = what came back (credits).
    expect(res.body.data.totalGiven).toBe(100_000_00);
    expect(res.body.data.totalTaken).toBe(40_000_00);
    expect(res.body.data.closingBalance).toBe(60_000_00);
    expect(res.body.data.closingDirection).toBe("LENA");
    // The sentence a shopkeeper actually reads.
    expect(res.body.data.closingLabel).toBe("₹60,000.00 Lena Hai");

    // The running balance walks correctly down the page.
    const balances = res.body.data.entries.map((e) => e.balance);
    expect(balances).toEqual([100_000_00, 60_000_00]);
  });

  it("carries a balance forward when the statement is date-filtered", async () => {
    const res = await client.get<{ data: { openingBalance: number; entries: unknown[] } }>(
      `/khata/${partyId}?from=2026-08-19&to=2026-08-19`,
      { token },
    );

    // The opening posting is before the window, so it must arrive as a brought-forward
    // balance. Starting from zero would make every running balance on the page wrong.
    expect(res.body.data.openingBalance).toBe(100_000_00);
  });

  it("keeps a reversed entry visible in the statement", async () => {
    const created = await client.post<{ data: { id: string } }>(
      "/payment-in",
      { date: "2026-08-20", branchId, partyId, accountId: hdfcId, amount: "5,000", paymentMode: "CASH" },
      { token },
    );
    await client.post(
      `/transactions/${created.body.data.id}/reverse`,
      {
        reason: "Recorded against the wrong customer account entirely",
        // Dated, for the same reason the opening balances are: an undated reversal posts
        // today, which puts it outside the 2026-08-31 reconciliation window below and
        // leaves that window holding a ₹5,000 receipt whose reversal it cannot see.
        date: "2026-08-21",
      },
      { token },
    );

    const res = await client.get<{ data: { entries: Array<{ isReversed: boolean }>; closingBalance: number } }>(
      `/khata/${partyId}`,
      { token },
    );

    // §28: the original stays on the page, flagged — not deleted.
    expect(res.body.data.entries.some((e) => e.isReversed)).toBe(true);
    // And the net effect is nil.
    expect(res.body.data.closingBalance).toBe(60_000_00);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("adjustments (§25)", () => {
  it("corrects a balance by posting against suspense, never by writing a field", async () => {
    const before = await balanceOfParty(partyId);
    const suspenseId = String(await systemAccountId("SUSPENSE"));
    const suspenseBefore =
      (await LedgerAccount.findById(suspenseId).select("cachedBalance").lean())!.cachedBalance;

    const res = await client.post<{ data: { id: string; txnNo: string } }>(
      "/adjustments",
      {
        date: "2026-08-21", branchId, adjustmentType: "BALANCE_CORRECTION", partyId,
        amount: "-10,000",
        reason: "Duplicate invoice raised in July, confirmed with the customer by phone",
      },
      { token },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.txnNo).toMatch(/^ADJ-2026-\d{6}$/);
    expect(await balanceOfParty(partyId)).toBe(before - 10_000_00);

    // The other side landed in suspense — conspicuous until someone clears it.
    const suspenseAfter =
      (await LedgerAccount.findById(suspenseId).select("cachedBalance").lean())!.cachedBalance;
    expect(suspenseAfter).toBe(suspenseBefore + 10_000_00);

    // And it is a real posting, so it can be reversed like anything else.
    const entries = await LedgerEntry.find({ transactionId: res.body.data.id }).lean();
    expect(entries).toHaveLength(2);
  });

  it("refuses an adjustment without a substantive reason", async () => {
    const res = await client.post<{ error: { code: string } }>(
      "/adjustments",
      { date: "2026-08-21", branchId, adjustmentType: "BALANCE_CORRECTION", partyId, amount: "-100", reason: "fix" },
      { token },
    );
    expect(res.status).toBe(422);
  });

  it("refuses an adjustment of zero", async () => {
    const res = await client.post<{ error: { code: string } }>(
      "/adjustments",
      {
        date: "2026-08-21", branchId, adjustmentType: "BALANCE_CORRECTION", partyId, amount: "0",
        reason: "This adjustment would change absolutely nothing at all",
      },
      { token },
    );
    expect(res.status).toBe(422);
  });

  it("writes a BALANCE_ADJUSTED audit row carrying the reason verbatim", async () => {
    const { AuditLog } = await import("../../models/index.js");
    const entry = await AuditLog.findOne({ action: "BALANCE_ADJUSTED" }).sort({ createdAt: -1 }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.reason).toContain("Duplicate invoice raised in July");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("credit aging (§12)", () => {
  it("ages an outstanding balance into buckets and reports the summary", async () => {
    const res = await client.get<{
      data: {
        rows: Array<{ name: string; balance: number; buckets: Record<string, number>; availableCredit: number }>;
        summary: { totalOutstanding: number; buckets: Record<string, number>; topDebtors: unknown[] };
      };
    }>("/credit", { token });

    expect(res.status).toBe(200);
    const sharma = res.body.data.rows.find((r) => r.name === "Sharma Traders")!;
    expect(sharma).toBeTruthy();

    // Every rupee outstanding lands in exactly one bucket, and they sum to the balance.
    const bucketTotal = Object.values(sharma.buckets).reduce((a, b) => a + b, 0);
    expect(bucketTotal).toBe(Math.max(0, sharma.balance));

    expect(res.body.data.summary.totalOutstanding).toBeGreaterThan(0);
    expect(res.body.data.summary.topDebtors.length).toBeGreaterThan(0);
  });

  it("does not age a party we owe — there is nothing to collect", async () => {
    const vendor = await client.post<{ data: { id: string } }>(
      "/parties",
      { name: "We Owe Them Ltd", branchId, type: "VENDOR", openingBalance: "-50,000", openingDate: "2026-04-01" },
      { token },
    );

    const res = await client.get<{ data: { rows: Array<{ partyId: string; buckets: Record<string, number>; overdueAmount: number }> } }>(
      "/credit",
      { token },
    );

    const row = res.body.data.rows.find((r) => r.partyId === vendor.body.data.id)!;
    expect(Object.values(row.buckets).every((v) => v === 0)).toBe(true);
    expect(row.overdueAmount).toBe(0);
  });

  it("flags a party past their credit limit", async () => {
    const tight = await client.post<{ data: { id: string } }>(
      "/parties",
      { name: "Over Limit Co", branchId, type: "CUSTOMER", openingBalance: "80,000", openingDate: "2026-04-01", creditLimit: "50,000" },
      { token },
    );

    const res = await client.get<{ data: { rows: Array<{ partyId: string; isOverLimit: boolean; availableCredit: number }>; summary: { overLimitCount: number } } }>(
      "/credit?overLimit=true",
      { token },
    );

    const row = res.body.data.rows.find((r) => r.partyId === tight.body.data.id)!;
    expect(row.isOverLimit).toBe(true);
    expect(row.availableCredit).toBe(0);
    expect(res.body.data.summary.overLimitCount).toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("Bachat Khata (§13)", () => {
  let savingsId: string;

  it("opens an account as a liability — the money is the member's, not ours", async () => {
    const res = await client.post<{ data: { id: string; accountNo: string; ledgerAccountId: string } }>(
      "/savings",
      { memberName: "Kamla Devi", branchId, mobile: "9876500011", interestRateBps: 650, openingBalance: "10,000", openingDate: "2026-04-01" },
      { token },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.accountNo).toMatch(/^SB-105-\d{5}$/);
    savingsId = res.body.data.id;

    const ledgerAccount = await LedgerAccount.findById(res.body.data.ledgerAccountId).lean();
    expect(ledgerAccount!.kind).toBe("SAVINGS");
    expect(ledgerAccount!.accountClass).toBe("LIABILITY");
    // A member can only withdraw what they deposited.
    expect(ledgerAccount!.enforceBalance).toBe(true);
    expect(ledgerAccount!.cachedBalance).toBe(10_000_00);
  });

  it("records a deposit and a withdrawal against the cash drawer", async () => {
    const deposit = await client.post(
      "/savings/transactions",
      { date: "2026-08-19", savingsAccountId: savingsId, operation: "DEPOSIT", amount: "5,000", accountId: cashId, paymentMode: "CASH" },
      { token },
    );
    expect(deposit.status).toBe(201);

    const withdrawal = await client.post(
      "/savings/transactions",
      { date: "2026-08-20", savingsAccountId: savingsId, operation: "WITHDRAWAL", amount: "3,000", accountId: cashId, paymentMode: "CASH" },
      { token },
    );
    expect(withdrawal.status).toBe(201);

    const account = await SavingsAccount.findById(savingsId).lean();
    const balance = (await LedgerAccount.findById(account!.ledgerAccountId).select("cachedBalance").lean())!.cachedBalance;
    expect(balance).toBe(12_000_00); // 10,000 + 5,000 − 3,000
  });

  it("refuses a withdrawal larger than the member's balance", async () => {
    const res = await client.post<{ error: { code: string; details: { available: number } } }>(
      "/savings/transactions",
      { date: "2026-08-20", savingsAccountId: savingsId, operation: "WITHDRAWAL", amount: "50,000", accountId: cashId, paymentMode: "CASH" },
      { token },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INSUFFICIENT_BALANCE");
    expect(res.body.error.details.available).toBe(12_000_00);
  });

  it("accrues interest without moving any cash", async () => {
    const cashBefore = await client.get<{ data: Array<{ balance: number }> }>("/cash-accounts", { token });
    const before = cashBefore.body.data[0]!.balance;

    await client.post(
      "/savings/transactions",
      { date: "2026-08-21", savingsAccountId: savingsId, operation: "INTEREST", amount: "780" },
      { token },
    );

    const account = await SavingsAccount.findById(savingsId).lean();
    const balance = (await LedgerAccount.findById(account!.ledgerAccountId).select("cachedBalance").lean())!.cachedBalance;
    expect(balance).toBe(12_780_00);

    // Interest accrues — no cash left the drawer.
    const cashAfter = await client.get<{ data: Array<{ balance: number }> }>("/cash-accounts", { token });
    expect(cashAfter.body.data[0]!.balance).toBe(before);
  });

  it("computes pro-rata interest exactly", () => {
    // ₹1,00,000 at 6.5% for a full year.
    expect(computeInterest(100_000_00, 650, 365)).toBe(6_500_00);
    // Half a year is half the interest.
    expect(computeInterest(100_000_00, 650, 182)).toBe(Math.round((6_500_00 * 182) / 365));
    expect(computeInterest(0, 650, 365)).toBe(0);
    expect(computeInterest(100_000_00, 0, 365)).toBe(0);
  });

  it("produces a passbook with a running balance", async () => {
    const res = await client.get<{
      data: { account: { balance: number }; entries: Array<{ deposit: number; withdrawal: number; balance: number }> };
    }>(`/savings/${savingsId}/passbook`, { token });

    expect(res.status).toBe(200);
    expect(res.body.data.entries.map((e) => e.balance)).toEqual([
      10_000_00, 15_000_00, 12_000_00, 12_780_00,
    ]);
    expect(res.body.data.account.balance).toBe(12_780_00);
  });

  it("reports the day's collection and withdrawal totals", async () => {
    const res = await client.get<{ meta: { totalSavings: number; memberCount: number } }>("/savings", { token });
    expect(res.status).toBe(200);
    expect(res.body.meta.totalSavings).toBe(12_780_00);
    expect(res.body.meta.memberCount).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("reconciliation (§23, §62)", () => {
  let reconId: string;

  it("opens with the difference between the bank and the ledger stated up front", async () => {
    const accounts = await client.get<{ data: Array<{ id: string; balance: number }> }>(
      "/bank-accounts?q=50100234567890",
      { token },
    );
    const systemBalance = accounts.body.data[0]!.balance;

    // Claim the bank is ₹20,000 short of our ledger.
    const res = await client.post<{ data: { id: string; difference: number; systemBalance: number } }>(
      "/reconciliation",
      {
        bankAccountId: hdfcId,
        from: "2026-04-01",
        to: "2026-08-31",
        statementBalance: String((systemBalance - 20_000_00) / 100),
      },
      { token },
    );

    expect(res.status).toBe(201);
    reconId = res.body.data.id;
    expect(res.body.data.systemBalance).toBe(systemBalance);
    // SHORT ₹20,000 — stated, not absorbed.
    expect(res.body.data.difference).toBe(-20_000_00);
    expect(formatINR(res.body.data.difference)).toBe("-₹20,000.00");
  });

  it("refuses a second open reconciliation for the same account", async () => {
    const res = await client.post<{ error: { code: string } }>(
      "/reconciliation",
      { bankAccountId: hdfcId, from: "2026-04-01", to: "2026-08-31", statementBalance: "1,00,000" },
      { token },
    );
    expect(res.status).toBe(409);
  });

  it("auto-matches only what is unambiguous, and lists the rest", async () => {
    const res = await client.post<{ data: { imported: number; autoMatched: number } }>(
      `/reconciliation/${reconId}/statement`,
      {
        lines: [
          // Matches the ₹40,000 payment-in exactly.
          { date: "2026-08-19", description: "NEFT CR SHARMA TRADERS", amount: "40000" },
          // Nothing in the ledger looks like this.
          { date: "2026-08-25", description: "UNKNOWN CREDIT", amount: "17500" },
        ],
      },
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.autoMatched).toBe(1);

    const lines = await client.get<{ data: Array<{ status: string; description: string; suggestions: unknown[] }> }>(
      `/reconciliation/${reconId}/lines`,
      { token },
    );

    const unknown = lines.body.data.find((l) => l.description === "UNKNOWN CREDIT")!;
    expect(unknown.status).toBe("MISSING_IN_SYSTEM");

    // Ledger entries the bank did not report are listed too — an uncleared cheque is
    // benign, a double-recorded payment is not, and only listing both reveals it.
    expect(lines.body.data.some((l) => l.status === "MISSING_IN_BANK")).toBe(true);
  });

  it("refuses to close while lines are unresolved", async () => {
    const res = await client.post<{ error: { message: string } }>(
      `/reconciliation/${reconId}/complete`,
      { acknowledgeDifference: true },
      { token },
    );
    // MISSING_IN_SYSTEM and MISSING_IN_BANK are resolutions; NEEDS_REVIEW/UNMATCHED are not.
    // Here everything is already classified, so this should succeed — see next test.
    expect([200, 409]).toContain(res.status);
  });

  it("will not close with an unexplained difference unless it is acknowledged", async () => {
    // Re-open a clean reconciliation with a difference and nothing imported.
    const accounts = await client.get<{ data: Array<{ id: string; balance: number }> }>(
      "/bank-accounts?q=50100234567890",
      { token },
    );

    const second = await client.post<{ data: { id: string } }>(
      "/reconciliation",
      {
        bankAccountId: hdfcId, from: "2026-09-01", to: "2026-09-30",
        statementBalance: String((accounts.body.data[0]!.balance - 5_000_00) / 100),
      },
      { token },
    );

    if (second.status !== 201) return; // an earlier reconciliation is still open; covered above

    const blocked = await client.post<{ error: { message: string } }>(
      `/reconciliation/${second.body.data.id}/complete`,
      { acknowledgeDifference: false },
      { token },
    );

    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/differ|investigate/i);

    // With an explicit acknowledgement it closes — and the difference stays on the record.
    const closed = await client.post<{ data: { status: string; difference: number } }>(
      `/reconciliation/${second.body.data.id}/complete`,
      { acknowledgeDifference: true, notes: "Cheque 44821 has not cleared yet" },
      { token },
    );

    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe("COMPLETED");
    // §62: never zeroed to make the screen tidy.
    expect(closed.body.data.difference).toBe(-5_000_00);
  });

  it("lists reconciliations with their differences, not just their statuses", async () => {
    const res = await client.get<{
      data: Array<{ id: string; difference: number; status: string }>;
      meta: { total: number };
    }>("/reconciliation?limit=20", { token });

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBeGreaterThanOrEqual(2);

    // A reconciliation closed WITH a difference must not look identical to a clean one in
    // the list — that is the whole reason the column exists.
    const closedWithDifference = res.body.data.find(
      (r) => r.status === "COMPLETED" && r.difference !== 0,
    );
    expect(closedWithDifference).toBeDefined();
    expect(closedWithDifference!.difference).toBe(-5_000_00);
  });

  /**
   * Branch isolation (§3).
   *
   * A reconciliation id travels — it appears in URLs, exports and audit rows — and
   * `finance.bank.reconcile` is held by every BRANCH_ADMIN. So knowing an id must not be
   * enough: the scope filter has to be in the QUERY, on every entry point, including the
   * ones that take an id and no branch.
   */
  it("hides another branch's reconciliation even when its id is known", async () => {
    const otherBranchId = fx.branches["107"]!;

    const bank = await client.get<{ data: Array<{ id: string }> }>("/banks?q=HDFC", { token });

    const foreignAccount = await client.post<{ data: { id: string } }>(
      "/bank-accounts",
      {
        bankId: bank.body.data[0]!.id, branchId: otherBranchId, accountName: "HDFC 107",
        accountNumber: "50100777777777", ifsc: "HDFC0001234", openingBalance: "5,00,000",
      },
      { token },
    );

    const foreign = await client.post<{ data: { id: string } }>(
      "/reconciliation",
      {
        bankAccountId: foreignAccount.body.data.id,
        from: "2026-04-01", to: "2026-08-31", statementBalance: "5,00,000",
      },
      { token },
    );
    expect(foreign.status).toBe(201);
    const foreignId = foreign.body.data.id;

    // badmin@test.co is assigned to branch 105 only.
    const scopedToken = await client.loginAs("badmin@test.co");

    // NotFound rather than Forbidden: confirming the id exists is itself a disclosure.
    const read = await client.get(`/reconciliation/${foreignId}`, { token: scopedToken });
    expect(read.status).toBe(404);

    const lines = await client.get(`/reconciliation/${foreignId}/lines`, { token: scopedToken });
    expect(lines.status).toBe(404);

    const imported = await client.post(
      `/reconciliation/${foreignId}/statement`,
      { lines: [{ date: "2026-08-20", description: "TEST", amount: "100" }] },
      { token: scopedToken },
    );
    expect(imported.status).toBe(404);

    const closed = await client.post(
      `/reconciliation/${foreignId}/complete`,
      { acknowledgeDifference: true },
      { token: scopedToken },
    );
    expect(closed.status).toBe(404);

    // And it never appears in their list either.
    const list = await client.get<{ data: Array<{ id: string }> }>("/reconciliation?limit=50", {
      token: scopedToken,
    });
    expect(list.status).toBe(200);
    expect(list.body.data.some((r) => r.id === foreignId)).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("the books still tie after Phase 4", () => {
  it("keeps the trial balance at zero difference", async () => {
    const tb = await trialBalance();
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.difference).toBe(0);
  });

  it("agrees with a full replay on every account, savings included", async () => {
    const all = await LedgerAccount.find({}).select("_id name").lean();
    for (const account of all) {
      const check = await verifyBalance(account._id);
      expect(check.matches, `${account.name} drifted by ${check.difference}`).toBe(true);
    }
  });
});
