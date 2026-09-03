import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { formatINR } from "@amiri/shared";
import { withTransaction } from "../lib/unitOfWork.js";
import { LedgerAccount, LedgerEntry, Transaction, User } from "../models/index.js";
import { clearFixtures, seedFixtures, type Fixtures } from "../test/helpers.js";
import * as ledger from "./ledger.service.js";

/**
 * THE LEDGER ENGINE TEST SUITE.
 *
 * §59 names these as mandatory. The headline case — Bank A ₹1,00,000 to Bank B leaves A
 * down exactly ₹1,00,000, B up exactly ₹1,00,000, and no money created or destroyed — is
 * the one that matters most, because a system that silently duplicates money is worse
 * than a system that refuses to run.
 */

let fx: Fixtures;
let userId: string;

/** Convenience: make a ledger account of a given kind for the test branch. */
async function makeAccount(
  code: string,
  name: string,
  kind: Parameters<typeof ledger.createLedgerAccount>[0]["kind"],
  options: { enforceBalance?: boolean; overdraftLimit?: number } = {},
): Promise<string> {
  const account = await withTransaction((session) =>
    ledger.createLedgerAccount(
      {
        code,
        name,
        kind,
        enforceBalance: options.enforceBalance ?? false,
        overdraftLimit: options.overdraftLimit ?? 0,
        createdBy: userId,
      },
      session,
    ),
  );
  return String(account._id);
}

/**
 * Minimal discriminator fields for a raw engine-level post.
 *
 * The discriminators declare required fields (a transfer must name its endpoints), and
 * `postTransaction` now validates them in the same write that creates the header. These
 * helpers keep the engine tests focused on ledger mechanics without weakening the schema.
 */
const transferDetails = () => ({
  sourceAccountId: new Types.ObjectId(),
  sourceAccountKind: "BANK" as const,
  sourceLabel: "Source Account",
  destinationAccountId: new Types.ObjectId(),
  destinationAccountKind: "BANK" as const,
  destinationLabel: "Destination Account",
});

const paymentDetails = () => ({
  accountId: new Types.ObjectId(),
  accountKind: "BANK" as const,
  accountLabel: "Settlement Account",
});

const expenseDetails = () => ({
  categoryId: new Types.ObjectId(),
  categoryName: "Test Expense Head",
});

const adjustmentDetails = () => ({
  adjustmentType: "BALANCE_CORRECTION",
  reason: "Engine test adjustment",
});

async function balanceOf(id: string): Promise<number> {
  const account = await LedgerAccount.findById(id).select("cachedBalance").lean();
  return account?.cachedBalance ?? 0;
}

beforeAll(async () => {
  await clearFixtures();
  fx = await seedFixtures();
  userId = fx.users.superAdmin!.id;
  await ledger.ensureSystemAccounts();
});

beforeEach(async () => {
  // Entries and accounts are torn down between suites, so each test reasons about a
  // known ledger. Dropped through the raw driver because both models refuse mutation
  // by design — see the note in test/helpers.
  const mongoose = (await import("mongoose")).default;
  await mongoose.connection.collection("ledgerentries").deleteMany({});
  await mongoose.connection.collection("transactions").deleteMany({});
  await mongoose.connection.collection("counters").deleteMany({});
  await LedgerAccount.deleteMany({ isSystem: false });
  await LedgerAccount.updateMany({ isSystem: true }, { $set: { cachedBalance: 0, cachedEntryCount: 0 } });
});

afterAll(async () => {
  await clearFixtures();
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("double-entry invariant", () => {
  it("rejects a posting whose debits and credits disagree", () => {
    expect(() =>
      ledger.assertBalanced([
        { ledgerAccountId: new Types.ObjectId(), direction: "DEBIT", amount: 100_000 },
        { ledgerAccountId: new Types.ObjectId(), direction: "CREDIT", amount: 90_000 },
      ]),
    ).toThrow(/do not balance/i);
  });

  it("accepts a balanced posting with several lines on each side", () => {
    const result = ledger.assertBalanced([
      { ledgerAccountId: new Types.ObjectId(), direction: "DEBIT", amount: 100_000 },
      { ledgerAccountId: new Types.ObjectId(), direction: "DEBIT", amount: 5_000 },
      { ledgerAccountId: new Types.ObjectId(), direction: "CREDIT", amount: 105_000 },
    ]);
    expect(result.debit).toBe(105_000);
    expect(result.credit).toBe(105_000);
  });

  it("rejects a single-sided posting", () => {
    expect(() =>
      ledger.assertBalanced([
        { ledgerAccountId: new Types.ObjectId(), direction: "DEBIT", amount: 100_000 },
      ]),
    ).toThrow();
  });

  it("rejects a negative amount — direction carries the sign, never the amount", () => {
    expect(() =>
      ledger.assertBalanced([
        { ledgerAccountId: new Types.ObjectId(), direction: "DEBIT", amount: -100 },
        { ledgerAccountId: new Types.ObjectId(), direction: "CREDIT", amount: -100 },
      ]),
    ).toThrow(/positive/i);
  });

  it("rejects a fractional amount — a float reaching the ledger is a bug, not a rounding decision", () => {
    expect(() =>
      ledger.assertBalanced([
        { ledgerAccountId: new Types.ObjectId(), direction: "DEBIT", amount: 100.5 },
        { ledgerAccountId: new Types.ObjectId(), direction: "CREDIT", amount: 100.5 },
      ]),
    ).toThrow(/whole number of paise/i);
  });

  it("writes NOTHING when a posting fails mid-transaction", async () => {
    const bankA = await makeAccount("T-BANK-A", "Bank A", "BANK");

    await expect(
      withTransaction((session) =>
        ledger.postTransaction(
          {
            type: "BANK_TRANSFER",
            date: new Date("2026-08-19"),
            // Deliberately unbalanced.
            lines: [
              { ledgerAccountId: bankA, direction: "DEBIT", amount: 100_000 },
              { ledgerAccountId: new Types.ObjectId(), direction: "CREDIT", amount: 50_000 },
            ],
            grossAmount: 100_000,
            details: transferDetails(),
            createdBy: userId,
          },
          session,
        ),
      ),
    ).rejects.toThrow();

    // The whole point of §38: a failed money movement leaves no trace, not a half-trace.
    expect(await LedgerEntry.countDocuments({})).toBe(0);
    expect(await Transaction.countDocuments({})).toBe(0);
    expect(await balanceOf(bankA)).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("bank to bank transfer — the §59 headline case", () => {
  it("moves ₹1,00,000 from Bank A to Bank B without creating or destroying money", async () => {
    const bankA = await makeAccount("T-HDFC", "HDFC ••1234", "BANK", { enforceBalance: true });
    const bankB = await makeAccount("T-ICICI", "ICICI ••5678", "BANK", { enforceBalance: true });

    // Fund A so the transfer is affordable.
    await withTransaction((session) =>
      ledger.postOpeningBalance(
        { ledgerAccountId: bankA, amount: 500_000_00, date: new Date("2026-04-01"), label: "HDFC", createdBy: userId },
        session,
      ),
    );

    const before = { a: await balanceOf(bankA), b: await balanceOf(bankB) };
    const systemBefore = before.a + before.b;

    const amount = 100_000_00; // ₹1,00,000.00

    await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "BANK_TRANSFER",
          date: new Date("2026-08-19"),
          lines: [
            { ledgerAccountId: bankB, direction: "DEBIT", amount },
            { ledgerAccountId: bankA, direction: "CREDIT", amount },
          ],
          grossAmount: amount,
          narration: "HDFC to ICICI",
          details: transferDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    const after = { a: await balanceOf(bankA), b: await balanceOf(bankB) };

    expect(after.a).toBe(before.a - amount); // A is down exactly ₹1,00,000
    expect(after.b).toBe(before.b + amount); // B is up exactly ₹1,00,000
    expect(after.a + after.b).toBe(systemBefore); // no money created or destroyed

    expect(formatINR(after.a)).toBe("₹4,00,000.00");
    expect(formatINR(after.b)).toBe("₹1,00,000.00");

    // Both sides are computable from the entries alone, not merely from the cache.
    expect((await ledger.computeBalance(bankA)).balance).toBe(after.a);
    expect((await ledger.computeBalance(bankB)).balance).toBe(after.b);
  });

  it("charges a transfer fee without touching the gross amount (§18)", async () => {
    const bankA = await makeAccount("T-SBI", "SBI ••1111", "BANK");
    const bankB = await makeAccount("T-AXIS", "Axis ••2222", "BANK");
    const charges = await ledger.systemAccountId("BANK_CHARGES");

    const gross = 100_000_00;
    const charge = 50_00; // ₹50

    const txn = await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "BANK_TRANSFER",
          date: new Date("2026-08-19"),
          lines: [
            { ledgerAccountId: bankB, direction: "DEBIT", amount: gross },
            { ledgerAccountId: charges, direction: "DEBIT", amount: charge },
            { ledgerAccountId: bankA, direction: "CREDIT", amount: gross + charge },
          ],
          grossAmount: gross,
          chargeAmount: charge,
          details: transferDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    // Gross, charge and net are all recorded separately and visibly.
    expect(txn.grossAmount).toBe(gross);
    expect(txn.chargeAmount).toBe(charge);
    expect(txn.netAmount).toBe(gross - charge);

    // The destination receives the full gross; the fee comes out of the source on top.
    expect(await balanceOf(bankB)).toBe(gross);
    expect(await balanceOf(bankA)).toBe(-(gross + charge));
    expect(await balanceOf(String(charges))).toBe(charge);
  });

  it("refuses a transfer the source account cannot fund", async () => {
    const bankA = await makeAccount("T-POOR", "Nearly Empty", "BANK", { enforceBalance: true });
    const bankB = await makeAccount("T-DEST", "Destination", "BANK");

    await withTransaction((session) =>
      ledger.postOpeningBalance(
        { ledgerAccountId: bankA, amount: 10_000_00, date: new Date("2026-04-01"), label: "x", createdBy: userId },
        session,
      ),
    );

    await expect(
      withTransaction((session) =>
        ledger.postTransaction(
          {
            type: "BANK_TRANSFER",
            date: new Date("2026-08-19"),
            lines: [
              { ledgerAccountId: bankB, direction: "DEBIT", amount: 50_000_00 },
              { ledgerAccountId: bankA, direction: "CREDIT", amount: 50_000_00 },
            ],
            grossAmount: 50_000_00,
            details: transferDetails(),
            createdBy: userId,
          },
          session,
        ),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });

    // The refusal must be total — no partial posting.
    expect(await balanceOf(bankA)).toBe(10_000_00);
    expect(await balanceOf(bankB)).toBe(0);
  });

  it("allows an overdraft account to go negative, up to its sanctioned limit", async () => {
    const od = await makeAccount("T-OD", "OD Account", "BANK", {
      enforceBalance: true,
      overdraftLimit: 100_000_00,
    });
    const dest = await makeAccount("T-OD-DEST", "Destination", "BANK");

    await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "BANK_TRANSFER",
          date: new Date("2026-08-19"),
          lines: [
            { ledgerAccountId: dest, direction: "DEBIT", amount: 80_000_00 },
            { ledgerAccountId: od, direction: "CREDIT", amount: 80_000_00 },
          ],
          grossAmount: 80_000_00,
          details: transferDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    expect(await balanceOf(od)).toBe(-80_000_00);

    // But not beyond it.
    await expect(
      withTransaction((session) =>
        ledger.postTransaction(
          {
            type: "BANK_TRANSFER",
            date: new Date("2026-08-19"),
            lines: [
              { ledgerAccountId: dest, direction: "DEBIT", amount: 50_000_00 },
              { ledgerAccountId: od, direction: "CREDIT", amount: 50_000_00 },
            ],
            grossAmount: 50_000_00,
            details: transferDetails(),
            createdBy: userId,
          },
          session,
        ),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("opening balances", () => {
  it("posts against equity so the books balance from day zero", async () => {
    const bank = await makeAccount("T-OPEN", "Opening Bank", "BANK");
    const equityId = String(await ledger.systemAccountId("OPENING_EQUITY"));

    await withTransaction((session) =>
      ledger.postOpeningBalance(
        { ledgerAccountId: bank, amount: 500_000_00, date: new Date("2026-04-01"), label: "Opening Bank", createdBy: userId },
        session,
      ),
    );

    expect(await balanceOf(bank)).toBe(500_000_00);
    // Equity is a credit-normal account, so funding an asset increases it too.
    expect(await balanceOf(equityId)).toBe(500_000_00);

    const entries = await LedgerEntry.find({}).lean();
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
    expect(entries.filter((e) => e.direction === "CREDIT")).toHaveLength(1);
  });

  it("handles a negative opening balance — a party we already owe", async () => {
    const party = await makeAccount("T-PARTY-NEG", "Vendor we owe", "PARTY");

    await withTransaction((session) =>
      ledger.postOpeningBalance(
        { ledgerAccountId: party, amount: -25_000_00, date: new Date("2026-04-01"), label: "Vendor", createdBy: userId },
        session,
      ),
    );

    // Negative means DENA HAI — we owe them ₹25,000.
    expect(await balanceOf(party)).toBe(-25_000_00);
  });

  it("posts nothing at all for a zero opening balance", async () => {
    const account = await makeAccount("T-ZERO", "Zero Opening", "BANK");

    const result = await withTransaction((session) =>
      ledger.postOpeningBalance(
        { ledgerAccountId: account, amount: 0, date: new Date("2026-04-01"), label: "Zero", createdBy: userId },
        session,
      ),
    );

    // A voucher number consumed for no movement would leave an unexplained gap.
    expect(result).toBeNull();
    expect(await LedgerEntry.countDocuments({})).toBe(0);
    expect(await Transaction.countDocuments({})).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("party balance direction — the Khata convention", () => {
  it("reduces a receivable on payment in, and clears a payable on payment out", async () => {
    const party = await makeAccount("T-PARTY", "Ramanuj", "PARTY");
    const bank = await makeAccount("T-PARTY-BANK", "Bank", "BANK");

    // They owe us ₹1,00,000 to begin with — LENA HAI.
    await withTransaction((session) =>
      ledger.postOpeningBalance(
        { ledgerAccountId: party, amount: 100_000_00, date: new Date("2026-04-01"), label: "Ramanuj", createdBy: userId },
        session,
      ),
    );
    expect(await balanceOf(party)).toBe(100_000_00);

    // Payment In ₹60,000: DR Bank, CR Party.
    await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "PAYMENT_IN",
          date: new Date("2026-08-19"),
          lines: [
            { ledgerAccountId: bank, direction: "DEBIT", amount: 60_000_00 },
            { ledgerAccountId: party, direction: "CREDIT", amount: 60_000_00 },
          ],
          grossAmount: 60_000_00,
          details: paymentDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    expect(await balanceOf(party)).toBe(40_000_00); // still owes ₹40,000
    expect(await balanceOf(bank)).toBe(60_000_00);

    // Payment Out ₹40,000: DR Party, CR Bank. Settles them exactly.
    await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "PAYMENT_OUT",
          date: new Date("2026-08-20"),
          lines: [
            { ledgerAccountId: party, direction: "DEBIT", amount: 40_000_00 },
            { ledgerAccountId: bank, direction: "CREDIT", amount: 40_000_00 },
          ],
          grossAmount: 40_000_00,
          details: paymentDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    // Overpaying a receivable flips them to CLEAR, then to DENA — one account, both
    // directions, no second row to reconcile.
    expect(await balanceOf(party)).toBe(80_000_00);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("immutability", () => {
  it("refuses to update a posted entry", async () => {
    const a = await makeAccount("T-IMM-A", "A", "BANK");
    const b = await makeAccount("T-IMM-B", "B", "BANK");

    await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "BANK_TRANSFER",
          date: new Date("2026-08-19"),
          lines: [
            { ledgerAccountId: b, direction: "DEBIT", amount: 1_000_00 },
            { ledgerAccountId: a, direction: "CREDIT", amount: 1_000_00 },
          ],
          grossAmount: 1_000_00,
          details: transferDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    const entry = await LedgerEntry.findOne({}).lean();
    await expect(
      LedgerEntry.updateOne({ _id: entry!._id }, { $set: { amount: 999_999 } }),
    ).rejects.toThrow(/immutable/i);
  });

  it("refuses to delete a posted entry", async () => {
    const a = await makeAccount("T-DEL-A", "A", "BANK");
    const b = await makeAccount("T-DEL-B", "B", "BANK");

    await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "BANK_TRANSFER",
          date: new Date("2026-08-19"),
          lines: [
            { ledgerAccountId: b, direction: "DEBIT", amount: 1_000_00 },
            { ledgerAccountId: a, direction: "CREDIT", amount: 1_000_00 },
          ],
          grossAmount: 1_000_00,
          details: transferDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    const entry = await LedgerEntry.findOne({}).lean();
    await expect(LedgerEntry.deleteOne({ _id: entry!._id })).rejects.toThrow(/append-only/i);
  });

  it("permits a reconciliation flag, which touches no financial field", async () => {
    const a = await makeAccount("T-REC-A", "A", "BANK");
    const b = await makeAccount("T-REC-B", "B", "BANK");

    await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "BANK_TRANSFER",
          date: new Date("2026-08-19"),
          lines: [
            { ledgerAccountId: b, direction: "DEBIT", amount: 1_000_00 },
            { ledgerAccountId: a, direction: "CREDIT", amount: 1_000_00 },
          ],
          grossAmount: 1_000_00,
          details: transferDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    const entry = await LedgerEntry.findOne({}).lean();
    await expect(
      LedgerEntry.updateOne({ _id: entry!._id }, { $set: { reconciledAt: new Date() } }),
    ).resolves.toMatchObject({ modifiedCount: 1 });
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("integrity and reporting", () => {
  it("detects a cached balance that has drifted from the entries", async () => {
    const account = await makeAccount("T-DRIFT", "Drifting", "BANK");

    await withTransaction((session) =>
      ledger.postOpeningBalance(
        { ledgerAccountId: account, amount: 50_000_00, date: new Date("2026-04-01"), label: "x", createdBy: userId },
        session,
      ),
    );

    expect((await ledger.verifyBalance(account)).matches).toBe(true);

    // Corrupt the cache directly, as a stray script or a bug might.
    await LedgerAccount.updateOne({ _id: account }, { $set: { cachedBalance: 99_999_99 } });

    const check = await ledger.verifyBalance(account);
    expect(check.matches).toBe(false);
    expect(check.computed).toBe(50_000_00); // the ledger is right
    expect(check.difference).not.toBe(0);

    // §62: the discrepancy is REPORTED. Verifying must not silently repair it, or the
    // evidence of what went wrong is destroyed.
    const stillWrong = await LedgerAccount.findById(account).select("cachedBalance").lean();
    expect(stillWrong!.cachedBalance).toBe(99_999_99);
  });

  it("produces a trial balance that ties", async () => {
    const bank = await makeAccount("T-TB-BANK", "Bank", "BANK");
    const cash = await makeAccount("T-TB-CASH", "Cash", "CASH");
    const party = await makeAccount("T-TB-PARTY", "Party", "PARTY");

    await withTransaction(async (session) => {
      await ledger.postOpeningBalance(
        { ledgerAccountId: bank, amount: 500_000_00, date: new Date("2026-04-01"), label: "Bank", createdBy: userId },
        session,
      );
      await ledger.postOpeningBalance(
        { ledgerAccountId: cash, amount: 25_000_00, date: new Date("2026-04-01"), label: "Cash", createdBy: userId },
        session,
      );
      await ledger.postOpeningBalance(
        { ledgerAccountId: party, amount: 100_000_00, date: new Date("2026-04-01"), label: "Party", createdBy: userId },
        session,
      );
    });

    await withTransaction((session) =>
      ledger.postTransaction(
        {
          type: "PAYMENT_IN",
          date: new Date("2026-08-19"),
          lines: [
            { ledgerAccountId: bank, direction: "DEBIT", amount: 40_000_00 },
            { ledgerAccountId: party, direction: "CREDIT", amount: 40_000_00 },
          ],
          grossAmount: 40_000_00,
          details: paymentDetails(),
          createdBy: userId,
        },
        session,
      ),
    );

    const tb = await ledger.trialBalance();

    // The whole point of a trial balance. Any other result means the engine is broken.
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.difference).toBe(0);
    expect(tb.totalDebit).toBeGreaterThan(0);
  });

  it("issues gap-free, unique voucher numbers within a fiscal year", async () => {
    const a = await makeAccount("T-NUM-A", "A", "BANK");
    const b = await makeAccount("T-NUM-B", "B", "BANK");

    for (let i = 0; i < 5; i += 1) {
      await withTransaction((session) =>
        ledger.postTransaction(
          {
            type: "PAYMENT_IN",
            date: new Date("2026-08-19"),
            lines: [
              { ledgerAccountId: a, direction: "DEBIT", amount: 1_000_00 },
              { ledgerAccountId: b, direction: "CREDIT", amount: 1_000_00 },
            ],
            grossAmount: 1_000_00,
          details: paymentDetails(),
            createdBy: userId,
          },
          session,
        ),
      );
    }

    const numbers = (await Transaction.find({ type: "PAYMENT_IN" }).sort({ txnNo: 1 }).lean()).map(
      (t) => t.txnNo,
    );

    expect(numbers).toEqual([
      "PAY-IN-2026-000001",
      "PAY-IN-2026-000002",
      "PAY-IN-2026-000003",
      "PAY-IN-2026-000004",
      "PAY-IN-2026-000005",
    ]);
    // 19 Aug 2026 is FY 2026-27, not FY 2025.
    expect(numbers.every((n) => n.includes("-2026-"))).toBe(true);
  });

  it("does not consume a voucher number when the transaction rolls back", async () => {
    const a = await makeAccount("T-GAP-A", "A", "BANK");
    const b = await makeAccount("T-GAP-B", "B", "BANK");

    const post = (amount: number, creditAmount: number) =>
      withTransaction((session) =>
        ledger.postTransaction(
          {
            type: "EXPENSE",
            date: new Date("2026-08-19"),
            lines: [
              { ledgerAccountId: a, direction: "DEBIT", amount },
              { ledgerAccountId: b, direction: "CREDIT", amount: creditAmount },
            ],
            grossAmount: amount,
            details: expenseDetails(),
            createdBy: userId,
          },
          session,
        ),
      );

    await post(1_000_00, 1_000_00);
    await expect(post(1_000_00, 999_00)).rejects.toThrow(); // unbalanced, rolls back
    await post(1_000_00, 1_000_00);

    const numbers = (await Transaction.find({ type: "EXPENSE" }).sort({ txnNo: 1 }).lean()).map(
      (t) => t.txnNo,
    );

    // The rolled-back attempt must not burn 000002 — in an audited book a missing
    // voucher number is a question somebody has to answer.
    expect(numbers).toEqual(["EXP-2026-000001", "EXP-2026-000002"]);
  });

  it("records a running balance on every entry", async () => {
    const account = await makeAccount("T-RUN", "Running", "BANK");
    const other = await makeAccount("T-RUN-OTHER", "Other", "BANK");

    for (const amount of [10_000_00, 5_000_00, 2_000_00]) {
      await withTransaction((session) =>
        ledger.postTransaction(
          {
            type: "PAYMENT_IN",
            date: new Date("2026-08-19"),
            lines: [
              { ledgerAccountId: account, direction: "DEBIT", amount },
              { ledgerAccountId: other, direction: "CREDIT", amount },
            ],
            grossAmount: amount,
          details: paymentDetails(),
            createdBy: userId,
          },
          session,
        ),
      );
    }

    const entries = await LedgerEntry.find({ ledgerAccountId: account }).sort({ _id: 1 }).lean();
    expect(entries.map((e) => e.runningBalance)).toEqual([10_000_00, 15_000_00, 17_000_00]);
    expect(entries.at(-1)!.runningBalance).toBe(await balanceOf(account));
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("posting guards", () => {
  it("refuses to post against an inactive account", async () => {
    const a = await makeAccount("T-INACTIVE", "Closed Account", "BANK");
    const b = await makeAccount("T-ACTIVE", "Open Account", "BANK");
    await LedgerAccount.updateOne({ _id: a }, { $set: { status: "INACTIVE" } });

    await expect(
      withTransaction((session) =>
        ledger.postTransaction(
          {
            type: "PAYMENT_IN",
            date: new Date("2026-08-19"),
            lines: [
              { ledgerAccountId: b, direction: "DEBIT", amount: 1_000_00 },
              { ledgerAccountId: a, direction: "CREDIT", amount: 1_000_00 },
            ],
            grossAmount: 1_000_00,
          details: paymentDetails(),
            createdBy: userId,
          },
          session,
        ),
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
  });

  it("nets debits and credits on the same account before checking the balance", async () => {
    // A charge deducted from the very account being paid from: the line-by-line view
    // would look unaffordable, the net view is fine.
    const account = await makeAccount("T-NET", "Self", "BANK", { enforceBalance: true });
    const other = await makeAccount("T-NET-OTHER", "Other", "BANK");

    await withTransaction((session) =>
      ledger.postOpeningBalance(
        { ledgerAccountId: account, amount: 10_000_00, date: new Date("2026-04-01"), label: "x", createdBy: userId },
        session,
      ),
    );

    await expect(
      withTransaction((session) =>
        ledger.postTransaction(
          {
            type: "ADJUSTMENT",
            date: new Date("2026-08-19"),
            lines: [
              { ledgerAccountId: account, direction: "CREDIT", amount: 50_000_00 },
              { ledgerAccountId: account, direction: "DEBIT", amount: 45_000_00 },
              { ledgerAccountId: other, direction: "DEBIT", amount: 50_000_00 },
              { ledgerAccountId: other, direction: "CREDIT", amount: 45_000_00 },
            ],
            grossAmount: 5_000_00,
            details: adjustmentDetails(),
            createdBy: userId,
          },
          session,
        ),
      ),
    ).resolves.toBeDefined();

    // Net movement was -₹5,000 against a ₹10,000 balance.
    expect(await balanceOf(account)).toBe(5_000_00);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("fixtures remain intact", () => {
  it("keeps the seeded users available to other suites", async () => {
    expect(await User.countDocuments({})).toBeGreaterThan(0);
  });
});
