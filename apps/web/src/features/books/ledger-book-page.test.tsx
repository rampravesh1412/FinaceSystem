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


vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({
    user: { id: "6501aa000000000000000001", isSuperAdmin: true },
    can: () => true,
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const books = await import("./ledger-book-page");

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
