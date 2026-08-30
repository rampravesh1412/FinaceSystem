import type { Express } from "express";
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES } from "@amiri/shared";
import { Branch, Role, User } from "../models/index.js";

/**
 * Test fixtures.
 *
 * Users are created through the real model methods (`setPassword` → argon2), not by
 * inserting a hash, so the login path under test is the same one production runs.
 */

export interface Fixtures {
  roles: Record<string, string>;
  branches: Record<string, string>;
  users: Record<string, { id: string; email: string; password: string }>;
}

export const TEST_PASSWORD = "TestPass@2026";

export async function seedFixtures(): Promise<Fixtures> {
  const roles: Record<string, string> = {};
  for (const [name, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const role = await Role.create({
      name,
      label: name,
      permissions,
      isUnscoped: name === SYSTEM_ROLES.SUPER_ADMIN,
      isSystem: true,
    });
    roles[name] = String(role._id);
  }

  const branches: Record<string, string> = {};
  for (const code of ["101", "105", "107"]) {
    const branch = await Branch.create({ code, name: `Branch ${code}`, status: "ACTIVE" });
    branches[code] = String(branch._id);
  }

  const users: Fixtures["users"] = {};

  const make = async (key: string, email: string, roleName: string, branchIds: string[]) => {
    const user = new User({
      name: key,
      email,
      roleId: roles[roleName]!,
      branchIds,
      defaultBranchId: branchIds[0] ?? null,
      status: "ACTIVE",
      passwordHash: "placeholder",
    });
    await user.setPassword(TEST_PASSWORD);
    user.mustChangePassword = false;
    await user.save();
    users[key] = { id: String(user._id), email, password: TEST_PASSWORD };
  };

  await make("superAdmin", "super@test.co", "SUPER_ADMIN", [branches["101"]!]);
  // Assigned to 105 only. Branch 107 exists but must be invisible to them everywhere.
  await make("branchAdmin", "badmin@test.co", "BRANCH_ADMIN", [branches["105"]!]);
  await make("accountant", "acct@test.co", "ACCOUNTANT", [branches["105"]!]);
  // Holds two branches, so "all branches" is a real choice for them — and 107 must still
  // be invisible when they make it.
  await make("multiBranch", "multi@test.co", "ACCOUNTANT", [branches["101"]!, branches["105"]!]);
  await make("viewer", "viewer@test.co", "VIEWER", [branches["105"]!]);

  return { roles, branches, users };
}

export async function clearFixtures(): Promise<void> {
  const mongoose = (await import("mongoose")).default;
  const { Session } = await import("../models/index.js");

  await Promise.all([User.deleteMany({}), Role.deleteMany({}), Branch.deleteMany({}), Session.deleteMany({})]);

  /**
   * Audit logs are cleared through the raw driver, bypassing Mongoose middleware.
   *
   * `AuditLog.deleteMany()` throws by design — the model blocks every mutation to keep
   * the trail append-only, and that guard firing here is the guard working. Dropping the
   * underlying collection is the deliberate test-only escape hatch. Application code has
   * no equivalent path: it goes through the model, where the block applies.
   */
  await mongoose.connection.collection("auditlogs").deleteMany({});
}

/* ── A tiny supertest-free HTTP client ───────────────────────────────────── */

export interface TestResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * Drives the app over a real ephemeral HTTP listener rather than injecting into the
 * router. That keeps cookies, CORS, helmet and the JSON parser in the path, so the tests
 * exercise the middleware stack a browser would actually hit.
 */
export class TestClient {
  baseUrl = "";
  private server?: ReturnType<Express["listen"]>;
  accessToken?: string;
  cookies: string[] = [];

  async start(app: Express): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, () => {
        const addr = this.server!.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; token?: string | null; cookies?: boolean } = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { "content-type": "application/json" };

    const token = options.token === null ? undefined : (options.token ?? this.accessToken);
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.cookies !== false && this.cookies.length > 0) {
      headers.cookie = this.cookies.join("; ");
    }

    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) {
      this.cookies = setCookie.map((c) => c.split(";")[0]!);
    }

    const text = await res.text();
    return {
      status: res.status,
      body: (text ? JSON.parse(text) : null) as T,
      headers: res.headers,
    };
  }

  get = <T = unknown>(p: string, o?: { token?: string | null }) => this.request<T>("GET", p, o);
  post = <T = unknown>(p: string, body?: unknown, o?: { token?: string | null }) =>
    this.request<T>("POST", p, { ...o, body });
  patch = <T = unknown>(p: string, body?: unknown, o?: { token?: string | null }) =>
    this.request<T>("PATCH", p, { ...o, body });
  del = <T = unknown>(p: string, o?: { token?: string | null }) => this.request<T>("DELETE", p, o);

  /** Sign in and return the access token, without disturbing the client's own session. */
  async loginAs(email: string, password = TEST_PASSWORD): Promise<string> {
    const res = await this.post<{ success: boolean; data: { accessToken: string } }>(
      "/auth/login",
      { email, password },
    );
    if (res.status !== 200) {
      throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data.accessToken;
  }
}
