import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";

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

const BRANCH_ID = "6501aa000000000000000003";

vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({
    user: { id: "6501aa000000000000000001", activeBranchId: BRANCH_ID, isSuperAdmin: true },
    can: () => true,
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const books = await import("./ledger-book-page");
const { BranchLedgerPage } = await import("./branch-ledger-page");

/**
 * The ledger books (§4.1, §34).
 *
 * Every book is the same statement over a different account kind, so the thing worth
 * testing is not the rendering — the smoke suite covers that — but that each preset asks
 * for the right slice. A Cash Book that quietly queried every account would look perfectly
 * normal and be wrong.
 */
describe("ledger books", () => {
  beforeEach(() => {
    api.list.mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 25, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
    });
    api.get.mockResolvedValue({ rows: [], totalDebit: 0, totalCredit: 0, difference: 0 });
  });

  const presets: Array<{ name: keyof typeof books; kinds: string[] }> = [
    { name: "CashBookPage", kinds: ["CASH"] },
    { name: "BankBookPage", kinds: ["BANK"] },
    { name: "PartyLedgerPage", kinds: ["PARTY"] },
    { name: "IncomeLedgerPage", kinds: ["INCOME"] },
    { name: "SavingsLedgerPage", kinds: ["SAVINGS"] },
  ];

  for (const preset of presets) {
    it(`${preset.name} asks only for ${preset.kinds.join(", ")}`, async () => {
      const Component = books[preset.name] as React.ComponentType;
      renderWithProviders(<Component />);

      await waitFor(() => expect(api.list).toHaveBeenCalled());
      const paths = api.list.mock.calls.map(([p]) => String(p));

      for (const kind of preset.kinds) {
        expect(paths.some((p) => p.includes(`kind=${kind}`))).toBe(true);
      }
      // And nothing outside its remit.
      const requested = paths.flatMap((p) => [...p.matchAll(/kind=(\w+)/g)].map((m) => m[1]));
      expect(new Set(requested)).toEqual(new Set(preset.kinds));
    });
  }

  it("the expense ledger covers charges as well as expense heads", async () => {
    renderWithProviders(<books.ExpenseLedgerPage />);

    await waitFor(() => expect(api.list).toHaveBeenCalled());
    const paths = api.list.mock.calls.map(([p]) => String(p));

    // A commission is an expense the business bore; leaving it out of the expense ledger
    // would hide it from the one screen where somebody goes looking for costs.
    expect(paths.some((p) => p.includes("kind=EXPENSE"))).toBe(true);
    expect(paths.some((p) => p.includes("kind=CHARGE"))).toBe(true);
  });

  it("never asks for more than the server's page cap", async () => {
    renderWithProviders(<books.GeneralLedgerPage />);

    await waitFor(() => expect(api.list).toHaveBeenCalled());
    const limits = api.list.mock.calls
      .map(([p]) => Number(/limit=(\d+)/.exec(String(p))?.[1] ?? 0))
      .filter(Boolean);

    // MAX_PAGE_SIZE is 200; asking for more is refused with a 422, which would leave the
    // account picker permanently empty rather than merely truncated.
    expect(Math.max(...limits)).toBeLessThanOrEqual(200);
  });

  it("sends the search to the server rather than filtering a partial page", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    renderWithProviders(<books.GeneralLedgerPage />);

    await user.type(screen.getByLabelText(/search accounts/i), "sharma");

    // Filtering the first 200 rows in the browser would report "no matches" for an account
    // that exists on page two.
    await waitFor(() => {
      const paths = api.list.mock.calls.map(([p]) => String(p));
      expect(paths.some((p) => p.includes("q=sharma"))).toBe(true);
    });
  });

  it("the general ledger fetches the whole chart in ONE request, not one per kind", async () => {
    renderWithProviders(<books.GeneralLedgerPage />);

    await waitFor(() => expect(api.list).toHaveBeenCalled());
    const accountCalls = api.list.mock.calls
      .map(([p]) => String(p))
      .filter((p) => p.startsWith("/ledger/accounts"));

    expect(accountCalls).toHaveLength(1);
    // Unfiltered: the endpoint returns every kind when `kind` is omitted, so nine parallel
    // round trips would reassemble what one call already gives.
    expect(accountCalls[0]).not.toContain("kind=");
  });
});

/**
 * The Branch Ledger (§3).
 *
 * A branch is a grouping of accounts, not an account — so this is a trial balance scoped to
 * one branch, and the assertion that matters is that the branch actually reaches the query.
 * A screen that showed the organisation-wide figures under a branch's name would be worse
 * than no screen.
 */
describe("branch ledger", () => {
  beforeEach(() => {
    api.list.mockResolvedValue({
      items: [{ id: BRANCH_ID, name: "Head Office", code: "101" }],
      meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
    });
    api.get.mockResolvedValue({
      rows: [
        { ledgerAccountId: "a1", code: "1001", name: "Cash — Main", kind: "CASH", accountClass: "ASSET", debit: 4500000, credit: 0 },
        { ledgerAccountId: "a2", code: "3001", name: "Opening Equity", kind: "EQUITY", accountClass: "EQUITY", debit: 0, credit: 4500000 },
      ],
      totalDebit: 4500000,
      totalCredit: 4500000,
      difference: 0,
      asOf: "2026-08-22T00:00:00.000Z",
      branchId: BRANCH_ID,
    });
  });

  it("scopes the trial balance to the selected branch", async () => {
    renderWithProviders(<BranchLedgerPage />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const call = api.get.mock.calls.find(([p]) => String(p).includes("trial-balance"));

    expect(call).toBeDefined();
    expect(String(call![0])).toContain(BRANCH_ID);
  });

  it("reports that the branch ties on its own, not merely organisation-wide", async () => {
    renderWithProviders(<BranchLedgerPage />);

    // §3: every posting carries a branchId on both sides, so each branch balances
    // independently. A branch that did not would be masked on the org-wide report.
    expect(await screen.findByText(/ties on its own/i)).toBeInTheDocument();
  });

  it("surfaces a per-branch imbalance rather than hiding it", async () => {
    api.get.mockResolvedValue({
      rows: [{ ledgerAccountId: "a1", code: "1001", name: "Cash", kind: "CASH", accountClass: "ASSET", debit: 100, credit: 0 }],
      totalDebit: 100, totalCredit: 0, difference: 100, asOf: "", branchId: BRANCH_ID,
    });

    renderWithProviders(<BranchLedgerPage />);

    expect(await screen.findByText(/out of balance/i)).toBeInTheDocument();
    // The explanation matters as much as the number: this is the failure mode the
    // org-wide trial balance cannot see.
    expect(screen.getByText(/another branch carries the opposite error/i)).toBeInTheDocument();
  });

  it("lists every account kind present in the branch", async () => {
    renderWithProviders(<BranchLedgerPage />);

    expect(await screen.findByText("Cash — Main")).toBeInTheDocument();
    // Equity has no book of its own, which is exactly why it needs to appear here.
    expect(screen.getByText("Opening Equity")).toBeInTheDocument();
  });
});
