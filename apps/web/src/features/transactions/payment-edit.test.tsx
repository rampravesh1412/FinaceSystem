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

const PARTY_ID = "6501aa000000000000000005";
const OTHER_PARTY_ID = "6501aa000000000000000008";
const ACCOUNT_ID = "6501aa000000000000000006";

const { renderWithProviders } = await import("@/test/harness");
const { EditPaymentDialog } = await import("./payment-edit");

type Detail = import("@amiri/shared").TransactionDetail;

const TXN: Detail = {
  id: "6501aa000000000000000010",
  txnNo: "PAY-IN-2026-000012",
  type: "PAYMENT_IN",
  typeLabel: "Payment In",
  date: "2026-08-19T00:00:00.000Z",
  party: { id: PARTY_ID, name: "Sharma Traders", code: "PTY-001" },
  accountLabel: "HDFC ••7890",
  paymentMode: "NEFT",
  referenceNo: "ORIG-REF",
  narration: "Payment received from Sharma Traders",
  grossAmount: 1_000_000,
  chargeAmount: 0,
  netAmount: 1_000_000,
  moneyIn: 1_000_000,
  moneyOut: 0,
  status: "COMPLETED",
  isReversal: false,
  reversedBy: null,
  reversalOf: null,
  supersededBy: null,
  supersedes: null,
  createdBy: { id: "u1", name: "Anita" },
  createdAt: "2026-08-19T05:00:00.000Z",
  entries: [],
  attachments: [],
  notes: [],
  timeline: [],
  supersededByTxn: null,
  supersedesTxn: null,
  approvedBy: null,
  postedAt: "2026-08-19T05:00:00.000Z",
};

/**
 * Editing a posted payment.
 *
 * The behaviour under test is the SPLIT: a label change must not reverse anything, and a
 * money change must say so before it happens. Getting that wrong in either direction is
 * the expensive kind of bug — either the ledger gets rewritten, or an operator fixing a
 * typo is startled by a new voucher number.
 */
describe("edit payment dialog", () => {
  beforeEach(() => {
    api.list.mockImplementation((path: string) =>
      Promise.resolve({
        items: String(path).startsWith("/parties")
          ? [
              { id: PARTY_ID, name: "Sharma Traders", code: "PTY-001", balance: 0, direction: "CLEAR" },
              { id: OTHER_PARTY_ID, name: "Verma Electronics", code: "PTY-002", balance: 0, direction: "CLEAR" },
            ]
          : String(path).startsWith("/bank-accounts")
            ? [{
                id: ACCOUNT_ID, accountName: "HDFC Current", accountNumber: "••7890",
                bank: { id: "b", name: "HDFC Bank", shortName: "HDFC" },
                balance: 0, availableBalance: 0, overdraftLimit: 0,
              }]
            : [],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
      }),
    );
    api.get.mockResolvedValue([]);
    api.patch.mockResolvedValue({
      outcome: "UPDATED",
      transaction: { id: TXN.id, txnNo: TXN.txnNo },
    });
  });

  function open() {
    const user = userEvent.setup();
    renderWithProviders(
      <EditPaymentDialog txn={TXN} open onOpenChange={() => {}} onDone={() => {}} />,
    );
    return user;
  }

  it("treats an untouched form as a label-only edit and says nothing will move", async () => {
    open();

    expect(await screen.findByText(/updated in place/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    // No reverse-and-repost warning while only labels could have changed.
    expect(screen.queryByText(/reverse .* and post a corrected replacement/i)).not.toBeInTheDocument();
  });

  it("warns before saving, as soon as the amount is touched", async () => {
    const user = open();

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "7500");

    // The consequence is stated BEFORE the click, not discovered after it.
    expect(await screen.findByText(/reverse PAY-IN-2026-000012/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reverse and repost/i })).toBeInTheDocument();
  });

  it("refuses to submit without a reason of at least ten characters", async () => {
    const user = open();

    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText(/why is this being changed/i), "typo");
    // Still short — the server would refuse it, so the button must too.
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText(/why is this being changed/i), " in the reference");
    expect(save).toBeEnabled();
  });

  it("sends only the fields that changed, so an untouched amount cannot trigger a repost", async () => {
    const user = open();

    await user.clear(screen.getByLabelText(/reference no/i));
    await user.type(screen.getByLabelText(/reference no/i), "FIXED-REF");
    await user.type(
      screen.getByLabelText(/why is this being changed/i),
      "Reference was mistyped at the counter",
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [path, payload] = api.patch.mock.calls[0]!;

    expect(path).toBe(`/payment-in/${TXN.id}`);
    expect(payload).toHaveProperty("referenceNo", "FIXED-REF");
    /**
     * The important absences. Sending `amount` unchanged would still count as a money
     * field on the server and reverse a transaction nobody asked to reverse.
     */
    expect(payload).not.toHaveProperty("amount");
    expect(payload).not.toHaveProperty("date");
    expect(payload).not.toHaveProperty("partyId");
    expect(payload).not.toHaveProperty("accountId");
  });

  it("sends the amount when it did change", async () => {
    const user = open();

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "7500");
    await user.type(
      screen.getByLabelText(/why is this being changed/i),
      "Recounted the cash — it was 7,500",
    );
    await user.click(screen.getByRole("button", { name: /reverse and repost/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [, payload] = api.patch.mock.calls[0]!;
    expect(payload).toHaveProperty("amount", "7500");
  });
});
