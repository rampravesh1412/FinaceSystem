import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import type { OpeningBalanceState } from "@amiri/shared";
import { createApp } from "../../app.js";
import { BankAccount, CashAccount, LedgerAccount, Transaction } from "../../models/index.js";
import { ensureSystemAccounts, systemAccountId, verifyBalance } from "../../services/ledger.service.js";
import { TestClient, clearFixtures, seedFixtures } from "../../test/helpers.js";

/**
 * Correcting an opening balance, and soft-deleting an account.
 *
 * The opening may change only while it is the account's sole posting, and it changes the
 * way every posted figure here changes — reversed and reposted, never rewritten. Delete is
 * a super admin's, refused while the account holds money, and hides without erasing.
 */

let app: Express;
let client: TestClient;
let superToken: string;
let adminToken: string;
let bankId: string;
let seq = 0;

type ErrorBody = { error: { message: string; field?: string } };

beforeAll(async () => {
  await clearFixtures();
  await seedFixtures();
  await ensureSystemAccounts();

  app = createApp();
  client = new TestClient();
  await client.start(app);

  superToken = await client.loginAs("super@test.co");
  adminToken = await client.loginAs("badmin@test.co");

  const bank = await client.post<{ data: { id: string } }>(
    "/banks",
    { name: "HDFC Bank", shortName: "HDFC", ifscPrefix: "HDFC" },
    { token: superToken },
  );
  bankId = bank.body.data.id;
});

afterAll(async () => {
  await client.stop();
  await clearFixtures();
});

/** A fresh account per test, so no test leans on another's postings. */
async function openBankAccount(openingBalance: string) {
  seq += 1;
  const res = await client.post<{ data: { id: string; ledgerAccountId: string; balance: number } }>(
    "/bank-accounts",
    {
      bankId,
      accountName: `Opening Test ${seq}`,
      accountNumber: `5010000000${String(seq).padStart(4, "0")}`,
      ifsc: "HDFC0001234",
      openingBalance,
    },
    { token: superToken },
  );
  expect(res.status).toBe(201);
  return res.body.data;
}

async function openDrawer(name: string, openingBalance: string) {
  const res = await client.post<{ data: { id: string; ledgerAccountId: string; isDefault: boolean } }>(
    "/cash-accounts",
    { name, openingBalance },
    { token: superToken },
  );
  expect(res.status).toBe(201);
  return res.body.data;
}

const getOpening = (path: string) =>
  client.get<{ data: OpeningBalanceState }>(`${path}/opening-balance`, { token: superToken });

const setOpening = (path: string, openingBalance: string, token = superToken) =>
  client.request<{ data: OpeningBalanceState } & ErrorBody>("PUT", `${path}/opening-balance`, {
    body: { openingBalance },
    token,
  });

const today = () => new Date().toISOString().slice(0, 10);

describe("opening balance correction", () => {
  it("reverses the old opening and posts the corrected one, on the same date", async () => {
    const account = await openBankAccount("5,000");
    const path = `/bank-accounts/${account.id}`;

    const before = await getOpening(path);
    expect(before.body.data).toMatchObject({ amount: 5_000_00, editable: true, otherEntryCount: 0 });

    const res = await setOpening(path, "7,500");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ amount: 7_500_00, editable: true });

    const ledgerAccount = (await LedgerAccount.findById(account.ledgerAccountId).lean())!;
    expect(ledgerAccount.cachedBalance).toBe(7_500_00);

    // Three documents, all on the books: the original REVERSED, its mirror, the replacement.
    const original = (await Transaction.findOne({ txnNo: before.body.data.txnNo }).lean())!;
    expect(original.status).toBe("REVERSED");
    expect(original.reversedBy).toBeTruthy();
    const replacement = (await Transaction.findOne({ txnNo: res.body.data.txnNo }).lean())!;
    expect(String(original.supersededBy)).toBe(String(replacement._id));
    expect(String(replacement.supersedes)).toBe(String(original._id));
    expect(replacement.date.toISOString()).toBe(original.date.toISOString());

    // Nothing was rewritten, so the cache still agrees with a full replay on both sides.
    expect((await verifyBalance(account.ledgerAccountId)).matches).toBe(true);
    expect((await verifyBalance(await systemAccountId("OPENING_EQUITY"))).matches).toBe(true);
  });

  it("can be corrected again, and down to zero", async () => {
    const account = await openBankAccount("1,000");
    const path = `/bank-accounts/${account.id}`;

    expect((await setOpening(path, "2,000")).status).toBe(200);
    // An opening and its reversals share the type, so a second correction is still allowed.
    const zero = await setOpening(path, "0");
    expect(zero.status).toBe(200);
    expect(zero.body.data).toMatchObject({ amount: 0, txnNo: null, editable: true });

    const ledgerAccount = (await LedgerAccount.findById(account.ledgerAccountId).lean())!;
    expect(ledgerAccount.cachedBalance).toBe(0);
  });

  it("gives an account that opened at zero its first opening", async () => {
    const account = await openBankAccount("0");
    const path = `/bank-accounts/${account.id}`;

    expect((await getOpening(path)).body.data).toMatchObject({ amount: 0, date: null, editable: true });

    const res = await setOpening(path, "12,345.50");
    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe(12_345_50);
    expect(res.body.data.txnNo).toBeTruthy();
  });

  it("locks once anything else has been posted to the account", async () => {
    const source = await openBankAccount("10,000");
    const destination = await openBankAccount("0");

    const transfer = await client.post(
      "/bank-transfers",
      {
        date: today(),
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amount: "100",
        paymentMode: "NEFT",
      },
      { token: superToken },
    );
    expect(transfer.status).toBe(201);

    for (const account of [source, destination]) {
      const path = `/bank-accounts/${account.id}`;
      expect((await getOpening(path)).body.data).toMatchObject({ editable: false, otherEntryCount: 1 });

      const res = await setOpening(path, "50,000");
      expect(res.status).toBe(400);
      expect(res.body.error.field).toBe("openingBalance");
      expect(res.body.error.message).toMatch(/locked/i);
    }
  });

  it("refuses a drawer opening below zero, and allows a negative bank opening", async () => {
    const drawer = await openDrawer("Opening Test Drawer", "500");
    const refused = await setOpening(`/cash-accounts/${drawer.id}`, "-100");
    expect(refused.status).toBe(400);

    // An overdraft account may genuinely start drawn down.
    const account = await openBankAccount("0");
    const res = await setOpening(`/bank-accounts/${account.id}`, "-2,500");
    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe(-2_500_00);
  });
});

describe("soft delete", () => {
  it("hides a zero-balance account everywhere and erases nothing", async () => {
    const account = await openBankAccount("0");

    const res = await client.del(`/bank-accounts/${account.id}`, { token: superToken });
    expect(res.status).toBe(200);

    // Gone from the list that feeds the Accounts screen and every picker…
    const list = await client.get<{ data: Array<{ id: string }> }>("/bank-accounts?limit=100", { token: superToken });
    expect(list.body.data.map((a) => a.id)).not.toContain(account.id);

    // …and from the ledger pickers.
    const ledgerList = await client.get<{ data: Array<{ id: string }> }>(
      "/ledger/accounts?kind=BANK&limit=200",
      { token: superToken },
    );
    expect(ledgerList.body.data.map((a) => a.id)).not.toContain(account.ledgerAccountId);

    // But the record and its ledger account are still there, retired.
    const doc = (await BankAccount.findById(account.id).lean())!;
    expect(doc.deletedAt).toBeInstanceOf(Date);
    expect(doc.status).toBe("INACTIVE");
    const ledgerAccount = (await LedgerAccount.findById(account.ledgerAccountId).lean())!;
    expect(ledgerAccount.status).toBe("INACTIVE");

    // And it cannot be edited back into use.
    const edit = await client.patch(`/bank-accounts/${account.id}`, { status: "ACTIVE" }, { token: superToken });
    expect(edit.status).toBe(404);
  });

  it("is for a super admin only", async () => {
    const account = await openBankAccount("0");

    const res = await client.del(`/bank-accounts/${account.id}`, { token: adminToken });
    expect(res.status).toBe(403);
    expect((await BankAccount.findById(account.id).lean())!.deletedAt).toBeNull();
  });

  it("refuses while the account holds money, and allows it once the opening is zeroed", async () => {
    const account = await openBankAccount("64,964");

    const refused = await client.del<ErrorBody>(`/bank-accounts/${account.id}`, { token: superToken });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain("64,964");

    expect((await setOpening(`/bank-accounts/${account.id}`, "0")).status).toBe(200);
    expect((await client.del(`/bank-accounts/${account.id}`, { token: superToken })).status).toBe(200);
  });

  it("hands the default flag to another drawer when the default one is deleted", async () => {
    // Earlier tests opened a drawer, so find whichever is default now and empty it.
    const drawers = await CashAccount.find({ deletedAt: null }).sort({ createdAt: 1 }).lean();
    const current = drawers.find((d) => d.isDefault)!;
    const successor = await openDrawer("Successor Drawer", "0");
    expect(successor.isDefault).toBe(false);

    expect((await setOpening(`/cash-accounts/${current._id}`, "0")).status).toBe(200);
    expect((await client.del(`/cash-accounts/${current._id}`, { token: superToken })).status).toBe(200);

    const after = await CashAccount.find({ isDefault: true }).lean();
    expect(after).toHaveLength(1);
    expect(after[0]!.deletedAt).toBeNull();
    expect(String(after[0]!._id)).not.toBe(String(current._id));
  });

  it("says plainly when a new drawer's name belongs to a deleted one", async () => {
    const drawer = await openDrawer("Reused Name", "0");
    expect((await client.del(`/cash-accounts/${drawer.id}`, { token: superToken })).status).toBe(200);

    const res = await client.post<ErrorBody>("/cash-accounts", { name: "Reused Name", openingBalance: "0" }, { token: superToken });
    expect(res.status).toBe(409);
    expect(res.body.error.field).toBe("name");
    expect(res.body.error.message).toMatch(/deleted/i);
  });
});
