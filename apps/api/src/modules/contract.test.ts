import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app.js";
import { ensureSystemAccounts } from "../services/ledger.service.js";
import { TestClient, clearFixtures, seedFixtures, type Fixtures } from "../test/helpers.js";

/**
 * The create-response contract.
 *
 * Six times across four phases, a create route was found returning the raw Mongoose
 * document while its list route returned a mapped summary — parties, bank accounts, users,
 * cash drawers, savings accounts, charge rules. The shape is always the same and the
 * consequence always the same kind: the field that exists only on the summary is invariably
 * the one the caller wanted back.
 *
 *   POST /parties        → no `balance`, so a party opened with ₹1,25,101 answered `undefined`
 *   POST /users          → `_id` not `id`, so every follow-up call went to /users/undefined
 *   POST /bank-accounts  → the UNMASKED account number, regardless of permission
 *   POST /savings        → no `balance`, rendering as ₹NaN
 *   POST /charges        → no `sampleOn100k`, likewise
 *
 * Each was fixed individually and covered by an individual test, which is not the same as
 * covering the pattern. This walks every create route that has a list counterpart and
 * asserts the invariant directly, so the seventh occurrence fails here rather than in
 * somebody's browser.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;
let token: string;

beforeAll(async () => {
  await clearFixtures();
  fx = await seedFixtures();
  await ensureSystemAccounts();
  app = createApp();
  client = new TestClient();
  await client.start(app);
  token = await client.loginAs("super@test.co");
});

afterAll(async () => {
  await client.stop();
  await clearFixtures();
});

/**
 * Fields a document has and a summary must not: Mongo internals leaking through.
 *
 * `_id` is the giveaway — a summary always exposes `id`. `__v` and `passwordHash` are the
 * other two that a raw document carries and no client should ever see.
 */
const LEAKED = ["_id", "__v", "passwordHash"];

interface Case {
  name: string;
  create: () => Promise<{ status: number; body: { data: Record<string, unknown> } }>;
  /** Fields the list produces that the create response must also carry. */
  require: string[];
}

describe("every create route answers in its list's shape", () => {
  const cases: Case[] = [];

  beforeAll(async () => {

    const bank = await client.post<{ data: { id: string } }>(
      "/banks",
      { name: "Contract Test Bank", shortName: "CTB", ifscPrefix: "CTBK" },
      { token },
    );
    const bankId = bank.body.data.id;

    cases.push(
      {
        name: "POST /parties",
        // No "branch": the party master is organisation-wide.
        require: ["id", "name", "balance", "direction", "ledgerAccountId"],
        create: () =>
          client.post(
            "/parties",
            {
              name: "Contract Test Party",
              type: "CUSTOMER",
              openingBalance: "1,25,101",
              openingDate: "2026-04-01",
            },
            { token },
          ) as never,
      },
      {
        name: "POST /bank-accounts",
        require: ["id", "accountName", "balance", "availableBalance", "bank", "accountNumberMasked"],
        create: () =>
          client.post(
            "/bank-accounts",
            {
              bankId,
              accountName: "Contract Test Current",
              accountNumber: "50100000000001",
              ifsc: "CTBK0001234",
              openingBalance: "1,00,000",
            },
            { token },
          ) as never,
      },
      {
        name: "POST /cash-accounts",
        require: ["id", "name", "balance", "isDefault", "ledgerAccountId"],
        create: () =>
          client.post(
            "/cash-accounts",
            { name: "Contract Test Drawer", openingBalance: "10,000" },
            { token },
          ) as never,
      },
      {
        name: "POST /users",
        require: ["id", "name", "email", "role", "status"],
        create: () =>
          client.post(
            "/users",
            {
              name: "Contract Test User",
              email: "contract@test.co",
              password: "Contract@2026",
              roleId: fx.roles.ACCOUNTANT,
            },
            { token },
          ) as never,
      },
      {
        name: "POST /savings",
        require: ["id", "accountNo", "memberName", "balance", "ledgerAccountId"],
        create: () =>
          client.post(
            "/savings",
            { memberName: "Contract Test Member", openingBalance: "5,000" },
            { token },
          ) as never,
      },
      {
        name: "POST /charges",
        require: ["id", "name", "code", "type", "bearer", "sampleOn100k"],
        create: () =>
          client.post(
            "/charges",
            {
              name: "Contract Test Charge",
              code: "CONTRACT_TEST",
              type: "PERCENTAGE",
              rateBps: 175,
              bearer: "PARTY",
            },
            { token },
          ) as never,
      },
    );
  });

  it("returns every field its list counterpart exposes", async () => {
    const failures: string[] = [];

    for (const testCase of cases) {
      const res = await testCase.create();

      if (res.status !== 201) {
        failures.push(`${testCase.name}: expected 201, got ${res.status}`);
        continue;
      }

      const missing = testCase.require.filter((field) => res.body.data[field] === undefined);
      if (missing.length > 0) {
        failures.push(`${testCase.name}: missing ${missing.join(", ")}`);
      }
    }

    // Reported together rather than failing on the first, so one run tells you every
    // route that regressed instead of the alphabetically earliest.
    expect(failures).toEqual([]);
  });

  it("never leaks raw document internals", async () => {
    const failures: string[] = [];

    for (const testCase of cases) {
      const res = await testCase.create();
      if (res.status !== 201) continue;

      const leaked = LEAKED.filter((field) => field in res.body.data);
      if (leaked.length > 0) failures.push(`${testCase.name}: exposes ${leaked.join(", ")}`);
    }

    expect(failures).toEqual([]);
  });

  it("returns amounts as integer paise, never a float or a string", async () => {
    const failures: string[] = [];
    const moneyFields = ["balance", "availableBalance", "sampleOn100k", "overdraftLimit"];

    for (const testCase of cases) {
      const res = await testCase.create();
      if (res.status !== 201) continue;

      for (const field of moneyFields) {
        const value = res.body.data[field];
        if (value === undefined) continue;

        if (typeof value !== "number" || !Number.isInteger(value)) {
          // §39. A float here means the amount went through arithmetic it should not have,
          // and a string means the client has to parse money — both are how paise get lost.
          failures.push(`${testCase.name}.${field} = ${JSON.stringify(value)} (${typeof value})`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
