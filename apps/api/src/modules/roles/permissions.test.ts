import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { BankAccount, Role, User } from "../../models/index.js";
import { ensureSystemAccounts } from "../../services/ledger.service.js";
import { TEST_PASSWORD, TestClient, clearFixtures, seedFixtures } from "../../test/helpers.js";

/**
 * Authorization, end to end (§5, §57).
 *
 * The catalogue rewrite exists because of two failures that no test caught at the time:
 *
 *   1. seventeen permissions were grantable and enforced NOWHERE — `payment_out.approve`,
 *      `finance.party.creditLimit`, `finance.khata.entry` among them. Ticking the box
 *      changed nothing, and the real gate was some other key entirely.
 *   2. screens shared a permission, so "Payment In but not Payment Out" and "General
 *      Ledger but not Expense Ledger" could not be expressed at all.
 *
 * Both are invisible from the inside — a permission that enforces nothing looks exactly
 * like one that works until somebody relies on it. So these tests build roles that hold
 * ONE side of each split and prove the server refuses the other.
 */

let app: Express;
let client: TestClient;

/** A user whose role holds exactly these permissions, and nothing else. */
async function userWith(label: string, permissions: string[]): Promise<string> {
  const role = await Role.create({
    name: label.toUpperCase().replace(/[^A-Z0-9]/g, "_"),
    label,
    permissions,
    isSuperAdmin: false,
    isSystem: false,
  });

  const email = `${label.toLowerCase().replace(/[^a-z0-9]/g, "")}@test.co`;
  const user = new User({
    name: label,
    email,
    roleId: role._id,
    status: "ACTIVE",
    passwordHash: "placeholder",
  });
  await user.setPassword(TEST_PASSWORD);
  user.mustChangePassword = false;
  await user.save();

  return client.loginAs(email);
}

beforeAll(async () => {
  await clearFixtures();
  await seedFixtures();
  await ensureSystemAccounts();

  app = createApp();
  client = new TestClient();
  await client.start(app);

  // One bank account, so the masking test has a row to look at.
  const superToken = await client.loginAs("super@test.co");
  const bank = await client.post<{ data: { id: string } }>(
    "/banks",
    { name: "ICICI Bank", shortName: "ICICI", ifscPrefix: "ICIC" },
    { token: superToken },
  );
  await client.post(
    "/bank-accounts",
    {
      bankId: bank.body.data.id,
      accountName: "Permissions Test",
      accountNumber: "912010012345678",
      ifsc: "ICIC0001234",
      accountType: "CURRENT",
      openingBalance: "1,00,000",
    },
    { token: superToken },
  );
});

afterAll(async () => {
  await BankAccount.deleteMany({});
  await clearFixtures();
});

describe("permissions that used to be inseparable", () => {
  it("lets a role read receipts without reading payments out", async () => {
    const token = await userWith("Receipts Only", ["payment_in.view"]);

    expect((await client.get("/payment-in", { token })).status).toBe(200);
    // Under the old catalogue both screens answered to `finance.payment.view`, so this
    // was a 200 and the split was unexpressible.
    expect((await client.get("/payment-out", { token })).status).toBe(403);
  });

  it("lets a role read the General Ledger without every head's statement", async () => {
    const general = await userWith("General Only", ["general_ledger.view"]);
    const expenseOnly = await userWith("Expense Ledger Only", ["expense_ledger.view"]);

    // The picker opens for either.
    expect((await client.get("/ledger/accounts", { token: general })).status).toBe(200);
    expect((await client.get("/ledger/accounts", { token: expenseOnly })).status).toBe(200);

    const partyAccount = await client.get<{ data: Array<{ id: string }> }>(
      "/ledger/accounts?kind=PARTY&limit=1",
      { token: general },
    );
    const partyId = partyAccount.body.data[0]?.id;

    if (partyId) {
      // The General Ledger lists every account in the chart, so holding it is holding the
      // whole book — that is the screen's job, not an oversight.
      expect((await client.get(`/ledger/accounts/${partyId}/entries`, { token: general })).status).toBe(200);
      // Whereas the Expense Ledger reaches expense heads and nothing else.
      expect(
        (await client.get(`/ledger/accounts/${partyId}/entries`, { token: expenseOnly })).status,
      ).toBe(403);
    }
  });

  it("separates the heads chart from the expense figures", async () => {
    const token = await userWith("Spend Reader", ["expenses.view"]);

    expect((await client.get("/expenses", { token })).status).toBe(200);
    // Shared `finance.expense.view` before, so reading a total also opened the chart every
    // future posting is classified against.
    expect((await client.get("/expenses/categories", { token })).status).toBe(403);
  });

  it("separates the banks list from the accounts held with them", async () => {
    const token = await userWith("Banks Only", ["banks.view"]);

    expect((await client.get("/banks", { token })).status).toBe(200);
    expect((await client.get("/bank-accounts", { token })).status).toBe(403);
  });
});

describe("permissions that used to enforce nothing", () => {
  /**
   * The worst of them. Every approval ran off `approvals.act`, so one grant approved
   * payments, expenses, settlements and adjustments alike, and the five per-module
   * approve keys on the Roles screen were decoration.
   */
  it("refuses to approve a kind of transaction the role may not approve", async () => {
    const token = await userWith("Queue Worker", [
      "approvals.view",
      "approvals.approve",
      "expenses.approve",
      // Deliberately NOT payment_out.approve.
    ]);

    const queue = await client.get<{ data: Array<{ id: string; type: string }> }>("/approvals", {
      token,
    });
    expect(queue.status).toBe(200);

    const payout = queue.body.data.find((t) => t.type === "PAYMENT_OUT");
    if (payout) {
      const res = await client.post(`/approvals/${payout.id}/approve`, {}, { token });
      expect(res.status).toBe(403);
    }
  });

  it("will not let a role work the queue without the queue permission at all", async () => {
    const token = await userWith("Payout Approver", ["payment_out.approve"]);
    expect((await client.get("/approvals", { token })).status).toBe(403);
  });

  it("gates the unmasked account number on its own permission", async () => {
    const masked = await userWith("Account Reader", ["bank_accounts.view"]);
    const full = await userWith("Full Number Reader", [
      "bank_accounts.view",
      "bank_accounts.viewFull",
    ]);

    const a = await client.get<{ data: Array<{ accountNumberMasked: boolean }> }>(
      "/bank-accounts",
      { token: masked },
    );
    const b = await client.get<{ data: Array<{ accountNumberMasked: boolean }> }>(
      "/bank-accounts",
      { token: full },
    );

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    if (a.body.data.length > 0) {
      expect(a.body.data[0]!.accountNumberMasked).toBe(true);
      expect(b.body.data[0]!.accountNumberMasked).toBe(false);
    }
  });
});

describe("granting a role", () => {
  /**
   * A role editor that lets you grant what you do not hold is an escalation ladder: create
   * a role with everything, assign it to yourself, done. The check did not exist before.
   */
  it("refuses to grant a permission the actor does not hold themselves", async () => {
    const token = await userWith("Limited Editor", [
      "roles.view", "roles.create", "payment_in.view",
    ]);

    const res = await client.post(
      "/roles",
      {
        name: "ESCALATED",
        label: "Escalated",
        permissions: ["payment_in.view", "settings.edit"],
      },
      { token },
    );

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/do not hold/i);
  });

  it("lets a super admin grant anything, including what they are not using", async () => {
    const token = await client.loginAs("super@test.co");

    const res = await client.post(
      "/roles",
      { name: "AUDITOR_ONLY", label: "Auditor", permissions: ["audit.view", "audit.export"] },
      { token },
    );

    expect(res.status).toBe(201);
  });

  /**
   * Saving a role written under the old vocabulary must WORK, and must clean it up. A
   * validator that rejected the stored strings would fail on the first Save with no way
   * to fix it from the screen.
   */
  it("rewrites a legacy grant into the current vocabulary when saved", async () => {
    const legacy = await Role.create({
      name: "LEGACY_ROLE",
      label: "Legacy",
      permissions: ["finance.ledger.view", "finance.payment.view"],
      isSystem: false,
    });

    const token = await client.loginAs("super@test.co");
    const res = await client.patch(
      `/roles/${String(legacy._id)}`,
      { label: "Legacy Renamed" },
      { token },
    );

    expect(res.status).toBe(200);

    const after = await Role.findById(legacy._id).lean();
    expect(after!.permissions).toEqual(
      expect.arrayContaining([
        "general_ledger.view", "party_ledger.view", "expense_ledger.view",
        "payment_in.view", "payment_out.view",
      ]),
    );
    // The old strings are gone, not kept alongside.
    expect(after!.permissions).not.toContain("finance.ledger.view");
  });

  it("still authorises a role whose document has not been migrated yet", async () => {
    const role = await Role.create({
      name: "UNMIGRATED",
      label: "Unmigrated",
      permissions: ["finance.party.view"],
      isSystem: false,
    });

    const user = new User({
      name: "Unmigrated",
      email: "unmigrated@test.co",
      roleId: role._id,
      status: "ACTIVE",
      passwordHash: "placeholder",
    });
    await user.setPassword(TEST_PASSWORD);
    user.mustChangePassword = false;
    await user.save();

    const token = await client.loginAs("unmigrated@test.co");
    // `finance.party.view` translates on the way in, so the desk keeps working before the
    // migration is ever run.
    expect((await client.get("/parties", { token })).status).toBe(200);
  });
});
