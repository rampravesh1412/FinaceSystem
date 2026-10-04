import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BankAccountSummary, OpeningBalanceState } from "@amiri/shared";

const api = { get: vi.fn(), list: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() };
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api };
});

const session = vi.hoisted(() => ({ isSuperAdmin: true }));
vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({
    user: { id: "6501aa000000000000000001", isSuperAdmin: session.isSuperAdmin },
    can: () => true,
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const { BankAccountRowActions } = await import("./banking-edit");

const ACCOUNT: BankAccountSummary = {
  id: "6501aa000000000000000006",
  bank: { id: "6501aa00000000000000000b", name: "Federal Bank", shortName: "FEDERAL" },
  accountName: "ELITE FEDERAL",
  accountNumber: "8178748465",
  accountNumberMasked: false,
  ifsc: "FDRL0001917",
  accountType: "CURRENT",
  balance: 0,
  availableBalance: 0,
  overdraftLimit: 0,
  lowBalanceThreshold: 0,
  isLowBalance: false,
  status: "ACTIVE",
  ledgerAccountId: "6501aa000000000000000016",
  createdAt: "2026-10-01T00:00:00.000Z",
};

function openingState(over: Partial<OpeningBalanceState> = {}): OpeningBalanceState {
  return { amount: 0, date: null, txnNo: null, editable: true, otherEntryCount: 0, ...over };
}

async function openMenu(account: BankAccountSummary = ACCOUNT) {
  const user = userEvent.setup();
  renderWithProviders(<BankAccountRowActions account={account} />);
  await user.click(screen.getByRole("button", { name: /actions for/i }));
  return user;
}

/**
 * Edit and delete on a bank account row.
 *
 * The opening balance is editable only while the server says so, and goes through its own
 * route — a money change, unlike the labels PATCH carries. Delete belongs to a super admin
 * and is refused, in the dialog as on the server, while the account holds money.
 */
describe("bank account row actions", () => {
  beforeEach(() => {
    session.isSuperAdmin = true;
    api.get.mockResolvedValue(openingState());
    api.patch.mockResolvedValue({});
    api.put.mockResolvedValue(openingState());
    api.del.mockResolvedValue({ id: ACCOUNT.id });
  });

  it("corrects the opening balance through its own route, in paise", async () => {
    api.get.mockResolvedValue(
      openingState({ amount: 5_000_00, date: "2026-10-01T00:00:00.000Z", txnNo: "OPB-2026-000001" }),
    );
    const user = await openMenu({ ...ACCOUNT, balance: 5_000_00 });
    await user.click(await screen.findByRole("menuitem", { name: /edit details/i }));

    const field = await screen.findByLabelText(/^opening balance/i);
    await waitFor(() => expect(field).toHaveValue("5000.00"));
    await user.clear(field);
    await user.type(field, "7,500");
    expect(screen.getByText(/₹5,000\.00 → ₹7,500\.00/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put).toHaveBeenCalledWith(`/bank-accounts/${ACCOUNT.id}/opening-balance`, {
      openingBalance: 7_500_00,
    });
    // The labels still go through PATCH, without the opening riding along.
    expect(api.patch.mock.calls[0]![1]).not.toHaveProperty("openingBalance");
  });

  it("leaves the opening alone when it was not touched", async () => {
    api.get.mockResolvedValue(
      openingState({ amount: 5_000_00, date: "2026-10-01T00:00:00.000Z", txnNo: "OPB-2026-000001" }),
    );
    const user = await openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /edit details/i }));
    await waitFor(() => expect(screen.getByLabelText(/^opening balance/i)).toHaveValue("5000.00"));

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.put).not.toHaveBeenCalled();
  });

  it("shows the opening locked once anything else is posted", async () => {
    api.get.mockResolvedValue(openingState({ amount: 64_964_00, editable: false, otherEntryCount: 3 }));
    const user = await openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /edit details/i }));

    expect(await screen.findByText(/is locked/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^opening balance/i)).not.toBeInTheDocument();
  });

  it("lets a super admin soft-delete an empty account", async () => {
    const user = await openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/nothing is erased/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(api.del).toHaveBeenCalledWith(`/bank-accounts/${ACCOUNT.id}`));
  });

  it("offers no delete for an account that still holds money", async () => {
    const user = await openMenu({ ...ACCOUNT, balance: 64_964_00 });
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/₹64,964\.00/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it("does not offer delete to anyone but a super admin", async () => {
    session.isSuperAdmin = false;
    await openMenu();

    expect(await screen.findByRole("menuitem", { name: /edit details/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).not.toBeInTheDocument();
  });
});
