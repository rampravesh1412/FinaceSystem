import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { formatINR } from "@amiri/shared";
import { createApp } from "../../app.js";
import {
  BankAccount,
  ChargeRule,
  ExpenseCategory,
  IncomeHead,
  LedgerAccount,
  LedgerEntry,
  Party,
  Transaction,
} from "../../models/index.js";
import { ensureSystemAccounts, systemAccountId, trialBalance } from "../../services/ledger.service.js";
import { computeCharge } from "../../services/charges.service.js";
import { verifyReversal } from "./reversal.service.js";
import { TestClient, clearFixtures, seedFixtures, type Fixtures } from "../../test/helpers.js";

/**
 * Phase 3 acceptance: payments, transfers, charges, expenses and reversal.
 *
 * The reversal cases are the important ones. §28 requires that a mistaken transaction can
 * be undone WITHOUT destroying history — so the tests check both halves: the balance
 * returns to exactly where it was, and the original transaction is still there.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;
let superToken: string;
let branchId: string;

let hdfcId: string;
let iciciId: string;
let cashId: string;
let ramanujId: string;
let vendorId: string;
let panelHeadId: string;
let commissionHeadId: string;

async function balanceOfAccount(bankAccountId: string): Promise<number> {
  const account = await BankAccount.findById(bankAccountId).lean();
  const ledgerAccount = await LedgerAccount.findById(account!.ledgerAccountId).select("cachedBalance").lean();
  return ledgerAccount!.cachedBalance;
}

async function balanceOfParty(partyId: string): Promise<number> {
  const party = await Party.findById(partyId).lean();
  const ledgerAccount = await LedgerAccount.findById(party!.ledgerAccountId).select("cachedBalance").lean();
  return ledgerAccount!.cachedBalance;
}

beforeAll(async () => {
  await clearFixtures();
  fx = await seedFixtures();
  await ensureSystemAccounts();

  app = createApp();
  client = new TestClient();
  await client.start(app);
  superToken = await client.loginAs("super@test.co");
  branchId = fx.branches["105"]!;

  const bank = await client.post<{ data: { id: string } }>(
    "/banks",
    { name: "HDFC Bank", shortName: "HDFC", ifscPrefix: "HDFC" },
    { token: superToken },
  );

  const makeAccount = async (name: string, number: string, opening: string) => {
    const res = await client.post<{ data: { id: string } }>(
      "/bank-accounts",
      {
        bankId: bank.body.data.id,
        branchId,
        accountName: name,
        accountNumber: number,
        ifsc: "HDFC0001234",
        openingBalance: opening,
      },
      { token: superToken },
    );
    return res.body.data.id;
  };

  hdfcId = await makeAccount("HDFC Current", "50100234567890", "20,00,000");
  iciciId = await makeAccount("HDFC Settlement", "50100999888777", "5,00,000");

  const cash = await client.post<{ data: { id: string } }>(
    "/cash-accounts",
    { branchId, name: "Main Counter", openingBalance: "50,000" },
    { token: superToken },
  );
  cashId = cash.body.data.id;

  const ramanuj = await client.post<{ data: { id: string } }>(
    "/parties",
    { name: "RAMANUJ PUNB", branchId, type: "DISTRIBUTOR", openingBalance: "9,50,000", creditLimit: "20,00,000" },
    { token: superToken },
  );
  ramanujId = ramanuj.body.data.id;

  const vendor = await client.post<{ data: { id: string } }>(
    "/parties",
    { name: "Bihar Panel Services", branchId, type: "VENDOR", openingBalance: "0" },
    { token: superToken },
  );
  vendorId = vendor.body.data.id;

  const panel = await client.post<{ data: { id: string } }>(
    "/expenses/categories",
    { name: "Panel Expense" },
    { token: superToken },
  );
  panelHeadId = panel.body.data.id;

  const commission = await client.post<{ data: { id: string } }>(
    "/income/heads",
    { name: "Commission" },
    { token: superToken },
  );
  commissionHeadId = commission.body.data.id;
});

afterAll(async () => {
  await client.stop();
  await clearFixtures();
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("charge engine (§18)", () => {
  it("computes 1.75% of ₹1,00,000 as exactly ₹1,750 with a net of ₹98,250", () => {
    const rule = {
      name: "Distributor 1.75%",
      type: "PERCENTAGE",
      rateBps: 175,
      minCharge: 0,
      maxCharge: 0,
      bearer: "PARTY",
      tiers: [],
    } as never;

    const charge = computeCharge(rule, 100_000_00);

    // The exact worked example from the brief.
    expect(charge.amount).toBe(1_750_00);
    expect(formatINR(charge.amount)).toBe("₹1,750.00");
    expect(formatINR(100_000_00 - charge.amount)).toBe("₹98,250.00");
    expect(charge.basis).toContain("1.75%");
  });

  it("applies a minimum floor and a maximum cap, in that order", () => {
    const rule = {
      name: "Capped", type: "PERCENTAGE", rateBps: 100,
      minCharge: 50_00, maxCharge: 500_00, bearer: "SELF", tiers: [],
    } as never;

    // 1% of ₹1,000 = ₹10, raised to the ₹50 floor.
    expect(computeCharge(rule, 1_000_00).amount).toBe(50_00);
    // 1% of ₹10,00,000 = ₹10,000, capped at ₹500.
    expect(computeCharge(rule, 10_00_000_00).amount).toBe(500_00);
    // In between, the rate applies untouched.
    expect(computeCharge(rule, 20_000_00).amount).toBe(200_00);
  });

  it("selects the right band of a tiered rule", () => {
    const rule = {
      name: "Tiered", type: "TIERED", minCharge: 0, maxCharge: 0, bearer: "SELF",
      tiers: [
        { upTo: 10_000_00, fixedAmount: 5_00 },
        { upTo: 1_00_000_00, rateBps: 50 },
        { upTo: null, rateBps: 25 },
      ],
    } as never;

    expect(computeCharge(rule, 5_000_00).amount).toBe(5_00); // band 1, flat ₹5
    expect(computeCharge(rule, 50_000_00).amount).toBe(250_00); // band 2, 0.5%
    expect(computeCharge(rule, 5_00_000_00).amount).toBe(1_250_00); // band 3, 0.25%
    // The boundary is inclusive, so exactly ₹10,000 stays in band 1.
    expect(computeCharge(rule, 10_000_00).amount).toBe(5_00);
  });

  it("refuses a charge larger than the amount it is levied on", () => {
    const rule = {
      name: "Absurd", type: "FIXED", fixedAmount: 500_00,
      minCharge: 0, maxCharge: 0, bearer: "SELF", tiers: [],
    } as never;

    // A ₹500 fee on a ₹100 transfer would produce a negative net.
    expect(() => computeCharge(rule, 100_00)).toThrow(/cannot exceed/i);
  });

  it("previews gross, charge and net before anything is posted", async () => {
    const rule = await ChargeRule.create({
      name: "Distributor Commission", code: "DIST175", type: "PERCENTAGE",
      rateBps: 175, bearer: "PARTY", appliesTo: ["PAYMENT_IN"], partyTypes: ["DISTRIBUTOR"],
    });

    const res = await client.post<{ data: { gross: number; charge: number; net: number; basis: string } }>(
      "/charges/preview",
      { chargeRuleId: String(rule._id), amount: "1,00,000" },
      { token: superToken },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.gross).toBe(100_000_00);
    expect(res.body.data.charge).toBe(1_750_00);
    expect(res.body.data.net).toBe(98_250_00);
  });

  it("refuses to apply a rule to a transaction type it is not meant for", async () => {
    const rule = await ChargeRule.findOne({ code: "DIST175" }).lean();

    const res = await client.post<{ error: { message: string } }>(
      "/bank-transfers",
      {
        date: "2026-08-19", branchId,
        sourceAccountId: hdfcId, destinationAccountId: iciciId,
        amount: "1,00,000", chargeRuleId: String(rule!._id),
      },
      { token: superToken },
    );

    // A distributor commission silently landing on a bank transfer would be a real error.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("does not apply");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("payment in (§14)", () => {
  it("increases the bank and reduces what the party owes", async () => {
    const bankBefore = await balanceOfAccount(hdfcId);
    const partyBefore = await balanceOfParty(ramanujId);

    const res = await client.post<{ data: { id: string; txnNo: string } }>(
      "/payment-in",
      {
        date: "2026-08-19", branchId, partyId: ramanujId, accountId: hdfcId,
        amount: "2,00,000", paymentMode: "NEFT", referenceNo: "NEFT9981",
      },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.txnNo).toMatch(/^PAY-IN-2026-\d{6}$/);

    expect(await balanceOfAccount(hdfcId)).toBe(bankBefore + 200_000_00);
    // Their receivable falls — they paid us.
    expect(await balanceOfParty(ramanujId)).toBe(partyBefore - 200_000_00);
  });

  it("keeps a party-borne commission as income and credits the party only the net", async () => {
    const rule = await ChargeRule.findOne({ code: "DIST175" }).lean();
    const commissionAccount = String(await systemAccountId("COMMISSION_INCOME"));

    const bankBefore = await balanceOfAccount(hdfcId);
    const partyBefore = await balanceOfParty(ramanujId);
    const commissionBefore =
      (await LedgerAccount.findById(commissionAccount).select("cachedBalance").lean())!.cachedBalance;

    const res = await client.post<{ data: { id: string } }>(
      "/payment-in",
      {
        date: "2026-08-19", branchId, partyId: ramanujId, accountId: hdfcId,
        amount: "1,00,000", paymentMode: "RTGS", chargeRuleId: String(rule!._id),
      },
      { token: superToken },
    );
    expect(res.status).toBe(201);

    // The full gross lands in our bank.
    expect(await balanceOfAccount(hdfcId)).toBe(bankBefore + 100_000_00);
    // The party is credited only ₹98,250 — their debt falls by the net, not the gross.
    expect(await balanceOfParty(ramanujId)).toBe(partyBefore - 98_250_00);
    // The ₹1,750 difference is our commission income, visible as its own account.
    const commissionAfter =
      (await LedgerAccount.findById(commissionAccount).select("cachedBalance").lean())!.cachedBalance;
    expect(commissionAfter).toBe(commissionBefore + 1_750_00);

    // Gross, charge and net are all recorded separately (§18).
    const txn = await Transaction.findById(res.body.data.id).lean();
    expect(txn!.grossAmount).toBe(100_000_00);
    expect(txn!.chargeAmount).toBe(1_750_00);
    expect(txn!.netAmount).toBe(98_250_00);
  });

  it("refuses a party from another branch", async () => {
    const other = await client.post<{ data: { id: string } }>(
      "/parties",
      { name: "Other Branch Party", branchId: fx.branches["107"], openingBalance: 0 },
      { token: superToken },
    );

    const res = await client.post<{ error: { field: string } }>(
      "/payment-in",
      {
        date: "2026-08-19", branchId, partyId: other.body.data.id,
        accountId: hdfcId, amount: "1,000", paymentMode: "CASH",
      },
      { token: superToken },
    );

    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe("partyId");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("payment out (§15)", () => {
  it("reduces the bank and moves the party toward what we owe them", async () => {
    const bankBefore = await balanceOfAccount(hdfcId);
    const partyBefore = await balanceOfParty(vendorId);

    const res = await client.post<{ data: { txnNo: string } }>(
      "/payment-out",
      {
        date: "2026-08-19", branchId, partyId: vendorId, accountId: hdfcId,
        amount: "75,000", paymentMode: "IMPS",
      },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.txnNo).toMatch(/^PAY-OUT-2026-\d{6}$/);
    expect(await balanceOfAccount(hdfcId)).toBe(bankBefore - 75_000_00);
    expect(await balanceOfParty(vendorId)).toBe(partyBefore + 75_000_00);
  });

  it("refuses to overdraw the cash drawer", async () => {
    const cashBefore = (await import("../../models/index.js")).CashAccount;
    const drawer = await cashBefore.findById(cashId).lean();
    const balance = (await LedgerAccount.findById(drawer!.ledgerAccountId).select("cachedBalance").lean())!
      .cachedBalance;

    const res = await client.post<{ error: { code: string; details: { shortfall: number } } }>(
      "/payment-out",
      {
        date: "2026-08-19", branchId, partyId: vendorId, accountId: cashId,
        amount: "5,00,000", paymentMode: "CASH",
      },
      { token: superToken },
    );

    // You cannot hand over notes that are not in the drawer.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INSUFFICIENT_BALANCE");

    const after = (await LedgerAccount.findById(drawer!.ledgerAccountId).select("cachedBalance").lean())!
      .cachedBalance;
    expect(after).toBe(balance); // untouched
  });

  it("refuses a payment that would breach the party's credit limit", async () => {
    const limited = await client.post<{ data: { id: string } }>(
      "/parties",
      { name: "Tight Limit Co", branchId, openingBalance: "0", creditLimit: "50,000" },
      { token: superToken },
    );

    const res = await client.post<{ error: { code: string; details: { limit: number; excess: number } } }>(
      "/payment-out",
      {
        date: "2026-08-19", branchId, partyId: limited.body.data.id,
        accountId: hdfcId, amount: "80,000", paymentMode: "NEFT",
      },
      { token: superToken },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
    expect(res.body.error.details.limit).toBe(50_000_00);
    expect(res.body.error.details.excess).toBe(30_000_00);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("bank transfer (§8)", () => {
  it("moves money between our own accounts and charges the fee to the source", async () => {
    const sourceBefore = await balanceOfAccount(hdfcId);
    const destBefore = await balanceOfAccount(iciciId);
    const chargesAccount = String(await systemAccountId("BANK_CHARGES"));
    const chargesBefore =
      (await LedgerAccount.findById(chargesAccount).select("cachedBalance").lean())!.cachedBalance;

    const res = await client.post<{ data: { id: string; txnNo: string } }>(
      "/bank-transfers",
      {
        date: "2026-08-19", branchId,
        sourceAccountId: hdfcId, destinationAccountId: iciciId,
        amount: "9,50,000", paymentMode: "RTGS", manualCharge: "50",
        narration: "RAMANUJ PUNB to EDDIGO DISTRIBUTOR",
      },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.txnNo).toMatch(/^BANK-TRF-2026-\d{6}$/);

    // The destination receives the FULL gross — the receiving statement must show
    // ₹9,50,000 or reconciliation fails.
    expect(await balanceOfAccount(iciciId)).toBe(destBefore + 950_000_00);
    // The source pays gross plus the fee.
    expect(await balanceOfAccount(hdfcId)).toBe(sourceBefore - 950_000_00 - 50_00);
    // And the fee is visible as its own expense.
    const chargesAfter =
      (await LedgerAccount.findById(chargesAccount).select("cachedBalance").lean())!.cachedBalance;
    expect(chargesAfter).toBe(chargesBefore + 50_00);
  });

  it("refuses a transfer to the same account", async () => {
    const res = await client.post<{ error: { code: string } }>(
      "/bank-transfers",
      {
        date: "2026-08-19", branchId,
        sourceAccountId: hdfcId, destinationAccountId: hdfcId, amount: "1,000",
      },
      { token: superToken },
    );
    expect(res.status).toBe(422);
  });

  it("does not count a transfer as money in or money out", async () => {
    const res = await client.get<{ data: Array<{ moneyIn: number; moneyOut: number }> }>(
      "/bank-transfers",
      { token: superToken },
    );

    // A transfer between our own accounts must not inflate the day's turnover.
    expect(res.body.data.every((t) => t.moneyIn === 0 && t.moneyOut === 0)).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("expenses (§16)", () => {
  it("records an itemised expense paid from a bank account", async () => {
    const bankBefore = await balanceOfAccount(hdfcId);

    const res = await client.post<{ data: { id: string; txnNo: string } }>(
      "/expenses",
      {
        date: "2026-08-19", branchId, categoryId: panelHeadId, accountId: hdfcId,
        amount: "12,000", paymentMode: "BANK_TRANSFER", invoiceNo: "INV-4471",
        items: [
          { description: "Panel licence — August", quantity: 2, unitPrice: "5,000", amount: "10,000" },
          { description: "Domain renewal", quantity: 1, unitPrice: "2,000", amount: "2,000" },
        ],
      },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.txnNo).toMatch(/^EXP-2026-\d{6}$/);
    expect(await balanceOfAccount(hdfcId)).toBe(bankBefore - 12_000_00);

    const head = await ExpenseCategory.findById(panelHeadId).lean();
    const headBalance =
      (await LedgerAccount.findById(head!.ledgerAccountId).select("cachedBalance").lean())!.cachedBalance;
    expect(headBalance).toBe(12_000_00);
  });

  it("rejects an expense whose items do not sum to the total", async () => {
    const res = await client.post<{ error: { code: string; details: Array<{ message: string }> } }>(
      "/expenses",
      {
        date: "2026-08-19", branchId, categoryId: panelHeadId, accountId: hdfcId,
        amount: "10,000",
        items: [{ description: "Mismatch", quantity: 1, unitPrice: "9,000", amount: "9,000" }],
      },
      { token: superToken },
    );

    // Silently trusting either figure would record an invoice for an amount nobody entered.
    expect(res.status).toBe(422);
  });

  it("books an unpaid expense against the vendor as a payable", async () => {
    const partyBefore = await balanceOfParty(vendorId);

    const res = await client.post("/expenses", {
      date: "2026-08-19", branchId, categoryId: panelHeadId, partyId: vendorId,
      amount: "8,000",
    }, { token: superToken });

    expect(res.status).toBe(201);
    // A negative party balance is DENA HAI — we owe them.
    expect(await balanceOfParty(vendorId)).toBe(partyBefore - 8_000_00);
  });

  it("refuses an expense with neither an account nor a party", async () => {
    const res = await client.post<{ error: { code: string } }>(
      "/expenses",
      { date: "2026-08-19", branchId, categoryId: panelHeadId, amount: "1,000" },
      { token: superToken },
    );
    // With neither, there is nothing to credit and the entry cannot balance.
    expect(res.status).toBe(422);
  });
});

describe("income (§17)", () => {
  it("credits an income head without touching any party receivable", async () => {
    const bankBefore = await balanceOfAccount(hdfcId);
    const partyBefore = await balanceOfParty(ramanujId);

    const res = await client.post("/income", {
      date: "2026-08-19", branchId, headId: commissionHeadId, accountId: hdfcId,
      partyId: ramanujId, amount: "15,000", paymentMode: "UPI",
    }, { token: superToken });

    expect(res.status).toBe(201);
    expect(await balanceOfAccount(hdfcId)).toBe(bankBefore + 15_000_00);
    // Income is NOT a payment: the party's receivable is untouched. Conflating the two is
    // how a debt gets written off by accident.
    expect(await balanceOfParty(ramanujId)).toBe(partyBefore);

    const head = await IncomeHead.findById(commissionHeadId).lean();
    const headBalance =
      (await LedgerAccount.findById(head!.ledgerAccountId).select("cachedBalance").lean())!.cachedBalance;
    expect(headBalance).toBe(15_000_00);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("reversal (§28)", () => {
  it("restores every balance exactly and keeps the original visible", async () => {
    const bankBefore = await balanceOfAccount(hdfcId);
    const partyBefore = await balanceOfParty(ramanujId);

    const created = await client.post<{ data: { id: string; txnNo: string } }>(
      "/payment-in",
      {
        date: "2026-08-19", branchId, partyId: ramanujId, accountId: hdfcId,
        amount: "3,33,333", paymentMode: "NEFT",
      },
      { token: superToken },
    );
    const originalId = created.body.data.id;
    const originalNo = created.body.data.txnNo;

    expect(await balanceOfAccount(hdfcId)).toBe(bankBefore + 333_333_00);

    const reversed = await client.post<{
      data: { original: { status: string }; reversal: { id: string; txnNo: string } };
    }>(
      `/transactions/${originalId}/reverse`,
      { reason: "Duplicate entry — the same NEFT was recorded twice by two clerks" },
      { token: superToken },
    );

    expect(reversed.status).toBe(200);
    expect(reversed.body.data.reversal.txnNo).toMatch(/^REV-2026-\d{6}$/);

    // Balances return to EXACTLY where they were. Not approximately.
    expect(await balanceOfAccount(hdfcId)).toBe(bankBefore);
    expect(await balanceOfParty(ramanujId)).toBe(partyBefore);

    // The original still exists, marked reversed and linked to its mirror.
    const original = await Transaction.findById(originalId).lean();
    expect(original).toBeTruthy();
    expect(original!.status).toBe("REVERSED");
    expect(original!.txnNo).toBe(originalNo);
    expect(String(original!.reversedBy)).toBe(reversed.body.data.reversal.id);
    expect(original!.reversalReason).toContain("Duplicate entry");

    // Its ledger entries are untouched — nothing was deleted, only offset.
    const entries = await LedgerEntry.find({ transactionId: originalId }).lean();
    expect(entries.length).toBeGreaterThan(0);

    // And the pair nets to zero on every account it touched.
    const check = await verifyReversal(originalId);
    expect(check.balanced).toBe(true);
    expect(check.perAccount.every((a) => a.delta === 0)).toBe(true);
  });

  it("reverses a charged transaction, commission included", async () => {
    const rule = await ChargeRule.findOne({ code: "DIST175" }).lean();
    const commissionAccount = String(await systemAccountId("COMMISSION_INCOME"));
    const commissionBefore =
      (await LedgerAccount.findById(commissionAccount).select("cachedBalance").lean())!.cachedBalance;
    const bankBefore = await balanceOfAccount(hdfcId);

    const created = await client.post<{ data: { id: string } }>(
      "/payment-in",
      {
        date: "2026-08-19", branchId, partyId: ramanujId, accountId: hdfcId,
        amount: "2,00,000", paymentMode: "RTGS", chargeRuleId: String(rule!._id),
      },
      { token: superToken },
    );

    await client.post(
      `/transactions/${created.body.data.id}/reverse`,
      { reason: "Commission was applied under the wrong rate agreement" },
      { token: superToken },
    );

    // The commission is unwound too — a reversal that left the income behind would
    // quietly overstate profit.
    const commissionAfter =
      (await LedgerAccount.findById(commissionAccount).select("cachedBalance").lean())!.cachedBalance;
    expect(commissionAfter).toBe(commissionBefore);
    expect(await balanceOfAccount(hdfcId)).toBe(bankBefore);
  });

  it("refuses to reverse the same transaction twice", async () => {
    const created = await client.post<{ data: { id: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId: vendorId, accountId: hdfcId, amount: "1,000", paymentMode: "CASH" },
      { token: superToken },
    );

    await client.post(
      `/transactions/${created.body.data.id}/reverse`,
      { reason: "Entered against the wrong vendor account entirely" },
      { token: superToken },
    );

    const second = await client.post<{ error: { code: string } }>(
      `/transactions/${created.body.data.id}/reverse`,
      { reason: "Trying to reverse it a second time, which must not work" },
      { token: superToken },
    );

    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe("ALREADY_REVERSED");
  });

  it("refuses to reverse a reversal", async () => {
    const created = await client.post<{ data: { id: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId: vendorId, accountId: hdfcId, amount: "2,000", paymentMode: "CASH" },
      { token: superToken },
    );

    const reversed = await client.post<{ data: { reversal: { id: string } } }>(
      `/transactions/${created.body.data.id}/reverse`,
      { reason: "Wrong amount was entered on the original voucher" },
      { token: superToken },
    );

    const res = await client.post<{ error: { message: string } }>(
      `/transactions/${reversed.body.data.reversal.id}/reverse`,
      { reason: "Attempting to reverse the reversal, which should be refused" },
      { token: superToken },
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("itself a reversal");
  });

  it("requires a substantive reason", async () => {
    const created = await client.post<{ data: { id: string } }>(
      "/payment-out",
      { date: "2026-08-19", branchId, partyId: vendorId, accountId: hdfcId, amount: "500", paymentMode: "CASH" },
      { token: superToken },
    );

    const res = await client.post<{ error: { code: string } }>(
      `/transactions/${created.body.data.id}/reverse`,
      { reason: "oops" },
      { token: superToken },
    );

    // "Why was this undone" has to be answerable years later.
    expect(res.status).toBe(422);
  });

  it("has no delete route at all", async () => {
    const txn = await Transaction.findOne({ type: "PAYMENT_IN" }).lean();
    const res = await client.del(`/transactions/${String(txn!._id)}`, { token: superToken });
    expect(res.status).toBe(404);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("the books still tie after everything above", () => {
  it("keeps the trial balance at zero difference", async () => {
    const tb = await trialBalance();
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.difference).toBe(0);
  });

  it("agrees with a full replay on every single account", async () => {
    const { verifyBalance } = await import("../../services/ledger.service.js");
    const allAccounts = await LedgerAccount.find({}).select("_id name").lean();

    for (const account of allAccounts) {
      const check = await verifyBalance(account._id);
      expect(check.matches, `${account.name} drifted by ${check.difference}`).toBe(true);
    }
  });

  it("reports money in, money out and charges over the whole filtered set", async () => {
    const res = await client.get<{
      meta: { moneyIn: number; moneyOut: number; charges: number; net: number };
    }>("/transactions?limit=5", { token: superToken });

    expect(res.status).toBe(200);
    expect(res.body.meta.moneyIn).toBeGreaterThan(0);
    expect(res.body.meta.moneyOut).toBeGreaterThan(0);
    expect(res.body.meta.net).toBe(res.body.meta.moneyIn - res.body.meta.moneyOut);
  });

  it("shows the full posting and audit timeline in the details drawer", async () => {
    const txn = await Transaction.findOne({ type: "BANK_TRANSFER" }).lean();

    const res = await client.get<{
      data: {
        entries: Array<{ debit: number; credit: number; accountName: string }>;
        timeline: Array<{ action: string; by: string }>;
        grossAmount: number;
        chargeAmount: number;
        netAmount: number;
      };
    }>(`/transactions/${String(txn!._id)}`, { token: superToken });

    expect(res.status).toBe(200);
    // Three lines: destination debit, charge debit, source credit.
    expect(res.body.data.entries).toHaveLength(3);

    const debit = res.body.data.entries.reduce((s, e) => s + e.debit, 0);
    const credit = res.body.data.entries.reduce((s, e) => s + e.credit, 0);
    expect(debit).toBe(credit);

    expect(res.body.data.timeline.length).toBeGreaterThan(0);
    expect(res.body.data.timeline[0]!.by).toBeTruthy();
  });
});
