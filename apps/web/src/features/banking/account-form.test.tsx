import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = { get: vi.fn(), list: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() };
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api };
});

const BRANCH_ID = "6501aa000000000000000003";
const BANK_ID = "6501aa00000000000000000b";

vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({ user: { id: "6501aa000000000000000001", activeBranchId: BRANCH_ID }, can: () => true }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const { NewAccountButton } = await import("./account-form");

/**
 * Opening a bank account or a cash drawer (§7).
 *
 * The opening balance is posted against equity as a real transaction, so what this form
 * sends determines whether the trial balance ties. A bank account may legitimately open
 * NEGATIVE — an overdraft already drawn down — while a cash drawer may not, and the two
 * rules must not be confused.
 */
describe("account form", () => {
  beforeEach(() => {
    api.list.mockImplementation((path: string) => {
      const items = String(path).startsWith("/branches")
        ? [{ id: BRANCH_ID, name: "Head Office", code: "101", city: "Patna" }]
        : String(path).startsWith("/banks")
          ? [{ id: BANK_ID, name: "HDFC Bank", shortName: "HDFC", status: "ACTIVE", accountCount: 0, totalBalance: 0, createdAt: "" }]
          : [];
      return Promise.resolve({ items, meta: { page: 1, limit: 25, total: items.length, totalPages: 1, hasNext: false, hasPrev: false } });
    });
    api.post.mockResolvedValue({ id: "a1", accountName: "HDFC Current", balance: 0, name: "Drawer" });
  });

  async function openForm() {
    const user = userEvent.setup();
    renderWithProviders(<NewAccountButton />);
    await user.click(screen.getByRole("button", { name: /new account/i }));
    await screen.findByRole("dialog");
    return user;
  }

  it("accepts a negative opening balance for an overdrawn bank account", async () => {
    const user = await openForm();

    await user.type(screen.getByLabelText(/account name/i), "PNB Overdraft");
    await user.type(screen.getByLabelText(/account number/i), "0158002100099999");
    await user.type(screen.getByLabelText(/^ifsc/i), "PUNB0015800");

    await user.click(screen.getByRole("combobox", { name: /^bank/i }));
    await user.click(await screen.findByRole("option", { name: /hdfc/i }));

    const opening = screen.getByLabelText(/opening balance/i);
    await user.clear(opening);
    await user.type(opening, "-250000");

    await user.click(screen.getByRole("button", { name: /open account/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = api.post.mock.calls[0]!;
    expect(path).toBe("/bank-accounts");
    // An OD account that starts drawn down is a real thing; refusing it would force an
    // operator to invent a fake opening entry.
    expect((payload as { openingBalance: number }).openingBalance).toBeLessThan(0);
  });

  it("states the overdraft consequence before the account is opened", async () => {
    const user = await openForm();

    const limit = screen.getByLabelText(/overdraft limit/i);
    await user.clear(limit);
    await user.type(limit, "1000000");

    // The operator should know what the limit does — payments refused below −₹10,00,000 —
    // rather than discovering it the first time one is refused.
    expect(await screen.findByText(/will be refused/i)).toBeInTheDocument();
  });

  it("says a drawer with no overdraft cannot go below zero", async () => {
    const user = await openForm();

    const opening = screen.getByLabelText(/opening balance/i);
    await user.clear(opening);
    await user.type(opening, "100000");

    expect(await screen.findByText(/cannot be taken below zero/i)).toBeInTheDocument();
  });

  it("posts a cash drawer to its own endpoint, with the no-overdraft rule stated", async () => {
    const user = await openForm();

    await user.click(screen.getByRole("tab", { name: /cash drawer/i }));

    await user.type(screen.getByLabelText(/drawer name/i), "Counter 2");

    const opening = screen.getByLabelText(/opening cash/i);
    await user.clear(opening);
    await user.type(opening, "75000");

    // §7: cash cannot be overdrawn at all, unlike a bank account.
    expect(screen.getByText(/never go below zero/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open drawer/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0]![0]).toBe("/cash-accounts");
  });

  it("warns that identifying fields are permanent, before they are typed", async () => {
    await openForm();

    // §7: the account number and IFSC identify the real account that months of entries were
    // posted against. Saying so after the fact is useless.
    expect(screen.getByText(/cannot be changed later/i)).toBeInTheDocument();
  });
});
