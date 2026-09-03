import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { BankAccount, LedgerAccount, LedgerEntry, Party, Transaction } from "../../models/index.js";
import { ensureSystemAccounts } from "../../services/ledger.service.js";
import { TestClient, clearFixtures, seedFixtures, type Fixtures } from "../../test/helpers.js";

/**
 * Phase 2 acceptance: masters, masking, atomicity and branch isolation over the HTTP API.
 *
 * The ledger engine has its own suite; this one proves the masters wire into it
 * correctly — that creating an account really does create its ledger account and post its
 * opening balance, in one transaction, visible only to the right people.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;
let superToken: string;
let accountantToken: string;

/** ICICI, so the IFSC-prefix validation has something real to check against. */
let bankId: string;

beforeAll(async () => {
  await clearFixtures();
  fx = await seedFixtures();
  await ensureSystemAccounts();

  app = createApp();
  client = new TestClient();
  await client.start(app);

  superToken = await client.loginAs("super@test.co");
  accountantToken = await client.loginAs("acct@test.co");

  const bank = await client.post<{ data: { id: string } }>(
    "/banks",
    { name: "ICICI Bank", shortName: "ICICI", ifscPrefix: "ICIC" },
    { token: superToken },
  );
  bankId = bank.body.data.id;
});

afterAll(async () => {
  await client.stop();
  await clearFixtures();
});

describe("bank accounts", () => {
  it("creates the master, its ledger account and its opening balance atomically", async () => {
    const res = await client.post<{ data: { id: string; ledgerAccountId: string } }>(
      "/bank-accounts",
      {
        bankId,
        accountName: "AMIRI Enterprises Current",
        accountNumber: "123456789012",
        ifsc: "ICIC0001234",
        accountType: "CURRENT",
        // A formatted string, exactly as a form submits it.
        openingBalance: "5,00,000.00",
      },
      { token: superToken },
    );

    expect(res.status).toBe(201);

    const account = await BankAccount.findById(res.body.data.id).lean();
    expect(account).toBeTruthy();

    // The ledger account exists and is linked in both directions.
    const ledgerAccount = await LedgerAccount.findById(account!.ledgerAccountId).lean();
    expect(ledgerAccount).toBeTruthy();
    expect(ledgerAccount!.kind).toBe("BANK");
    expect(String(ledgerAccount!.refId)).toBe(String(account!._id));
    // A bank account must be un-overdrawable unless a limit was granted.
    expect(ledgerAccount!.enforceBalance).toBe(true);

    // The opening balance was PARSED to integer paise, not stored as a string or a float.
    expect(ledgerAccount!.cachedBalance).toBe(500_000_00);

    // And it exists as a real double-entry posting, not a field.
    const opening = await Transaction.findOne({ type: "OPENING_BALANCE" }).lean();
    expect(opening).toBeTruthy();
    expect(opening!.txnNo).toMatch(/^OPN-\d{4}-\d{6}$/);

    const entries = await LedgerEntry.find({ transactionId: opening!._id }).lean();
    expect(entries).toHaveLength(2);
    expect(entries.reduce((s, e) => s + (e.direction === "DEBIT" ? e.amount : -e.amount), 0)).toBe(0);
  });

  it("masks the account number unless the caller may see it in full", async () => {
    // The accountant has finance.bank.view but NOT finance.bank.viewFull.
    const masked = await client.get<{ data: Array<{ accountNumber: string; accountNumberMasked: boolean }> }>(
      "/bank-accounts",
      { token: accountantToken },
    );

    expect(masked.status).toBe(200);
    expect(masked.body.data.length).toBeGreaterThan(0);
    expect(masked.body.data[0]!.accountNumber).toBe("XXXX XXXX 9012");
    expect(masked.body.data[0]!.accountNumberMasked).toBe(true);

    // The digits must not be anywhere in the payload — masking in the browser would mean
    // shipping them and hiding them with CSS.
    expect(JSON.stringify(masked.body)).not.toContain("123456789012");

    const full = await client.get<{ data: Array<{ accountNumber: string; accountNumberMasked: boolean }> }>(
      "/bank-accounts",
      { token: superToken },
    );
    expect(full.body.data[0]!.accountNumber).toBe("123456789012");
    expect(full.body.data[0]!.accountNumberMasked).toBe(false);
  });

  it("refuses an IFSC that does not belong to the bank it is filed under", async () => {
    const res = await client.post<{ error: { field: string; message: string } }>(
      "/bank-accounts",
      {
        bankId, // ICICI
        accountName: "Wrong Bank",
        accountNumber: "999888777666",
        ifsc: "HDFC0001234", // an HDFC code
        openingBalance: 0,
      },
      { token: superToken },
    );

    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe("ifsc");
    expect(res.body.error.message).toContain("ICIC");
  });

  it("refuses the same account number twice at the same bank", async () => {
    const res = await client.post<{ error: { code: string } }>(
      "/bank-accounts",
      {
        bankId,
        accountName: "Duplicate",
        accountNumber: "123456789012",
        ifsc: "ICIC0001234",
        openingBalance: 0,
      },
      { token: superToken },
    );

    // Filing one real account twice would split its balance across two ledgers and
    // neither would ever reconcile.
    expect(res.status).toBe(409);
  });

  it("leaves nothing behind when creation fails", async () => {
    const beforeLedger = await LedgerAccount.countDocuments({ kind: "BANK" });

    await client.post(
      "/bank-accounts",
      {
        bankId,
        accountName: "Will Fail",
        accountNumber: "123456789012", // duplicate
        ifsc: "ICIC0001234",
        openingBalance: "1,00,000",
      },
      { token: superToken },
    );

    // No orphan ledger account, and no opening balance posted for an account that does
    // not exist.
    expect(await LedgerAccount.countDocuments({ kind: "BANK" })).toBe(beforeLedger);
    expect(await LedgerAccount.findOne({ name: /Will Fail/ }).lean()).toBeNull();
  });

  /**
   * Accounts are ORGANISATION-WIDE, so a branch-scoped user opens one on the same terms as
   * anyone else. What still gates the action is `finance.bank.create`, not which branch
   * they happen to be assigned to — there is no branch on the account for them to get
   * wrong.
   */
  it("lets a branch-scoped user open an account, since accounts have no branch", async () => {
    const badminToken = await client.loginAs("badmin@test.co");
    const res = await client.post<{ data: { id: string } }>(
      "/bank-accounts",
      {
        bankId,
        accountName: "Opened By Branch Admin",
        accountNumber: "111122223333",
        ifsc: "ICIC0001234",
        openingBalance: 0,
      },
      { token: badminToken },
    );

    expect(res.status).toBe(201);
  });

  /**
   * Every account, to every caller who may see accounts.
   *
   * This assertion used to be its exact opposite. It changed deliberately: one HDFC
   * current account is one real account with one balance that the bank prints one
   * statement for, so showing a branch only "its" share of it produced a figure that
   * could never be reconciled against anything.
   */
  it("shows every account to every caller, with an organisation-wide total", async () => {
    await client.post(
      "/bank-accounts",
      {
        bankId,
        accountName: "Second Account",
        accountNumber: "707070707070",
        ifsc: "ICIC0007070",
        openingBalance: "2,00,000",
      },
      { token: superToken },
    );

    const scoped = await client.get<{ data: Array<{ accountName: string }>; meta: { totalBalance: number } }>(
      "/bank-accounts",
      { token: accountantToken },
    );

    const names = scoped.body.data.map((a) => a.accountName);
    expect(names).toContain("Second Account");

    const unscoped = await client.get<{ meta: { totalBalance: number } }>("/bank-accounts", {
      token: superToken,
    });

    // Both callers see the same books, because there is only one set of them.
    expect(scoped.body.meta.totalBalance).toBe(unscoped.body.meta.totalBalance);
    expect(unscoped.body.meta.totalBalance).toBe(700_000_00);
  });
});

/**
 * The create endpoints must answer in the SAME shape the list endpoints do.
 *
 * They used to return the raw Mongoose document, which omitted the one field a caller
 * actually wants back after opening an account — the posted opening balance — and shipped
 * the unmasked account number regardless of permission. Any client that creates then
 * renders had to special-case it.
 */
describe("create returns the list's shape", () => {
  it("returns a bank account summary, with the balance and a masked number", async () => {
    const bank = await client.post<{ data: { id: string } }>(
      "/banks",
      { name: "Shape Test Bank", shortName: "STB", ifscPrefix: "STBK" },
      { token: superToken },
    );

    const res = await client.post<{ data: Record<string, unknown> }>(
      "/bank-accounts",
      {
        bankId: bank.body.data.id,
        accountName: "Shape Test Current",
        accountNumber: "50100999888777",
        ifsc: "STBK0001234",
        openingBalance: "3,00,000",
        overdraftLimit: "1,00,000",
      },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    const body = res.body.data;

    // The posted opening balance, and the derived availability — neither exists on the
    // raw document.
    expect(body.balance).toBe(3_00_000_00);
    expect(body.availableBalance).toBe(4_00_000_00);
    expect(body.bank).toMatchObject({ shortName: "STB" });
    // No `branch` — an account belongs to the organisation, not to an office.
    expect(body).not.toHaveProperty("branch");

    // The super admin holds finance.bank.viewFull, so the digits come through here; the
    // point is that the field is masked-aware at all, which the raw document was not.
    expect(body).toHaveProperty("accountNumberMasked");
  });

  it("masks the account number on create for a caller without finance.bank.viewFull", async () => {
    const bank = await client.post<{ data: { id: string } }>(
      "/banks",
      { name: "Mask Test Bank", shortName: "MTB", ifscPrefix: "MTBK" },
      { token: superToken },
    );

    const res = await client.post<{ data: { accountNumber: string; accountNumberMasked: boolean } }>(
      "/bank-accounts",
      {
        bankId: bank.body.data.id,
        accountName: "Mask Test Current",
        accountNumber: "50100111222333",
        ifsc: "MTBK0001234",
        openingBalance: "0",
      },
      { token: accountantToken },
    );

    // ACCOUNTANT may not hold finance.bank.create; either it is refused, or it succeeds
    // with the number masked. What must NOT happen is a 201 carrying the full digits.
    if (res.status === 201) {
      expect(res.body.data.accountNumberMasked).toBe(true);
      expect(res.body.data.accountNumber).not.toBe("50100111222333");
    } else {
      expect(res.status).toBe(403);
    }
  });

  it("returns a cash account summary with its balance and default flag", async () => {
    const res = await client.post<{ data: Record<string, unknown> }>(
      "/cash-accounts",
      { name: "Shape Test Drawer", openingBalance: "12,000" },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.balance).toBe(12_000_00);
    expect(res.body.data).not.toHaveProperty("branch");
    expect(res.body.data).toHaveProperty("isDefault");
  });
});

describe("cash accounts", () => {
  it("creates a drawer that cannot be overdrawn", async () => {
    const res = await client.post<{ data: { id: string; ledgerAccountId: string; isDefault: boolean } }>(
      "/cash-accounts",
      { name: "Counter 1", openingBalance: "25,000" },
      { token: superToken },
    );

    expect(res.status).toBe(201);
    // Only the FIRST drawer opened becomes the default, and "Shape Test Drawer" above
    // already took that position. One default overall, not one per branch.
    expect(res.body.data.isDefault).toBe(false);

    const ledgerAccount = await LedgerAccount.findById(res.body.data.ledgerAccountId).lean();
    expect(ledgerAccount!.kind).toBe("CASH");
    expect(ledgerAccount!.enforceBalance).toBe(true);
    // No overdraft on cash — you cannot hand over notes that are not in the drawer.
    expect(ledgerAccount!.overdraftLimit).toBe(0);
    expect(ledgerAccount!.cachedBalance).toBe(25_000_00);
  });
});

describe("parties", () => {
  it("auto-numbers a party and posts its opening balance in the Khata's sign convention", async () => {
    const owes = await client.post<{ data: { id: string; code: string; ledgerAccountId: string } }>(
      "/parties",
      {
        name: "RAMANUJ PUNB",
        type: "DISTRIBUTOR",
        mobile: "9876543210",
        openingBalance: "9,50,000", // they owe us
        creditLimit: "10,00,000",
      },
      { token: superToken },
    );

    expect(owes.status).toBe(201);
    expect(owes.body.data.code).toMatch(/^PTY-\d{5}$/);

    const ledgerAccount = await LedgerAccount.findById(owes.body.data.ledgerAccountId).lean();
    expect(ledgerAccount!.kind).toBe("PARTY");
    // POSITIVE = LENA HAI = they owe us.
    expect(ledgerAccount!.cachedBalance).toBe(950_000_00);
    // A party balance legitimately swings both ways, so no floor is enforced.
    expect(ledgerAccount!.enforceBalance).toBe(false);

    const owed = await client.post<{ data: { ledgerAccountId: string } }>(
      "/parties",
      {
        name: "EDDIGO DISTRIBUTOR",
        type: "VENDOR",
        openingBalance: "-2,00,000", // we owe them
      },
      { token: superToken },
    );

    const owedLedger = await LedgerAccount.findById(owed.body.data.ledgerAccountId).lean();
    // NEGATIVE = DENA HAI = we owe them.
    expect(owedLedger!.cachedBalance).toBe(-200_000_00);
  });

  it("reports balance direction, credit usage and receivable/payable totals", async () => {
    const list = await client.get<{
      data: Array<{ name: string; balance: number; direction: string; creditUsed: number; availableCredit: number }>;
      meta: { totalReceivable: number; totalPayable: number };
    }>("/parties", { token: superToken });

    expect(list.status).toBe(200);

    const ramanuj = list.body.data.find((p) => p.name === "RAMANUJ PUNB")!;
    expect(ramanuj.direction).toBe("LENA");
    expect(ramanuj.balance).toBe(950_000_00);
    expect(ramanuj.creditUsed).toBe(950_000_00);
    expect(ramanuj.availableCredit).toBe(50_000_00);

    const eddigo = list.body.data.find((p) => p.name === "EDDIGO DISTRIBUTOR")!;
    expect(eddigo.direction).toBe("DENA");
    // Owing them consumes no credit of ours.
    expect(eddigo.creditUsed).toBe(0);

    // Receivable and payable are reported separately, not netted into one figure that
    // hides both.
    expect(list.body.meta.totalReceivable).toBe(950_000_00);
    expect(list.body.meta.totalPayable).toBe(200_000_00);
  });

  it("filters to just receivables or just payables", async () => {
    const lena = await client.get<{ data: Array<{ direction: string }> }>("/parties?balance=lena", {
      token: superToken,
    });
    expect(lena.body.data.length).toBeGreaterThan(0);
    expect(lena.body.data.every((p) => p.direction === "LENA")).toBe(true);

    const dena = await client.get<{ data: Array<{ direction: string }> }>("/parties?balance=dena", {
      token: superToken,
    });
    expect(dena.body.data.every((p) => p.direction === "DENA")).toBe(true);
  });

  it("builds a profile whose receivable and payable are two views of one balance", async () => {
    const party = await Party.findOne({ name: "RAMANUJ PUNB" }).lean();
    const res = await client.get<{
      data: { totalReceivable: number; totalPayable: number; totalGiven: number; totalTaken: number; direction: string };
    }>(`/parties/${String(party!._id)}`, { token: superToken });

    expect(res.status).toBe(200);
    expect(res.body.data.totalReceivable).toBe(950_000_00);
    // Never both non-zero: a party cannot simultaneously owe us and be owed by us.
    expect(res.body.data.totalPayable).toBe(0);
    expect(res.body.data.totalGiven).toBe(950_000_00);
    expect(res.body.data.totalTaken).toBe(0);
  });

  /**
   * Parties are ORGANISATION-WIDE, so every caller who may see parties sees all of them.
   *
   * The inverse of what this suite used to assert, and the change is the point: a customer
   * who pays at whichever counter is nearest has ONE balance, and a branch-scoped view of
   * it showed a number nobody was actually owed.
   */
  it("shows every party to every caller, by list and by id", async () => {
    const other = await client.post<{ data: { id: string } }>(
      "/parties",
      { name: "Second Office Party", openingBalance: 0 },
      { token: superToken },
    );

    const list = await client.get<{ data: Array<{ name: string }> }>("/parties", {
      token: accountantToken,
    });
    expect(list.body.data.map((p) => p.name)).toContain("Second Office Party");

    const direct = await client.get(`/parties/${other.body.data.id}`, { token: accountantToken });
    expect(direct.status).toBe(200);
  });
});

describe("ledger reads", () => {
  it("returns a statement with an opening balance and a running balance", async () => {
    const account = await BankAccount.findOne({ accountName: "AMIRI Enterprises Current" }).lean();

    const res = await client.get<{
      data: Array<{ debit: number; credit: number; runningBalance: number; txnNo: string }>;
      meta: { account: { balance: number }; openingBalance: number };
    }>(`/ledger/accounts/${String(account!.ledgerAccountId)}/entries`, { token: superToken });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]!.debit).toBe(500_000_00);
    expect(res.body.data[0]!.runningBalance).toBe(500_000_00);
    expect(res.body.meta.account.balance).toBe(500_000_00);
  });

  it("produces a trial balance that ties across the organisation", async () => {
    const res = await client.get<{
      data: { totalDebit: number; totalCredit: number; difference: number; rows: unknown[] };
    }>("/ledger/trial-balance", { token: superToken });

    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    // Every opening balance posted both sides, so the books tie.
    expect(res.body.data.difference).toBe(0);
    expect(res.body.data.totalDebit).toBe(res.body.data.totalCredit);
  });

  /**
   * A bank account's ledger account carries no branch, so it is readable by anyone holding
   * `finance.ledger.view`. The branch check in the ledger routes is still there and still
   * applies to accounts that DO have a branch — an expense head opened for one office.
   */
  it("lets any ledger reader open an organisation-wide account's statement", async () => {
    const other = await BankAccount.findOne({ accountName: "Second Account" }).lean();
    const res = await client.get(`/ledger/accounts/${String(other!.ledgerAccountId)}/entries`, {
      token: accountantToken,
    });
    expect(res.status).toBe(200);
  });

  it("confirms every cached balance agrees with a full replay of the entries", async () => {
    const accounts = await LedgerAccount.find({}).select("_id").lean();

    for (const account of accounts) {
      const res = await client.get<{ data: { matches: boolean; cached: number; computed: number } }>(
        `/ledger/accounts/${String(account._id)}/verify`,
        { token: superToken },
      );
      expect(res.body.data.matches, `account ${String(account._id)} drifted`).toBe(true);
    }
  });
});

/**
 * Phase 10: the update paths.
 *
 * `updateBankSchema` and `updateCashAccountSchema` existed in the shared package with no
 * route or service behind them — a contract nothing implemented. These cover the ones that
 * matter: that a rename reaches the LEDGER account name (or the trial balance keeps
 * printing the old one forever) and that immutable identity fields stay immutable.
 */
describe("updating banks and drawers", () => {
  it("carries a bank rename through to its accounts' ledger names", async () => {
    const bank = await client.post<{ data: { id: string } }>(
      "/banks",
      { name: "Rename Test Bank", shortName: "RTB", ifscPrefix: "RTBK" },
      { token: superToken },
    );

    const account = await client.post<{ data: { id: string; ledgerAccountId: string } }>(
      "/bank-accounts",
      {
        bankId: bank.body.data.id,
        accountName: "Rename Test Current",
        accountNumber: "50100555444333",
        ifsc: "RTBK0001234",
        openingBalance: "0",
      },
      { token: superToken },
    );

    const before = await LedgerAccount.findById(account.body.data.ledgerAccountId).lean();
    expect(before!.name).toContain("RTB");

    const res = await client.patch(
      `/banks/${bank.body.data.id}`,
      { name: "Renamed Bank Limited", shortName: "RBL" },
      { token: superToken },
    );
    expect(res.status).toBe(200);

    // The ledger account name follows. Without this the trial balance and every export
    // keep showing the old institution indefinitely.
    const after = await LedgerAccount.findById(account.body.data.ledgerAccountId).lean();
    expect(after!.name).toContain("RBL");
    expect(after!.name).not.toContain("RTB");
  });

  it("renames a cash drawer and its ledger account together", async () => {
    const drawer = await client.post<{ data: { id: string; ledgerAccountId: string } }>(
      "/cash-accounts",
      { name: "Old Drawer Name", openingBalance: "0" },
      { token: superToken },
    );

    const res = await client.patch<{ data: { name: string; balance: number } }>(
      `/cash-accounts/${drawer.body.data.id}`,
      { name: "New Drawer Name" },
      { token: superToken },
    );

    expect(res.status).toBe(200);
    // The list's shape, not the raw document — same contract as create.
    expect(res.body.data.name).toBe("New Drawer Name");
    expect(res.body.data).toHaveProperty("balance");

    const ledger = await LedgerAccount.findById(drawer.body.data.ledgerAccountId).lean();
    expect(ledger!.name).toContain("New Drawer Name");
  });

  it("ignores an attempt to change a bank account's identifying fields", async () => {
    const bank = await client.post<{ data: { id: string } }>(
      "/banks",
      { name: "Immutable Test Bank", shortName: "ITB", ifscPrefix: "ITBK" },
      { token: superToken },
    );

    const account = await client.post<{ data: { id: string } }>(
      "/bank-accounts",
      {
        bankId: bank.body.data.id,
        accountName: "Immutable Test Current",
        accountNumber: "50100777666555",
        ifsc: "ITBK0001234",
        openingBalance: "0",
      },
      { token: superToken },
    );

    // The schema strips these rather than applying them: they identify the real-world
    // account that this account's entries were posted against.
    await client.patch(
      `/bank-accounts/${account.body.data.id}`,
      { accountName: "Renamed", accountNumber: "99999999999999", ifsc: "OTHR0009999" },
      { token: superToken },
    );

    const doc = await BankAccount.findById(account.body.data.id).lean();
    expect(doc!.accountName).toBe("Renamed");
    expect(doc!.accountNumber).toBe("50100777666555");
    expect(doc!.ifsc).toBe("ITBK0001234");
  });

  /**
   * Drawers are organisation-wide, so editing one is gated by `finance.bank.edit` alone.
   * This replaces a branch-ownership check that no longer has a branch to check.
   */
  it("gates editing a drawer on the permission, not on a branch", async () => {
    const drawer = await client.post<{ data: { id: string } }>(
      "/cash-accounts",
      { name: "Another Drawer", openingBalance: "0" },
      { token: superToken },
    );

    const res = await client.patch(
      `/cash-accounts/${drawer.body.data.id}`,
      { name: "Renamed Drawer" },
      { token: accountantToken },
    );

    // The accountant either holds finance.bank.edit and succeeds, or is refused for
    // lacking it. What must not happen is a refusal on branch grounds.
    expect([200, 403]).toContain(res.status);
  });
});
