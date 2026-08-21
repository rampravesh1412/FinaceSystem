import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import type { OrganisationSettings } from "@amiri/shared";
import { createApp } from "../../app.js";
import { AuditLog, SystemSetting } from "../../models/index.js";
import { ensureSystemAccounts } from "../../services/ledger.service.js";
import { TestClient, clearFixtures, seedFixtures, type Fixtures } from "../../test/helpers.js";

/**
 * Phase 8 acceptance: organisation settings.
 *
 * The case that carries the weight is the fiscal-year lock. `fiscalStartMonth` decides
 * which year every transaction belongs to — its voucher number, the period that closes
 * over it, the year-to-date column it lands in — so changing it after anything is posted
 * would reassign history. The tests check that it is editable on an empty ledger and
 * refused, with a reason, the moment an entry exists.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;
let token: string;

async function raw(path: string, tok: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${(client as unknown as { baseUrl: string }).baseUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${tok}` },
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  await clearFixtures();
  await SystemSetting.deleteMany({});
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
  await SystemSetting.deleteMany({});
});

describe("organisation settings (§35)", () => {
  it("returns a usable default before anything has been configured", async () => {
    const res = await client.get<{ data: OrganisationSettings }>("/settings/organisation", { token });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.legalName).toBeTruthy();
    // April, the Indian default — not zero or undefined, which would break fiscal maths.
    expect(res.body.data.profile.fiscalStartMonth).toBe(4);
    expect(res.body.data.updatedAt).toBeNull();
  });

  it("saves the profile and records who changed it", async () => {
    const res = await client.request<{ data: OrganisationSettings }>("PUT", "/settings/organisation", {
      token,
      body: {
        legalName: "AMIRI Enterprises Private Limited",
        displayName: "AMIRI",
        city: "Patna",
        pincode: "800001",
        gstin: "10AABCU9603R1ZM",
        pan: "AABCU9603R",
        fiscalStartMonth: 4,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.legalName).toBe("AMIRI Enterprises Private Limited");
    expect(res.body.data.updatedAt).not.toBeNull();
    expect(res.body.data.updatedBy).toBeTruthy();
  });

  it("rejects a malformed GSTIN rather than storing it", async () => {
    const res = await client.request<{ error: { field?: string } }>("PUT", "/settings/organisation", {
      token,
      body: { legalName: "AMIRI", gstin: "NOT-A-GSTIN", fiscalStartMonth: 4 },
    });

    expect(res.status).toBe(422);

    // And the good value is still there — a refused write changes nothing.
    const after = await client.get<{ data: OrganisationSettings }>("/settings/organisation", { token });
    expect(after.body.data.profile.gstin).toBe("10AABCU9603R1ZM");
  });

  it("drops cleared optional fields instead of storing empty strings", async () => {
    await client.request("PUT", "/settings/organisation", {
      token,
      body: { legalName: "AMIRI Enterprises Private Limited", gstin: "", pan: "", fiscalStartMonth: 4 },
    });

    const res = await client.get<{ data: OrganisationSettings }>("/settings/organisation", { token });
    // "" would make "has a GSTIN" true for an organisation that has none, and the exports
    // print whatever is stored.
    expect(res.body.data.profile.gstin).toBeUndefined();
    expect(res.body.data.profile.pan).toBeUndefined();
  });

  it("audits the change with the before and after values", async () => {
    const entry = await AuditLog.findOne({ action: "SETTINGS_UPDATED", entity: "SystemSetting" })
      .sort({ createdAt: -1 })
      .lean();

    expect(entry).toBeTruthy();
    expect(entry!.entityLabel).toBe("Organisation profile");
    expect(entry!.oldValue).toBeTruthy();
    expect(entry!.newValue).toBeTruthy();
  });

  it("refuses the write to a user without settings.manage", async () => {
    const accountant = await client.loginAs("acct@test.co");
    const res = await client.request("PUT", "/settings/organisation", {
      token: accountant,
      body: { legalName: "Renamed By An Accountant", fiscalStartMonth: 4 },
    });

    expect(res.status).toBe(403);

    const after = await client.get<{ data: OrganisationSettings }>("/settings/organisation", { token });
    expect(after.body.data.profile.legalName).toBe("AMIRI Enterprises Private Limited");
  });
});

describe("the fiscal year lock", () => {
  it("allows the fiscal year to be set while the ledger is empty", async () => {
    const before = await client.get<{ data: OrganisationSettings }>("/settings/organisation", { token });
    expect(before.body.data.fiscalStartMonthEditable).toBe(true);

    const res = await client.request<{ data: OrganisationSettings }>("PUT", "/settings/organisation", {
      token,
      body: { legalName: "AMIRI Enterprises Private Limited", fiscalStartMonth: 1 },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.fiscalStartMonth).toBe(1);

    // Put it back before the ledger is touched.
    await client.request("PUT", "/settings/organisation", {
      token,
      body: { legalName: "AMIRI Enterprises Private Limited", fiscalStartMonth: 4 },
    });
  });

  it("locks it once a transaction has been posted, and says why", async () => {
    // Anything that posts a ledger entry. An opening balance is the smallest such thing.
    const branchId = fx.branches["105"]!;
    const cash = await client.post<{ data: { id: string } }>(
      "/cash-accounts",
      { branchId, name: "Settings Test Drawer", openingBalance: "1,000" },
      { token },
    );
    expect(cash.status).toBe(201);

    const settings = await client.get<{ data: OrganisationSettings }>("/settings/organisation", { token });
    expect(settings.body.data.fiscalStartMonthEditable).toBe(false);
    expect(settings.body.data.fiscalLockReason).toMatch(/voucher number|period/i);

    const res = await client.request<{ error: { message: string; field?: string } }>(
      "PUT",
      "/settings/organisation",
      { token, body: { legalName: "AMIRI Enterprises Private Limited", fiscalStartMonth: 7 } },
    );

    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe("fiscalStartMonth");
    expect(res.body.error.message).toMatch(/cannot be changed/i);

    // Refused, not partially applied.
    const after = await client.get<{ data: OrganisationSettings }>("/settings/organisation", { token });
    expect(after.body.data.profile.fiscalStartMonth).toBe(4);
  });

  it("still allows every other field to be edited while the year is locked", async () => {
    const res = await client.request<{ data: OrganisationSettings }>("PUT", "/settings/organisation", {
      token,
      body: {
        legalName: "AMIRI Enterprises Private Limited",
        city: "Gaya",
        // Unchanged, so it passes the guard.
        fiscalStartMonth: 4,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.city).toBe("Gaya");
  });
});

describe("the organisation name reaches the exports (§54)", () => {
  it("prints the configured name rather than the environment default", async () => {
    await client.request("PUT", "/settings/organisation", {
      token,
      body: { legalName: "AMIRI Enterprises Private Limited", displayName: "AMIRI Patna", fiscalStartMonth: 4 },
    });

    const res = await raw("/export/trial-balance?format=csv", token);
    expect(res.status).toBe(200);

    // The display name wins over the legal name, and both win over ORG_NAME. A file that
    // left the building saying something different from the settings screen would be a
    // discrepancy in the one field whose job is provenance.
    expect(res.text).toContain("AMIRI Patna");
  });
});

describe("system summary", () => {
  it("reports counts, and is readable by anyone with settings.view", async () => {
    const res = await client.get<{
      data: { users: number; activeUsers: number; ledgerEntries: number };
    }>("/settings/system", { token });

    expect(res.status).toBe(200);
    expect(res.body.data.users).toBeGreaterThan(0);
    expect(res.body.data.ledgerEntries).toBeGreaterThan(0);
  });

  it("is refused to a role without settings.view", async () => {
    const viewer = await client.loginAs("viewer@test.co");
    const res = await client.get("/settings/system", { token: viewer });
    expect(res.status).toBe(403);
  });
});
