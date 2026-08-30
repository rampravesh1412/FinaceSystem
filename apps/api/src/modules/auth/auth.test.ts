import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { AuditLog, Session, User } from "../../models/index.js";
import { TEST_PASSWORD, TestClient, clearFixtures, seedFixtures, type Fixtures } from "../../test/helpers.js";

/**
 * Phase 1 acceptance: authentication, RBAC and branch isolation.
 *
 * These are the tests §59 lists as mandatory for the identity layer. The branch-isolation
 * cases matter most — they assert that the SERVER refuses cross-branch data, which is the
 * guarantee §3 says can never be delegated to frontend filtering.
 */

let app: Express;
let client: TestClient;
let fx: Fixtures;

beforeAll(async () => {
  await clearFixtures();
  fx = await seedFixtures();
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
    expect(res.body.data.user.permissions).toContain("finance.payment.create");

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
    const res = await client.get<{ error: { code: string } }>("/branches", { token: null });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a tampered token", async () => {
    const token = await client.loginAs("acct@test.co");
    const tampered = token.slice(0, -4) + "AAAA";
    const res = await client.get<{ error: { code: string } }>("/branches", { token: tampered });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_INVALID");
  });

  it("locks an account after repeated failures and audits every attempt", async () => {
    const email = "lockme@test.co";
    const user = new User({
      name: "Lock Me",
      email,
      roleId: fx.roles.ACCOUNTANT!,
      branchIds: [fx.branches["105"]!],
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
    const res = await client.post("/branches", { name: "Nope", code: "999" }, { token });
    expect(res.status).toBe(403);
  });

  it("stops a branch admin from minting a super admin", async () => {
    const token = await client.loginAs("badmin@test.co");

    // Creating an unscoped role — the direct escalation path.
    const role = await client.post<{ error: { code: string } }>(
      "/roles",
      { name: "SNEAKY_ADMIN", label: "Sneaky", permissions: [], isUnscoped: true },
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
        branchIds: [fx.branches["105"]],
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

describe("branch isolation", () => {
  it("shows a super admin every branch", async () => {
    const token = await client.loginAs("super@test.co");
    const res = await client.get<{ data: unknown[]; meta: { total: number } }>("/branches", {
      token,
    });
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
  });

  it("shows a scoped user only their assigned branches", async () => {
    const token = await client.loginAs("acct@test.co");
    const res = await client.get<{ data: Array<{ code: string }>; meta: { total: number } }>(
      "/branches",
      { token },
    );
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data.map((b) => b.code)).toEqual(["105"]);
    // Branch 107 exists in the database and is simply not reachable for this user.
    expect(res.body.data.map((b) => b.code)).not.toContain("107");
  });

  it("refuses a direct fetch of another branch by id", async () => {
    const token = await client.loginAs("acct@test.co");
    const res = await client.get<{ error: { code: string } }>(`/branches/${fx.branches["107"]}`, {
      token,
    });
    // Knowing the id is not authorisation. This is the case a frontend-only filter misses.
    expect(res.status).toBe(404);
  });

  it("refuses a query parameter naming an out-of-scope branch", async () => {
    const token = await client.loginAs("acct@test.co");
    const res = await client.get<{ error: { code: string } }>(
      `/branches?branchId=${fx.branches["107"]}`,
      { token },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BRANCH_ACCESS_DENIED");
  });

  it("switches to all branches without widening what the user may read", async () => {
    const token = await client.loginAs("multi@test.co");

    const res = await client.post<{ data: { activeBranchId: string | null; branchIds: string[] } }>(
      "/auth/switch-branch",
      { branchId: null },
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.activeBranchId).toBeNull();
    // "All branches" is *their* branches. 107 is not among them and never becomes one.
    expect(res.body.data.branchIds).toHaveLength(2);
    expect(res.body.data.branchIds).not.toContain(fx.branches["107"]);
  });

  it("refuses switching into a branch the user does not hold", async () => {
    const token = await client.loginAs("acct@test.co");
    const res = await client.post<{ error: { code: string } }>(
      "/auth/switch-branch",
      { branchId: fx.branches["107"] },
      { token },
    );
    expect(res.status).toBe(403);
  });

  it("stops a branch admin assigning a user to a branch they do not hold", async () => {
    const token = await client.loginAs("badmin@test.co");
    const res = await client.post<{ error: { code: string } }>(
      "/users",
      {
        name: "Cross Branch",
        email: "cross@test.co",
        password: "Cross@Pass01",
        roleId: fx.roles.ACCOUNTANT,
        branchIds: [fx.branches["107"]],
      },
      { token },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BRANCH_ACCESS_DENIED");
  });

  it("keeps the user directory scoped to shared branches", async () => {
    const token = await client.loginAs("badmin@test.co");
    const res = await client.get<{ data: Array<{ email: string }> }>("/users", { token });
    expect(res.status).toBe(200);
    // The super admin sits in branch 101 and must not appear in a 105 admin's directory.
    expect(res.body.data.map((u) => u.email)).not.toContain("super@test.co");
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
    }>("/branches", { name: "X", code: "!!" }, { token });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it("requires a substantive reason for a dangerous action", async () => {
    const token = await client.loginAs("super@test.co");
    const res = await client.post<{ error: { code: string } }>(
      `/branches/${fx.branches["107"]}/status`,
      { status: "INACTIVE", reason: "no" },
      { token },
    );
    expect(res.status).toBe(422);
  });

  it("echoes a request id on every error so a user can quote it", async () => {
    const res = await client.get<{ error: { requestId: string } }>("/branches", { token: null });
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.headers.get("x-request-id")).toBe(res.body.error.requestId);
  });
});

describe("audit trail", () => {
  it("records a branch creation with the actor and the resulting values", async () => {
    const token = await client.loginAs("super@test.co");
    const res = await client.post<{ data: { id: string; code: string } }>(
      "/branches",
      { name: "Audit Test Branch", code: "AUD1", openingCash: "50,000.00" },
      { token },
    );
    expect(res.status).toBe(201);

    const entry = await AuditLog.findOne({ entity: "Branch", entityId: res.body.data.id }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.action).toBe("CREATE");
    expect(entry!.userEmail).toBe("super@test.co");
    expect(entry!.roleName).toBe("SUPER_ADMIN");

    // The opening balance was submitted as a formatted string and must have been parsed
    // to integer paise, not stored as text or a float.
    const recorded = entry!.newValue as { requestedOpeningCash: number };
    expect(recorded.requestedOpeningCash).toBe(5_000_000);
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
 * document: `_id` instead of `id`, no populated role or branches. A client that created a
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
        branches: Array<{ code: string }>;
        _id?: string;
      };
    }>(
      "/users",
      {
        name: "Lifecycle Probe",
        email,
        password: firstPassword,
        roleId: fx.roles.ACCOUNTANT,
        branchIds: [fx.branches["105"]],
      },
      { token },
    );

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data._id).toBeUndefined();
    expect(res.body.data.role?.label).toBeTruthy();
    expect(res.body.data.branches.map((b) => b.code)).toContain("105");

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
