import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
const PARTY_ID = "6501aa000000000000000005";
const ACCOUNT_ID = "6501aa000000000000000006";
const HEAD_ID = "6501aa000000000000000007";
const OTHER_ACCOUNT_ID = "6501aa000000000000000009";

vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({
    user: {
      id: "6501aa000000000000000001",
      activeBranchId: BRANCH_ID,
      branches: [{ id: BRANCH_ID, name: "Head Office", code: "101" }],
      isSuperAdmin: true,
    },
    can: () => true,
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const { NewTransactionButton } = await import("./transaction-form");

/**
 * The transaction form — the single screen through which money moves (§14–§17).
 *
 * Five modes post to five endpoints against five different schemas, and the mode decides
 * which fields exist. That makes it the most load-bearing form in the application and the
 * one where a wrong endpoint or a missing field is most expensive: the operator believes
 * they recorded a receipt, and nothing was recorded at all.
 *
 * The INCOME mode in particular shipped in phase 11 with no test, having not existed at
 * all before then.
 */
describe("transaction form", () => {
  beforeEach(() => {
    api.list.mockImplementation((path: string) => {
      const items = String(path).startsWith("/parties")
        ? [{
            id: PARTY_ID, name: "Sharma Traders", code: "PTY-001",
            balance: 5000000, direction: "LENA",
          }]
        : String(path).startsWith("/bank-accounts")
          ? [{
              id: ACCOUNT_ID, accountName: "HDFC Current", accountNumber: "••7890",
              bank: { id: "b", name: "HDFC Bank", shortName: "HDFC" },
              balance: 20000000, availableBalance: 20000000, overdraftLimit: 0,
            }, {
              // A second account. Accounts are organisation-wide, so it is selectable
              // from any posting branch.
              id: OTHER_ACCOUNT_ID, accountName: "ICICI Current", accountNumber: "••1234",
              bank: { id: "b2", name: "ICICI Bank", shortName: "ICICI" },
              balance: 5000000, availableBalance: 5000000, overdraftLimit: 0,
            }]
          : [];
      return Promise.resolve({
        items,
        meta: { page: 1, limit: 25, total: items.length, totalPages: 1, hasNext: false, hasPrev: false },
      });
    });

    api.get.mockImplementation((path: string) => {
      if (String(path).startsWith("/expenses/categories")) {
        return Promise.resolve([{ id: HEAD_ID, name: "Salaries", code: "EXP-001" }]);
      }
      if (String(path).startsWith("/income/heads")) {
        return Promise.resolve([{ id: HEAD_ID, name: "Commission", code: "INC-001" }]);
      }
      if (String(path).startsWith("/charges")) return Promise.resolve([]);
      if (String(path).startsWith("/cash-accounts")) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    api.post.mockResolvedValue({ txnNo: "TEST-000001" });
  });

  async function openForm(mode: string, label: string) {
    const user = userEvent.setup();
    renderWithProviders(<NewTransactionButton mode={mode as never} label={label} />);
    await user.click(screen.getByRole("button", { name: new RegExp(label, "i") }));
    await screen.findByRole("dialog");
    return user;
  }

  it("posts a Payment In to /payment-in", async () => {
    const user = await openForm("PAYMENT_IN", "Payment In");

    await user.type(screen.getByLabelText(/^amount/i), "5000");
    await user.click(screen.getByRole("combobox", { name: /^party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));
    await user.click(screen.getByRole("combobox", { name: /received into/i }));
    await user.click(await screen.findByRole("option", { name: /hdfc/i }));

    await user.click(screen.getByRole("button", { name: /record receipt/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0]![0]).toBe("/payment-in");
  });

  /**
   * The posting branch is a field on the form, so a super admin working from the
   * all-branches view can record an entry without leaving the dialog to switch context.
   */
  it("carries the chosen branch through to the payload", async () => {
    const user = await openForm("PAYMENT_IN", "Payment In");

    expect(screen.getByRole("combobox", { name: /^branch/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^amount/i), "5000");
    await user.click(screen.getByRole("combobox", { name: /^party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));
    await user.click(screen.getByRole("combobox", { name: /received into/i }));
    await user.click(await screen.findByRole("option", { name: /hdfc/i }));

    await user.click(screen.getByRole("button", { name: /record receipt/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0]![1]).toHaveProperty("branchId", BRANCH_ID);
  });

  /**
   * Accounts are organisation-wide, so every one of them is selectable whichever branch is
   * posting. This assertion used to be its opposite; the branch has not disappeared, it has
   * moved onto the POSTING, where both legs still carry it so each branch's books balance.
   */
  it("offers every account, whichever branch is posting", async () => {
    const user = await openForm("PAYMENT_IN", "Payment In");

    await user.click(screen.getByRole("combobox", { name: /received into/i }));

    expect(await screen.findByRole("option", { name: /hdfc/i })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /icici/i })).toBeInTheDocument();
  });

  it("posts Income to /income with an income head, not an expense head", async () => {
    const user = await openForm("INCOME", "Record Income");

    await user.type(screen.getByLabelText(/^amount/i), "45000");
    await user.click(screen.getByRole("combobox", { name: /income head/i }));
    await user.click(await screen.findByRole("option", { name: /commission/i }));
    await user.click(screen.getByRole("combobox", { name: /received into/i }));
    await user.click(await screen.findByRole("option", { name: /hdfc/i }));

    await user.click(screen.getByRole("button", { name: /record income/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = api.post.mock.calls[0]!;

    expect(path).toBe("/income");
    // §17: income carries a `headId`, not the expense form's `categoryId`. Sending the
    // wrong one would be refused, and sending it to /payment-in would silently credit a
    // party who is owed nothing.
    expect(payload).toHaveProperty("headId", HEAD_ID);
    expect(payload).not.toHaveProperty("categoryId");
  });

  it("asks for a second look before posting a high-value transaction (§65)", async () => {
    const user = await openForm("PAYMENT_OUT", "Record payment");

    // Above ₹1,00,000 the form must confirm rather than post on the first click.
    await user.type(screen.getByLabelText(/^amount/i), "500000");
    await user.click(screen.getByRole("combobox", { name: /^party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));
    await user.click(screen.getByRole("combobox", { name: /paid from/i }));
    await user.click(await screen.findByRole("option", { name: /hdfc/i }));

    await user.click(screen.getByRole("button", { name: /record payment/i }));

    // Nothing posted yet — the first click only opens the confirmation.
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByText(/5,00,000/)).toBeInTheDocument();
  });

  it("posts a small amount without a confirmation step", async () => {
    const user = await openForm("PAYMENT_IN", "Payment In");

    await user.type(screen.getByLabelText(/^amount/i), "500");
    await user.click(screen.getByRole("combobox", { name: /^party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));
    await user.click(screen.getByRole("combobox", { name: /received into/i }));
    await user.click(await screen.findByRole("option", { name: /hdfc/i }));

    await user.click(screen.getByRole("button", { name: /record receipt/i }));

    // A confirmation on every ₹500 receipt would be trained away within a day, and then
    // the ₹5,00,000 one would be clicked through too.
    await waitFor(() => expect(api.post).toHaveBeenCalled());
  });

  it("converts the amount to integer paise before it leaves the browser", async () => {
    const user = await openForm("PAYMENT_IN", "Payment In");

    await user.type(screen.getByLabelText(/^amount/i), "1,25,101.00");
    await user.click(screen.getByRole("combobox", { name: /^party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));
    await user.click(screen.getByRole("combobox", { name: /received into/i }));
    await user.click(await screen.findByRole("option", { name: /hdfc/i }));

    await user.click(screen.getByRole("button", { name: /record receipt/i }));
    // High value, so step through the confirmation.
    const confirm = await screen.findByRole("button", { name: /post|confirm/i });
    await user.click(confirm);

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = api.post.mock.calls[0]!;
    const sent = (payload as { amount: unknown }).amount;

    /**
     * The shared `money` schema transforms on parse, so what leaves the browser is already
     * integer paise — 12510100, not the string "1,25,101.00" and not 125101.
     *
     * Worth pinning down explicitly: the conversion happens in ONE place, the schema both
     * sides share. A float here, or a string the server has to re-parse with its own
     * implementation of Indian digit grouping, is how paise go missing.
     */
    expect(sent).toBe(12510100);
    expect(Number.isInteger(sent)).toBe(true);
  });

  it("refuses to post with no amount", async () => {
    const user = await openForm("PAYMENT_IN", "Payment In");

    await user.click(screen.getByRole("combobox", { name: /^party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));
    await user.click(screen.getByRole("button", { name: /record receipt/i }));

    await waitFor(() => expect(screen.queryAllByRole("alert").length).toBeGreaterThan(0));
    expect(api.post).not.toHaveBeenCalled();
  });
});
