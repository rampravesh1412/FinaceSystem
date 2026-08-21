import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = { get: vi.fn(), list: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() };
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api };
});

const BRANCH_ID = "6501aa000000000000000003";
const ACCOUNT_ID = "6501aa000000000000000006";

vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({ user: { id: "6501aa000000000000000001", activeBranchId: BRANCH_ID }, can: () => true }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const { ExecuteSettlementButton } = await import("./settlement-actions");

/** ₹77,000 agreed, ₹40,000 paid — ₹37,000 outstanding. */
const PARTIAL = {
  id: "6501aa00000000000000000a",
  settlementNo: "SET-2026-000001",
  date: "2026-08-22T00:00:00.000Z",
  kind: "PARTY",
  party: { id: "6501aa000000000000000005", name: "Sharma Traders" },
  sourceLabel: "—",
  destinationLabel: "Sharma Traders",
  amount: 7700000,
  charges: 0,
  netAmount: 7700000,
  settledAmount: 4000000,
  status: "PARTIAL",
  approvedBy: null,
  createdBy: "Test",
};

/**
 * Executing a settlement (§24).
 *
 * A settlement's whole point is that the agreed amount and what has actually been paid are
 * different numbers. The arithmetic that matters is `netAmount − settledAmount`, and it is
 * what decides whether the action is offered at all.
 */
describe("settlement execution", () => {
  beforeEach(() => {
    api.list.mockImplementation((path: string) => {
      const items = String(path).startsWith("/bank-accounts")
        ? [{ id: ACCOUNT_ID, accountName: "HDFC Current", accountNumber: "••7890",
             bank: { id: "b", name: "HDFC Bank", shortName: "HDFC" },
             branch: { id: BRANCH_ID, name: "Head Office", code: "101" },
             balance: 20000000, availableBalance: 20000000, overdraftLimit: 0 }]
        : [];
      return Promise.resolve({ items, meta: { page: 1, limit: 25, total: items.length, totalPages: 1, hasNext: false, hasPrev: false } });
    });
    api.post.mockResolvedValue({ ...PARTIAL, settledAmount: 7700000, status: "COMPLETED" });
  });

  it("shows what is outstanding, not just the agreed amount", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExecuteSettlementButton settlement={PARTIAL as never} />);

    await user.click(screen.getByRole("button", { name: /^pay/i }));
    await screen.findByRole("dialog");

    // 77,000 agreed − 40,000 paid = 37,000 outstanding. A screen showing only the agreed
    // figure would invite paying it twice. It appears in the description and prefills the
    // amount, so assert on both rather than on a unique match.
    expect(screen.getAllByText(/37,000/).length).toBeGreaterThan(0);
    expect(screen.getByText(/77,000/)).toBeInTheDocument();
    expect(screen.getByText(/40,000/)).toBeInTheDocument();
  });

  it("defaults the payment to the outstanding amount", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExecuteSettlementButton settlement={PARTIAL as never} />);

    await user.click(screen.getByRole("button", { name: /^pay/i }));
    await screen.findByRole("dialog");

    expect((screen.getByLabelText(/^amount/i) as HTMLInputElement).value).toBe("37000");
  });

  it("warns before an overpayment the server would refuse", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExecuteSettlementButton settlement={PARTIAL as never} />);

    await user.click(screen.getByRole("button", { name: /^pay/i }));
    await screen.findByRole("dialog");

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "99000");

    expect(await screen.findByText(/cannot be overpaid/i)).toBeInTheDocument();
  });

  it("permits a part payment — the normal case, not an edge case", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExecuteSettlementButton settlement={PARTIAL as never} />);

    await user.click(screen.getByRole("button", { name: /^pay/i }));
    await screen.findByRole("dialog");

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "10000");

    await user.click(screen.getByRole("combobox", { name: /paid from/i }));
    await user.click(await screen.findByRole("option", { name: /hdfc/i }));
    await user.click(screen.getByRole("button", { name: /^pay/i, hidden: false }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0]![0]).toContain("/execute");
  });

  it("offers nothing once a settlement is complete", () => {
    renderWithProviders(
      <ExecuteSettlementButton
        settlement={{ ...PARTIAL, settledAmount: 7700000, status: "COMPLETED" } as never}
      />,
    );
    expect(screen.queryByRole("button", { name: /^pay/i })).not.toBeInTheDocument();
  });
});
