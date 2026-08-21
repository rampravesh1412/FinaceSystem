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
const { SavingsTransactionButtons } = await import("./savings-actions");

const MEMBER = {
  id: "6501aa000000000000000008",
  accountNo: "SB-101-00001",
  memberName: "Kavita Devi",
  branch: { id: BRANCH_ID, name: "Head Office", code: "101" },
  balance: 550000, // ₹5,500
  interestRateBps: 650,
  ledgerAccountId: "6501aa000000000000000009",
  status: "ACTIVE",
  lastTransactionAt: null,
  openedAt: "2026-04-01T00:00:00.000Z",
};

/**
 * Savings deposits and withdrawals (§13).
 *
 * Savings is a LIABILITY: the balance is money the business owes the member. The guard that
 * matters is that it cannot be overdrawn — paying out more than is held would mean paying
 * money the business is not holding for them, and the server refuses. The form must refuse
 * first, because the alternative is an operator counting cash onto the counter and then
 * discovering the transaction will not post.
 */
describe("savings transactions", () => {
  beforeEach(() => {
    api.list.mockImplementation((path: string) => {
      const items = String(path).startsWith("/cash-accounts")
        ? [{ id: ACCOUNT_ID, name: "Main Counter", branch: MEMBER.branch, balance: 10000000, isDefault: true,
            ledgerAccountId: "x", status: "ACTIVE", createdAt: "" }]
        : [];
      return Promise.resolve({ items, meta: { page: 1, limit: 25, total: items.length, totalPages: 1, hasNext: false, hasPrev: false } });
    });
    api.post.mockResolvedValue({ txnNo: "SAV-000001" });
  });

  it("refuses a withdrawal larger than the balance, before any cash is counted", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavingsTransactionButtons account={MEMBER as never} />);

    await user.click(screen.getByRole("button", { name: /withdraw/i }));
    await screen.findByRole("dialog");

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "9999");

    expect(await screen.findByText(/cannot be overdrawn/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record withdrawal/i })).toBeDisabled();
  });

  it("allows a withdrawal up to the balance", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavingsTransactionButtons account={MEMBER as never} />);

    await user.click(screen.getByRole("button", { name: /withdraw/i }));
    await screen.findByRole("dialog");

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "5500");

    // Exactly the balance is legitimate — it empties the account, it does not overdraw it.
    expect(screen.queryByText(/cannot be overdrawn/i)).not.toBeInTheDocument();
  });

  it("hides withdrawal entirely for an empty account", () => {
    renderWithProviders(<SavingsTransactionButtons account={{ ...MEMBER, balance: 0 } as never} />);
    expect(screen.getByRole("button", { name: /withdraw/i })).toBeDisabled();
  });

  it("states the liability direction rather than a bare balance", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavingsTransactionButtons account={MEMBER as never} />);

    await user.click(screen.getByRole("button", { name: /deposit/i }));
    await screen.findByRole("dialog");

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "2000");

    // "an increase in what it owes" — not "balance goes up", which reads as an asset.
    expect(await screen.findByText(/what it owes/i)).toBeInTheDocument();
  });

  it("sends the operation the button promised", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SavingsTransactionButtons account={MEMBER as never} />);

    await user.click(screen.getByRole("button", { name: /deposit/i }));
    await screen.findByRole("dialog");

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "2000");

    await user.click(screen.getByRole("combobox", { name: /cash received into/i }));
    await user.click(await screen.findByRole("option", { name: /main counter/i }));
    await user.click(screen.getByRole("button", { name: /record deposit/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = api.post.mock.calls[0]!;
    expect(path).toBe("/savings/transactions");
    expect((payload as { operation: string }).operation).toBe("DEPOSIT");
  });
});
