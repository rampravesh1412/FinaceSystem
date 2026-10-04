import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { Permission } from "@amiri/shared";

const api = {
  get: vi.fn(),
  list: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api };
});

const session = vi.hoisted(() => ({ permissions: [] as string[] }));

/**
 * The real permission check against a realistic grant.
 *
 * A session carries catalogue keys only — `expandLegacy` drops the retired
 * `finance.expense.manageCategories` at sign-in — so a screen still asking for the old
 * string hides its controls from everybody, Super Admin included. A mock that answered
 * `true` to every question could never have caught that.
 */
vi.mock("@/features/auth/auth-context", async () => {
  const { hasPermission } = await vi.importActual<typeof import("@amiri/shared")>("@amiri/shared");
  const can = (p: Permission) => hasPermission(session.permissions, p);
  return {
    useAuth: () => ({ can }),
    Can: ({ permission, children }: { permission: Permission; children: React.ReactNode }) =>
      can(permission) ? children : null,
  };
});

const { renderWithProviders } = await import("@/test/harness");
const { HeadsPage } = await import("./heads-page");

describe("heads page", () => {
  beforeEach(() => {
    api.get.mockResolvedValue([]);
  });

  it("offers a new head to a session holding heads.create", async () => {
    session.permissions = ["heads.view", "heads.create", "heads.edit"];
    renderWithProviders(<HeadsPage />);

    expect(await screen.findByRole("button", { name: /new expense head/i })).toBeInTheDocument();
  });

  it("does not offer one to a session that may only view", async () => {
    session.permissions = ["heads.view"];
    renderWithProviders(<HeadsPage />);

    expect(await screen.findByText(/no expense heads yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new expense head/i })).not.toBeInTheDocument();
  });
});
