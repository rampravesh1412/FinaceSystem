import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { AuditLog, FinancialPeriod, LedgerAccount, LedgerEntry, Transaction } from "../../models/index.js";
import { ensureSystemAccounts, trialBalance } from "../../services/ledger.service.js";
import { TestClient, clearFixtures, seedFixtures, type Fixtures } from "../../test/helpers.js";

/**
 * Phase 6 acceptance: approvals (§27), financial periods (§35), audit log (§26).
 *
 * The load-bearing assertion in this file: a transaction awaiting approval has **no ledger
 * entries and moves no balance**. Money nobody authorised must not move, not even briefly
 * and reversibly.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;
let superToken: string;
let adminToken: string;
let branchId: string;
let hdfcId: string;
let partyId: string;

async function bankBalance(): Promise<number> {
  const { BankAccount } = await import("../../models/index.js");
  const account = await BankAccount.findById(hdfcId).lean();
  return (await LedgerAccount.findById(account!.ledgerAccountId).select("cachedBalance").lean())!.cachedBalance;
}

async function setThresholds(enabled: boolean, minimum = "10,000") {
  return client.request("PUT", "/approvals/settings", {
    token: superToken,
    body: {
      enabled,
      minimumAmount: minimum,
      tiers: [
        { from: "0", to: "50,000", tier: "BRANCH_ADMIN" },
        { from: "50,000.01", to: "5,00,000", tier: "BRANCH_ADMIN" },
        { from: "5,00,000.01", to: null, tier: "SUPER_ADMIN" },
      ],
      appliesTo: [],
    },
  });
}

beforeAll(async () => {
  await clearFixtures();
  fx = await seedFixtures();
  await ensureSystemAccounts();

  app = createApp();
  client = new TestClient();
  await client.start(app);
  superToken = await client.loginAs("super@test.co");
  adminToken = await client.loginAs("badmin@test.co");
  branchId = fx.branches["105"]!;

  const bank = await client.post<{ data: { id: string } }>(
    "/banks", { name: "HDFC Bank", shortName: "HDFC", ifscPrefix: "HDFC" }, { token: superToken },
  );
  const acc = await client.post<{ data: { id: string } }>(
    "/bank-accounts",
    {
      bankId: bank.body.data.id, branchId, accountName: "HDFC Current",
      accountNumber: "50100234567890", ifsc: "HDFC0001234",
      openingBalance: "50,00,000", openingDate: "2026-04-01",
    },
    { token: superToken },
  );
  hdfcId = acc.body.data.id;

  const party = await client.post<{ data: { id: string } }>(
    "/parties",
    { name: "Sharma Traders", branchId, type: "CUSTOMER", openingBalance: "0", openingDate: "2026-04-01" },
    { token: superToken },
  );
  partyId = party.body.data.id;
});

afterAll(async () => {
  await client.stop();
  await clearFixtures();
});

beforeEach(async () => {
  // Each suite decides its own thresholds; leaving them on would leak into the period
  // and audit tests.
  await setThresholds(false);
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("approval workflow (§27)", () => {
  it("posts immediately when approvals are switched off", async () => {
    const before = await bankBalance();

    const res = await client.post<{ data: { txnNo: string; status: string } }>(
      "/payment-in",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "9,00,000", paymentMode: "NEFT" },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("COMPLETED");
    expect(await bankBalance()).toBe(before + 900_000_00);
  });

  it("lets a small amount through even when approvals are on", async () => {
    await setThresholds(true, "10,000");
    const before = await bankBalance();

    // Below the ₹10,000 minimum — a day of small receipts should not fill the queue.
    const res = await client.post<{ data: { status: string } }>(
      "/payment-in",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "5,000", paymentMode: "CASH" },
      { token: superToken },
    );

    expect(res.body.data.status).toBe("COMPLETED");
    expect(await bankBalance()).toBe(before + 5_000_00);
  });

  it("HOLDS a large amount and moves NO money at all", async () => {
    await setThresholds(true, "10,000");
    const before = await bankBalance();
    const entriesBefore = await LedgerEntry.countDocuments({});

    const res = await client.post<{ data: { id: string; status: string; txnNo: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "80,000", paymentMode: "NEFT" },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("PENDING");

    /**
     * THE POINT OF THE WHOLE PHASE.
     *
     * The balance has not moved and not one ledger entry exists. The alternative design —
     * post now, reverse on rejection — would have ₹80,000 leaving a real account before
     * anybody authorised it.
     */
    expect(await bankBalance()).toBe(before);
    expect(await LedgerEntry.countDocuments({})).toBe(entriesBefore);

    // The voucher number is provisional, so a rejected request never consumes one from
    // the PAY-OUT sequence.
    expect(res.body.data.txnNo).toMatch(/^PENDING-/);

    // But the postings that WILL be written are stored, so the approver sees exactly what
    // the submitter saw.
    const stored = await Transaction.findById(res.body.data.id).lean<{ pendingLines?: unknown[] }>();
    expect(stored!.pendingLines).toHaveLength(2);
  });

  it("posts for real on approval, with a proper voucher number", async () => {
    await setThresholds(true, "10,000");
    const before = await bankBalance();

    const submitted = await client.post<{ data: { id: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "75,000", paymentMode: "NEFT" },
      { token: superToken },
    );

    // Approved by someone OTHER than the submitter.
    const approved = await client.post<{ data: { txnNo: string; status: string } }>(
      `/approvals/${submitted.body.data.id}/approve`,
      { comment: "Verified against the vendor invoice" },
      { token: adminToken },
    );

    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("COMPLETED");
    expect(approved.body.data.txnNo).toMatch(/^PAY-OUT-2026-\d{6}$/);
    expect(await bankBalance()).toBe(before - 75_000_00);

    // The submission is superseded, not duplicated.
    const original = await Transaction.findById(submitted.body.data.id).lean();
    expect(original!.status).toBe("APPROVED");
  });

  it("refuses to let someone approve their own submission", async () => {
    await setThresholds(true, "10,000");

    const submitted = await client.post<{ data: { id: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "60,000", paymentMode: "NEFT" },
      { token: superToken },
    );

    const res = await client.post<{ error: { message: string } }>(
      `/approvals/${submitted.body.data.id}/approve`,
      {},
      { token: superToken },
    );

    // Separation of duties: a control one person can satisfy alone is not a control.
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/cannot approve a transaction you raised/i);
  });

  it("stops a branch admin approving above their tier", async () => {
    await setThresholds(true, "10,000");

    // ₹6,00,000 sits in the SUPER_ADMIN band.
    const submitted = await client.post<{ data: { id: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "6,00,000", paymentMode: "RTGS" },
      { token: superToken },
    );

    const res = await client.post<{ error: { message: string } }>(
      `/approvals/${submitted.body.data.id}/approve`,
      {},
      { token: adminToken },
    );

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/super admin/i);
  });

  it("rejects without posting, and keeps the request on the record", async () => {
    await setThresholds(true, "10,000");
    const before = await bankBalance();

    const submitted = await client.post<{ data: { id: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "90,000", paymentMode: "NEFT" },
      { token: superToken },
    );

    const res = await client.post<{ data: { status: string } }>(
      `/approvals/${submitted.body.data.id}/reject`,
      { reason: "The supporting invoice does not match the amount requested" },
      { token: adminToken },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("REJECTED");
    expect(await bankBalance()).toBe(before);

    // Not deleted — a vanished request teaches people to route around the control.
    const stored = await Transaction.findById(submitted.body.data.id).lean();
    expect(stored).toBeTruthy();
    expect(stored!.approvals[0]!.comment).toContain("does not match");
  });

  it("refuses to act on the same request twice", async () => {
    await setThresholds(true, "10,000");

    const submitted = await client.post<{ data: { id: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "45,000", paymentMode: "NEFT" },
      { token: superToken },
    );

    await client.post(`/approvals/${submitted.body.data.id}/approve`, {}, { token: adminToken });
    const second = await client.post<{ error: { code: string } }>(
      `/approvals/${submitted.body.data.id}/approve`, {}, { token: adminToken },
    );

    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe("STATE_CONFLICT");
  });

  it("shows the queue with the stored postings and who may act", async () => {
    await setThresholds(true, "10,000");

    await client.post(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "7,00,000", paymentMode: "RTGS" },
      { token: superToken },
    );

    const res = await client.get<{
      data: Array<{ requiredTier: string; canApprove: boolean; lines: Array<{ accountName: string; amount: number }> }>;
      meta: { totalValue: number };
    }>("/approvals", { token: adminToken });

    expect(res.status).toBe(200);
    const big = res.body.data.find((a) => a.requiredTier === "SUPER_ADMIN");
    expect(big).toBeTruthy();
    // Visible but not actionable — an approver should see what is waiting even above
    // their own tier.
    expect(big!.canApprove).toBe(false);
    expect(big!.lines.length).toBeGreaterThan(0);
    expect(big!.lines[0]!.accountName).toBeTruthy();
    expect(res.body.meta.totalValue).toBeGreaterThan(0);
  });

  it("rejects a threshold configuration whose top band is not open-ended", async () => {
    const res = await client.request("PUT", "/approvals/settings", {
      token: superToken,
      body: {
        enabled: true,
        minimumAmount: "0",
        tiers: [{ from: "0", to: "50,000", tier: "BRANCH_ADMIN" }],
        appliesTo: [],
      },
    });

    // A capped top band would let any larger amount skip approval entirely.
    expect(res.status).toBe(422);
  });

  it("lets only a super admin change the thresholds", async () => {
    const res = await client.request("PUT", "/approvals/settings", {
      token: adminToken,
      body: { enabled: false, minimumAmount: "0", tiers: [], appliesTo: [] },
    });
    // Otherwise a branch admin could lower the bar above their own signing limit.
    expect(res.status).toBe(403);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("financial periods (§35)", () => {
  let periodId: string;

  it("opens a period", async () => {
    const res = await client.post<{ data: { id: string; name: string } }>(
      "/periods",
      { name: "FY 2026-27 Q1", startDate: "2026-04-01", endDate: "2026-06-30" },
      { token: superToken },
    );
    expect(res.status).toBe(201);
    periodId = res.body.data.id;
  });

  it("refuses an overlapping period", async () => {
    const res = await client.post<{ error: { message: string } }>(
      "/periods",
      { name: "Overlapping", startDate: "2026-06-01", endDate: "2026-08-31" },
      { token: superToken },
    );
    // Otherwise "which period is this date in" would have two answers.
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/overlap/i);
  });

  it("BLOCKS posting into a closed period", async () => {
    await client.post(
      `/periods/${periodId}/close`,
      { reason: "Quarter closed and reported to the proprietor" },
      { token: superToken },
    );

    const before = await bankBalance();
    const res = await client.post<{ error: { code: string; message: string } }>(
      "/payment-in",
      // 15 May 2026 falls inside the now-closed Q1.
      { date: "2026-05-15", branchId, partyId, accountId: hdfcId, amount: "1,000", paymentMode: "CASH" },
      { token: superToken },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PERIOD_CLOSED");
    expect(await bankBalance()).toBe(before);
  });

  it("blocks a REVERSAL into a closed period too", async () => {
    // Reversal is the one operation people expect to bypass a close. It must not:
    // numbers already reported on cannot move retrospectively.
    const posted = await client.post<{ data: { id: string } }>(
      "/payment-in",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "2,000", paymentMode: "CASH" },
      { token: superToken },
    );

    const res = await client.post<{ error: { code: string } }>(
      `/transactions/${posted.body.data.id}/reverse`,
      { reason: "Attempting to reverse into a closed quarter", date: "2026-05-20" },
      { token: superToken },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PERIOD_CLOSED");
  });

  it("still allows posting outside the closed range", async () => {
    const before = await bankBalance();
    const res = await client.post(
      "/payment-in",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "3,000", paymentMode: "CASH" },
      { token: superToken },
    );
    expect(res.status).toBe(201);
    expect(await bankBalance()).toBe(before + 3_000_00);
  });

  it("reopens a closed period and lets posting resume", async () => {
    await client.post(
      `/periods/${periodId}/reopen`,
      { reason: "A missing April invoice has to be recorded before the audit" },
      { token: superToken },
    );

    const res = await client.post(
      "/payment-in",
      { date: "2026-05-15", branchId, partyId, accountId: hdfcId, amount: "1,000", paymentMode: "CASH" },
      { token: superToken },
    );
    expect(res.status).toBe(201);
  });

  it("needs a super admin to reopen a LOCKED period", async () => {
    await client.post(
      `/periods/${periodId}/close`,
      { reason: "Filed with the tax authority — locking the quarter", lock: true },
      { token: superToken },
    );

    // A branch admin is refused outright — periods are organisation-wide, so
    // `period.manage` is not in their role at all. That is a stronger refusal than the
    // locked-status check, and it is the correct one.
    const blocked = await client.post<{ error: { code: string } }>(
      `/periods/${periodId}/reopen`,
      { reason: "A branch admin trying to reopen a locked quarter" },
      { token: adminToken },
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("PERMISSION_DENIED");

    const allowed = await client.post(
      `/periods/${periodId}/reopen`,
      { reason: "Reopened deliberately by the proprietor to correct a filing" },
      { token: superToken },
    );
    expect(allowed.status).toBe(200);
  });

  it("refuses to close a period with approvals still pending", async () => {
    await setThresholds(true, "1,000");
    await client.post(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId, accountId: hdfcId, amount: "40,000", paymentMode: "NEFT" },
      { token: superToken },
    );

    const august = await client.post<{ data: { id: string } }>(
      "/periods",
      { name: "FY 2026-27 August", startDate: "2026-08-01", endDate: "2026-08-31" },
      { token: superToken },
    );

    const res = await client.post<{ error: { message: string } }>(
      `/periods/${august.body.data.id}/close`,
      { reason: "Trying to close with work still in the approval queue" },
      { token: superToken },
    );

    // An approval landing after the close would fail to post and strand the request.
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/awaiting approval/i);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("audit log (§26)", () => {
  it("serves the log with filters and a failure count", async () => {
    const res = await client.get<{
      data: Array<{ action: string; userName: string; createdAt: string }>;
      meta: { total: number; failures: number; byAction: Array<{ action: string; count: number }> };
    }>("/audit-logs?limit=20", { token: superToken });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.byAction.length).toBeGreaterThan(0);
    // Denormalised at write time, so a row stays readable after the user is gone.
    expect(res.body.data[0]!.userName).toBeTruthy();
  });

  it("filters to failures only", async () => {
    await client.post("/auth/login", { email: "super@test.co", password: "WrongPassword1" });

    const res = await client.get<{ data: Array<{ success: boolean; action: string }> }>(
      "/audit-logs?failuresOnly=true",
      { token: superToken },
    );

    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((r) => r.success === false)).toBe(true);
  });

  it("returns a record's timeline, oldest first (§51)", async () => {
    const txn = await Transaction.findOne({ status: "COMPLETED" }).lean();

    const res = await client.get<{ data: Array<{ action: string; at: string; by: string }> }>(
      `/audit-logs/timeline/Transaction/${String(txn!._id)}`,
      { token: superToken },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (let i = 1; i < res.body.data.length; i += 1) {
      expect(new Date(res.body.data[i]!.at).getTime()).toBeGreaterThanOrEqual(
        new Date(res.body.data[i - 1]!.at).getTime(),
      );
    }
  });

  it("refuses a user without the audit permission", async () => {
    const accountant = await client.loginAs("acct@test.co");
    const res = await client.get<{ error: { code: string } }>("/audit-logs", { token: accountant });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PERMISSION_DENIED");
  });

  it("offers no way to write to the log", async () => {
    // Read-only by construction: no POST route exists, and the model refuses mutation.
    const post = await client.post("/audit-logs", { action: "LOGIN" }, { token: superToken });
    expect(post.status).toBe(404);

    const entry = await AuditLog.findOne().lean();
    await expect(
      AuditLog.updateOne({ _id: entry!._id }, { $set: { userName: "tampered" } }),
    ).rejects.toThrow(/append-only/i);
  });

  it("records the approval decisions with their reasons", async () => {
    const rejection = await AuditLog.findOne({ action: "REJECT" }).sort({ createdAt: -1 }).lean();
    expect(rejection).toBeTruthy();
    expect(rejection!.reason).toContain("does not match");

    const approval = await AuditLog.findOne({ action: "APPROVE" }).sort({ createdAt: -1 }).lean();
    expect(approval).toBeTruthy();
    expect((approval!.newValue as { postedAs?: string }).postedAs).toMatch(/^PAY-OUT-/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("the books still tie after Phase 6", () => {
  it("keeps the trial balance at zero difference", async () => {
    const tb = await trialBalance();
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.difference).toBe(0);
  });

  it("leaves no ledger entries behind for pending or rejected transactions", async () => {
    const unposted = await Transaction.find({ status: { $in: ["PENDING", "REJECTED"] } })
      .select("_id txnNo")
      .lean();

    for (const txn of unposted) {
      const entries = await LedgerEntry.countDocuments({ transactionId: txn._id });
      expect(entries, `${txn.txnNo} should have no entries`).toBe(0);
    }
  });

  it("stamps the period onto a transaction posted while that period exists", async () => {
    /**
     * Scoped to transactions posted AFTER the period was created.
     *
     * A period defined later does not retro-tag the transactions already in its range —
     * that would mean rewriting posted documents, which is exactly what this system does
     * not do. Reports resolve a date's period at read time instead.
     */
    const period = await FinancialPeriod.findOne({ name: "FY 2026-27 Q1" }).lean();
    expect(period).toBeTruthy();

    const posted = await Transaction.findOne({
      status: "COMPLETED",
      date: { $gte: period!.startDate, $lte: period!.endDate },
      createdAt: { $gt: period!.createdAt },
    }).lean();

    expect(posted, "the post-reopen payment should exist").toBeTruthy();
    expect(String(posted!.periodId)).toBe(String(period!._id));
  });
});
