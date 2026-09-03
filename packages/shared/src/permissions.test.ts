import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  type ModuleDefinition,
  DEFAULT_ROLE_PERMISSIONS,
  LEGACY_PERMISSION_MAP,
  MODULE_CATALOG,
  expandLegacy,
  grantStringsFor,
  hasPermission,
  isPermission,
} from "./permissions.js";

/**
 * The permission catalogue (§5).
 *
 * The old catalogue failed quietly in two ways, and both are what these tests exist to
 * prevent recurring: keys that were grantable while nothing enforced them, and screens
 * that shared a key and so could not be granted apart. Neither showed up as an error —
 * one produced a checkbox that did nothing, the other a role nobody could express.
 */
describe("permission catalogue", () => {
  it("gives every module key and route to exactly one module", () => {
    const catalog: readonly ModuleDefinition[] = MODULE_CATALOG;
    const keys = catalog.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);

    // Two menu entries pointing at one route means one of them can never be reached.
    const routes = catalog.filter((m) => !m.hideInMenu).map((m) => m.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("declares no duplicate actions and at least one action per module", () => {
    for (const m of MODULE_CATALOG) {
      expect(m.actions.length, `${m.key} has no actions`).toBeGreaterThan(0);
      expect(new Set(m.actions).size, `${m.key} repeats an action`).toBe(m.actions.length);
    }
  });

  /**
   * The failure that started this: five ledger screens on `finance.ledger.view`, so
   * "General Ledger but not Expense Ledger" could not be said at all.
   */
  it("gives every sidebar entry its own view permission", () => {
    const menu = (MODULE_CATALOG as readonly ModuleDefinition[]).filter((m) => !m.hideInMenu);
    const views = menu.map((m) => `${m.key}.view`);

    expect(new Set(views).size).toBe(menu.length);
    for (const m of menu) {
      expect(m.actions, `${m.label} cannot be revealed`).toContain("view");
    }
  });

  it("recognises its own permissions and rejects pairs it never offers", () => {
    for (const p of ALL_PERMISSIONS) expect(isPermission(p)).toBe(true);

    // The module and the action both exist; the PAIR does not.
    expect(isPermission("dashboard.transact")).toBe(false);
    expect(isPermission("settings.resetPassword")).toBe(false);
    expect(isPermission("balance_sheet.approve")).toBe(false);
    expect(isPermission("nonsense.view")).toBe(false);
  });
});

describe("legacy vocabulary", () => {
  it("maps every old key onto permissions that exist", () => {
    for (const [old, targets] of Object.entries(LEGACY_PERMISSION_MAP)) {
      expect(targets.length, `${old} maps to nothing`).toBeGreaterThan(0);
      for (const t of targets) {
        expect(ALL_PERMISSIONS, `${old} -> ${t}`).toContain(t);
      }
    }
  });

  /**
   * The migration's whole promise. A role holding one key that now covers five screens
   * must come out holding all five — splitting a permission cannot take access away.
   */
  it("preserves what a split key could already reach", () => {
    const ledger = expandLegacy(["finance.ledger.view"]);
    expect(ledger).toEqual(
      expect.arrayContaining([
        "general_ledger.view", "party_ledger.view", "savings_ledger.view",
        "expense_ledger.view", "income_ledger.view",
      ]),
    );

    // Payment In and Payment Out were one key; both survive.
    expect(expandLegacy(["finance.payment.view"])).toEqual(
      expect.arrayContaining(["payment_in.view", "payment_out.view"]),
    );
  });

  /**
   * `approvals.act` approved everything, so it has to keep doing exactly that — the point
   * of splitting approve per module is to let a person NARROW it deliberately, not to
   * silently revoke it from whoever holds the old key.
   */
  it("keeps a blanket approver able to approve everything", () => {
    const granted = ["approvals.act"];
    for (const p of [
      "payment_in.approve", "payment_out.approve", "expenses.approve",
      "income.approve", "settlements.approve", "adjustments.approve",
    ] as const) {
      expect(hasPermission(granted, p), p).toBe(true);
    }
  });

  it("evaluates an old string without needing the database migrated first", () => {
    // A session minted before the rewrite still holds the old vocabulary.
    expect(hasPermission(["finance.party.creditLimit"], "credit.edit")).toBe(true);
    expect(hasPermission(["finance.bank.viewFull"], "bank_accounts.viewFull")).toBe(true);
    // And still refuses what it never granted.
    expect(hasPermission(["finance.party.view"], "parties.delete")).toBe(false);
  });

  it("drops a string that names nothing rather than carrying it forward", () => {
    expect(expandLegacy(["finance.payment.aprove", "parties.view"])).toEqual(["parties.view"]);
  });

  it("keeps wildcards intact, so a super admin is not frozen at today's catalogue", () => {
    expect(expandLegacy(["*"])).toEqual(["*"]);
    expect(hasPermission(["*"], "settings.edit")).toBe(true);
    expect(hasPermission(["payment_in.*"], "payment_in.approve")).toBe(true);
    expect(hasPermission(["payment_in.*"], "payment_out.approve")).toBe(false);
  });

  it("lists every stored string that would grant a permission, for a database query", () => {
    const strings = grantStringsFor("payment_out.approve");
    expect(strings).toEqual(
      expect.arrayContaining(["*", "payment_out.*", "payment_out.approve", "approvals.act"]),
    );
  });
});

describe("seeded role defaults", () => {
  it("grants only permissions that exist", () => {
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const p of perms) expect(ALL_PERMISSIONS, `${role} -> ${p}`).toContain(p);
    }
  });

  /**
   * Derived from the old defaults, not retyped — the first hand-written attempt handed
   * BRANCH_ADMIN three administrative permissions it never had, and nothing caught it
   * except a test that happened to exercise one of them.
   */
  it("does not widen a seeded role while renaming its permissions", () => {
    const branchAdmin = DEFAULT_ROLE_PERMISSIONS.BRANCH_ADMIN;

    // Held before, so held now.
    expect(branchAdmin).toContain("payment_out.approve");
    expect(branchAdmin).toContain("credit.edit");
    expect(branchAdmin).toContain("bank_accounts.viewFull");

    // Never held, so still not held.
    expect(branchAdmin).not.toContain("audit.export");
    expect(branchAdmin).not.toContain("users.resetPassword");
    expect(branchAdmin).not.toContain("periods.edit");
    expect(branchAdmin).not.toContain("roles.create");
  });

  it("keeps a viewer unable to change anything", () => {
    for (const p of DEFAULT_ROLE_PERMISSIONS.VIEWER) {
      expect(p.endsWith(".view") || p.endsWith(".export"), p).toBe(true);
    }
  });

  it("gives every role the Dashboard, which used to be ungated entirely", () => {
    for (const perms of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      expect(perms).toContain("dashboard.view");
    }
  });
});
