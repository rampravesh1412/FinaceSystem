import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { AuditLog, Role, Session, User } from "../../models/index.js";
import { TEST_PASSWORD, TestClient, clearFixtures, seedFixtures, type Fixtures } from "../../test/helpers.js";
import { ensureSystemAccounts } from "../../services/ledger.service.js";

/**
 * Phase 1 acceptance: authentication and RBAC.
 *
 * These are the tests §59 lists as mandatory for the identity layer. The permission cases
 * matter most — they assert that the SERVER refuses what a role does not grant, which is the
 * guarantee §3 says can never be delegated to frontend filtering.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;

beforeAll(async () => {
  await clearFixtures();
  fx = await seedFixtures();
  // A party's opening balance posts against equity, so the system accounts must exist.
  await ensureSystemAccounts();
  app = createApp();
  client = new TestClient();
  await client.start(app);
});

afterAll(async () => {
  await client.stop();
});

describe("authentication", () => {
  it("signs in with valid credentials and returns a session, but never a token in the body", async () => {
    const res = await client.post<{
      success: boolean;
      data: { accessToken: string; user: { email: string; permissions: string[] } };
    }>("/auth/login", { email: "acct@test.co", password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.email).toBe("acct@test.co");
    // The session carries the CURRENT vocabulary, whatever the role document says on
    // disk — a role still holding `finance.payment.create` resolves to both payment
    // modules, so a desk mid-migration is never locked out of a screen it could use.
    expect(res.body.data.user.permissions).toContain("payment_in.create");
    expect(res.body.data.user.permissions).toContain("payment_out.create");
    expect(res.body.data.user.permissions).not.toContain("finance.payment.create");

    // The refresh token is cookie-only. If it ever appears in the JSON body, any XSS on
    // the client can steal a week-long credential.
    expect(JSON.stringify(res.body)).not.toContain("refreshToken");
    const setCookie = res.headers.getSetCookie().join(";");
    expect(setCookie).toContain("amiri_rt=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("never leaks a password hash", async () => {
    const token = await client.loginAs("acct@test.co");
    const res = await client.get<{ data: Record<string, unknown> }>("/auth/me", { token });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain("$argon2");
  });

  it("gives the same error for a wrong password and an unknown account", async () => {
    const wrongPassword = await client.post<{ error: { code: string; message: string } }>(
      "/auth/login",
      { email: "acct@test.co", password: "Definitely@Wrong1" },
    );
    const noSuchUser = await client.post<{ error: { code: string; message: string } }>(
      "/auth/login",
      { email: "ghost@test.co", password: "Definitely@Wrong1" },
    );

    // Identical status, code and message: the login form must not be an account-
    // enumeration oracle.
    expect(wrongPassword.status).toBe(noSuchUser.status);
    expect(wrongPassword.body.error.code).toBe(noSuchUser.body.error.code);
    expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
  });

  it("rejects a request with no token", async () => {
    const res = await client.get<{ error: { code: string } }>("/parties", { token: null });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a tampered token", async () => {
    const token = await client.loginAs("acct@test.co");
    const tampered = token.slice(0, -4) + "AAAA";
    const res = await client.get<{ error: { code: string } }>("/parties", { token: tampered });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_INVALID");
  });

  it("locks an account after repeated failures and audits every attempt", async () => {
    const email = "lockme@test.co";
    const user = new User({
      name: "Lock Me",
      email,
      roleId: fx.roles.ACCOUNTANT!,
      status: "ACTIVE",
      passwordHash: "placeholder",
    });
    await user.setPassword(TEST_PASSWORD);
    await user.save();

    let lastStatus = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await client.post<{ error: { code: string } }>("/auth/login", {
        email,
        password: "Wrong@Password1",
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(423); // locked

    // Even the correct password is refused while the lock holds.
    const correct = await client.post<{ error: { code: string } }>("/auth/login", {
      email,
      password: TEST_PASSWORD,
    });
    expect(correct.status).toBe(423);
    expect(correct.body.error.code).toBe("ACCOUNT_LOCKED");

    const failures = await AuditLog.countDocuments({ userEmail: email, success: false });
    expect(failures).toBeGreaterThanOrEqual(5);
  });

  it("rotates the refresh token and revokes the whole family if an old one is replayed", async () => {
    const fresh = new TestClient();
    await fresh.start(app);

    await fresh.post("/auth/login", { email: "viewer@test.co", password: TEST_PASSWORD });
    const originalCookie = [...fresh.cookies];

    const first = await fresh.post("/auth/refresh");
    expect(first.status).toBe(200);
    // A new token was issued, so the cookie must have changed.
    expect(fresh.cookies).not.toEqual(originalCookie);

    // Replay the consumed token: this is what a stolen-token attack looks like.
    fresh.cookies = originalCookie;
    const replay = await fresh.post<{ error: { code: string } }>("/auth/refresh");
    expect(replay.status).toBe(401);

    // Reuse detection must kill the entire chain, including the token the legitimate
    // client currently holds — better one extra sign-in than a live intruder.
    const live = await Session.countDocuments({
      userId: fx.users.viewer!.id,
      revokedAt: null,
    });
    expect(live).toBe(0);

    await fresh.stop();
  });

  /**
   * Several devices at once.
   *
   * A counter clerk signs in on the till and again on a phone; neither sign-in may end the
   * other. This is the case that would break silently if login ever started revoking the
   * user's existing sessions — the second person to sign in wins and the first loses
   * whatever they were half way through entering.
   */
  it("lets one user hold several sessions at once, each usable", async () => {
    const first = new TestClient();
    const second = new TestClient();
    await first.start(app);
    await second.start(app);

    const a = await first.post<{ data: { accessToken: string } }>("/auth/login", {
      email: "acct@test.co",
      password: TEST_PASSWORD,
    });
    const b = await second.post<{ data: { accessToken: string } }>("/auth/login", {
      email: "acct@test.co",
      password: TEST_PASSWORD,
    });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Two independent sessions, not one reissued.
    expect(a.body.data.accessToken).not.toBe(b.body.data.accessToken);

    // BOTH still work — the newer login did not evict the older one.
    expect((await first.get("/auth/me", { token: a.body.data.accessToken })).status).toBe(200);
    expect((await second.get("/auth/me", { token: b.body.data.accessToken })).status).toBe(200);

    const live = await Session.countDocuments({ userId: fx.users.accountant!.id, revokedAt: null });
    expect(live).toBeGreaterThanOrEqual(2);

    await first.stop();
    await second.stop();
  });

  /** A session lasts six hours, not the seven days it used to. */
  it("expires a session six hours after it was issued", async () => {
    const client2 = new TestClient();
    await client2.start(app);
    const before = Date.now();

    const res = await client2.post<{ data: { accessToken: string } }>("/auth/login", {
      email: "viewer@test.co",
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);

    const session = await Session.findOne({ userId: fx.users.viewer!.id, revokedAt: null })
      .sort({ createdAt: -1 })
      .lean();
    expect(session).toBeTruthy();

    const lifetimeHours = (session!.expiresAt.getTime() - before) / 3_600_000;
    expect(lifetimeHours).toBeGreaterThan(5.9);
    expect(lifetimeHours).toBeLessThanOrEqual(6.1);

    await client2.stop();
  });

  it("signs the user out of every device when they change their password", async () => {
    const changer = new TestClient();
    await changer.start(app);
    const login = await changer.post<{ data: { accessToken: string } }>("/auth/login", {
      email: "badmin@test.co",
      password: TEST_PASSWORD,
    });
    const token = login.body.data.accessToken;

    const res = await changer.post(
      "/auth/change-password",
      { currentPassword: TEST_PASSWORD, newPassword: "Rotated@Pass99", confirmPassword: "Rotated@Pass99" },
      { token },
    );
    expect(res.status).toBe(200);

    const live = await Session.countDocuments({ userId: fx.users.branchAdmin!.id, revokedAt: null });
    expect(live).toBe(0);

    // The old access token is now backed by a revoked session and must stop working.
    const after = await changer.get("/auth/me", { token });
    expect(after.status).toBe(401);

    // Restore for later suites.
    const back = await changer.post<{ data: { accessToken: string } }>("/auth/login", {
      email: "badmin@test.co",
      password: "Rotated@Pass99",
    });
    await changer.post(
      "/auth/change-password",
      { currentPassword: "Rotated@Pass99", newPassword: TEST_PASSWORD, confirmPassword: TEST_PASSWORD },
      { token: back.body.data.accessToken },
    );
    await changer.stop();
  });
});

describe("permission engine", () => {
  it("allows an action the role grants", async () => {
    const token = await client.loginAs("badmin@test.co");
    const res = await client.get("/users", { token });
    expect(res.status).toBe(200);
  });

  it("refuses an action the role does not grant, with the required permission named", async () => {
    // An accountant deliberately has no `users.view` — §4 says they must not inherit
    // administrative capability just because they handle money.
    const token = await client.loginAs("acct@test.co");
    const res = await client.get<{ error: { code: string; details: { required: string } } }>(
      "/users",
      { token },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PERMISSION_DENIED");
    expect(res.body.error.details.required).toBe("users.view");
  });

  it("refuses a read-only role any write", async () => {
    const token = await client.loginAs("viewer@test.co");
    const res = await client.post("/parties", { name: "Nope Traders", openingBalance: 0 }, { token });
    expect(res.status).toBe(403);
  });

  it("stops a lesser admin from minting a super admin", async () => {
    const token = await client.loginAs("badmin@test.co");

    // Creating a super-admin role — the direct escalation path.
    const role = await client.post<{ error: { code: string } }>(
      "/roles",
      { name: "SNEAKY_ADMIN", label: "Sneaky", permissions: [], isSuperAdmin: true },
      { token },
    );
    expect(role.status).toBe(403);

    // Assigning the existing SuperAdmin role to a new user — the indirect path.
    const user = await client.post<{ error: { message: string } }>(
      "/users",
      {
        name: "Puppet",
        email: "puppet@test.co",
        password: "Puppet@Pass01",
        roleId: fx.roles.SUPER_ADMIN,
      },
      { token },
    );
    expect(user.status).toBe(403);
  });

  it("refuses to reduce the super admin role's own permissions", async () => {
    const token = await client.loginAs("super@test.co");
    const res = await client.patch<{ error: { code: string } }>(
      `/roles/${fx.roles.SUPER_ADMIN}`,
      { permissions: ["reports.view"] },
      { token },
    );
    // Otherwise the system can be locked out of its own administration.
    expect(res.status).toBe(409);
  });
});

/**
 * A role with no assignment of its own.
 *
 * What this proves: reach and capability are separate grants. A read-everything role
 * does not thereby get to write anything.
 */
describe("permission reach", () => {
  let globalToken: string;

  beforeAll(async () => {
    const readOnly = await Role.create({
      name: "GLOBAL_AUDITOR",
      label: "Global Auditor",
      permissions: ["finance.party.view", "reports.view"],
      isSuperAdmin: false,
      isSystem: false,
    });

    const user = new User({
      name: "Global Auditor",
      email: "gaudit@test.co",
      roleId: readOnly._id,
      status: "ACTIVE",
      passwordHash: "placeholder",
    });
    await user.setPassword(TEST_PASSWORD);
    user.mustChangePassword = false;
    await user.save();

    globalToken = await client.loginAs("gaudit@test.co");
  });

  it("reads what its permissions grant", async () => {
    const res = await client.get("/parties", { token: globalToken });
    expect(res.status).toBe(200);
  });

  it("is still refused an action its permissions do not grant", async () => {
    const res = await client.post<{ error: { code: string } }>(
      "/parties",
      { name: "Should Not Exist", openingBalance: 0 },
      { token: globalToken },
    );

    // Being able to SEE the party master does not imply the right to add to it.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("input handling", () => {
  it("neutralises a NoSQL operator injection at login", async () => {
    const res = await client.post<{ error: { code: string } }>("/auth/login", {
      email: { $gt: "" },
      password: { $gt: "" },
    });
    // Must not authenticate as "the first user in the collection".
    expect([401, 422]).toContain(res.status);
    expect(res.body.error.code).not.toBe(undefined);
  });

  it("returns field-level detail on a validation failure", async () => {
    const token = await client.loginAs("super@test.co");
    const res = await client.post<{
      error: { code: string; field: string; details: Array<{ field: string; message: string }> };
    }>("/parties", { name: "X", pincode: "12" }, { token });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it("requires a substantive reason for a dangerous action", async () => {
    const token = await client.loginAs("super@test.co");
    const res = await client.post<{ error: { code: string } }>(
      "/adjustments",
      { date: "2026-08-19", adjustmentType: "BALANCE_CORRECTION", amount: 100, reason: "no" },
      { token },
    );
    expect(res.status).toBe(422);
  });

  it("echoes a request id on every error so a user can quote it", async () => {
    const res = await client.get<{ error: { requestId: string } }>("/parties", { token: null });
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.headers.get("x-request-id")).toBe(res.body.error.requestId);
  });
});

describe("audit trail", () => {
  it("records a party creation with the actor and the resulting values", async () => {
    const token = await client.loginAs("super@test.co");
    const res = await client.post<{ data: { id: string } }>(
      "/parties",
      { name: "Audit Test Party", openingBalance: "50,000.00" },
      { token },
    );
    expect(res.status).toBe(201);

    const entry = await AuditLog.findOne({ entity: "Party", entityId: res.body.data.id }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.action).toBe("CREATE");
    expect(entry!.userEmail).toBe("super@test.co");
    expect(entry!.roleName).toBe("SUPER_ADMIN");

    // The opening balance was submitted as a formatted string and must have been parsed
    // to integer paise, not stored as text or a float.
    const recorded = entry!.newValue as { openingBalance: number };
    expect(recorded.openingBalance).toBe(5_000_000);
  });

  it("refuses to update an audit record", async () => {
    const entry = await AuditLog.findOne().lean();
    expect(entry).toBeTruthy();
    await expect(
      AuditLog.updateOne({ _id: entry!._id }, { $set: { action: "LOGIN" } }),
    ).rejects.toThrow(/append-only/i);
  });

  it("refuses to delete an audit record", async () => {
    const entry = await AuditLog.findOne().lean();
    await expect(AuditLog.deleteOne({ _id: entry!._id })).rejects.toThrow(/append-only/i);
  });
});

/**
 * The user lifecycle (§5, §40).
 *
 * Every one of these endpoints existed and none was reachable from the UI until phase 10.
 * The shape assertion is here because the create route once returned the raw Mongoose
 * document: `_id` instead of `id`, no populated role. A client that created a
 * user and then tried to edit them had no id to address, and every follow-up call 422'd
 * on the id parameter.
 */
describe("user lifecycle", () => {
  let token: string;
  let userId: string;
  const email = "lifecycle@test.co";
  const firstPassword = "Lifecycle@2026";

  beforeAll(async () => {
    token = await client.loginAs("super@test.co");
  });

  it("creates a user in the list's shape, not the raw document", async () => {
    const res = await client.post<{
      data: {
        id: string;
        role: { label: string } | null;
        _id?: string;
      };
    }>(
      "/users",
      {
        name: "Lifecycle Probe",
        email,
        password: firstPassword,
        roleId: fx.roles.ACCOUNTANT,
      },
      { token },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data._id).toBeUndefined();
    expect(res.body.data.role?.label).toBeTruthy();

    userId = res.body.data.id;
  });

  it("edits the user and answers in the same shape", async () => {
    const res = await client.patch<{ data: { id: string; designation?: string } }>(
      `/users/${userId}`,
      { designation: "Senior Accountant" },
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(userId);
    expect(res.body.data.designation).toBe("Senior Accountant");
  });

  it("resets the password, invalidating the old one", async () => {
    const newPassword = "Reset@Pass2026";

    const res = await client.post(
      `/users/${userId}/reset-password`,
      { newPassword, mustChange: true },
      { token },
    );
    expect(res.status).toBe(200);

    const withOld = await client.post<{ error: unknown }>("/auth/login", {
      email,
      password: firstPassword,
    });
    expect(withOld.status).toBe(401);

    const withNew = await client.post<{ data: { user: { mustChangePassword: boolean } } }>(
      "/auth/login",
      { email, password: newPassword },
    );
    expect(withNew.status).toBe(200);
    expect(withNew.body.data.user.mustChangePassword).toBe(true);
  });

  it("revokes access, and the account is disabled rather than deleted", async () => {
    const res = await client.post<{ data: { status: string } }>(
      `/users/${userId}/status`,
      { status: "BLOCKED", reason: "Left the company on 22 August" },
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("BLOCKED");

    // 403 rather than 401: the credentials are correct, the account is not permitted.
    // Answering 401 would tell a disabled user their password was wrong and send them
    // round the reset loop instead of to an administrator.
    const signIn = await client.post<{ error: { code: string } }>("/auth/login", {
      email,
      password: "Reset@Pass2026",
    });
    expect(signIn.status).toBe(403);
    expect(signIn.body.error.code).toBe("ACCOUNT_DISABLED");

    // §28: still on the record. Deleting the account would orphan everything they posted.
    const listed = await client.get<{ data: Array<{ id: string; status: string }> }>(
      "/users?limit=100",
      { token },
    );
    const found = listed.body.data.find((u) => u.id === userId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("BLOCKED");
  });

  it("restores access", async () => {
    const res = await client.post<{ data: { status: string } }>(
      `/users/${userId}/status`,
      { status: "ACTIVE", reason: "Rejoined after a period of leave" },
      { token },
    );
    expect(res.status).toBe(200);

    const signIn = await client.post("/auth/login", { email, password: "Reset@Pass2026" });
    expect(signIn.status).toBe(200);
  });
});
