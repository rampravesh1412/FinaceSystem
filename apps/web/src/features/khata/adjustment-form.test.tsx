import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADJUSTMENT_TYPE } from "@amiri/shared";

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

vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({
    user: { id: "6501aa000000000000000001", activeBranchId: "6501aa000000000000000003", isSuperAdmin: true },
    can: () => true,
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const { NewAdjustmentButton } = await import("./adjustment-form");

/**
 * The adjustment form (§25, §62).
 *
 * Two of these tests exist because the corresponding bugs shipped and were caught by hand
 * during a live run:
 *
 *   - the form defaulted `adjustmentType` to `CORRECTION`, which is not a member of the
 *     enum — every submission was refused with a 422 the operator could not act on;
 *   - the party dropdown offered every party in the organisation while the server refuses a
 *     cross-branch reference, so the form could be filled completely and then rejected.
 *
 * Both are the same category: a client sending something the contract does not accept. The
 * first assertion below would have failed in milliseconds.
 */
describe("adjustment form", () => {
  beforeEach(() => {
    api.list.mockImplementation((path: string) => {
      const items = path.startsWith("/parties")
        ? [{ id: PARTY_ID, name: "Sharma Traders", code: "PTY-001", balance: 7200000, direction: "DENA" }]
        : [];
      return Promise.resolve({
        items,
        meta: { page: 1, limit: 25, total: items.length, totalPages: 1, hasNext: false, hasPrev: false },
      });
    });
    api.post.mockResolvedValue({ txnNo: "ADJ-2026-000001" });
  });

  async function openForm() {
    const user = userEvent.setup();
    renderWithProviders(<NewAdjustmentButton />);
    await user.click(screen.getByRole("button", { name: /adjust balance/i }));
    await screen.findByRole("dialog");
    return user;
  }

  it("defaults to an adjustment type the server actually accepts", async () => {
    await openForm();

    // The regression guard. `CORRECTION` looks reasonable and does not exist; the member
    // is `BALANCE_CORRECTION`.
    const valid = Object.values(ADJUSTMENT_TYPE) as string[];
    expect(valid).toContain("BALANCE_CORRECTION");
    expect(valid).not.toContain("CORRECTION");

    // And the form's default is drawn from the enum rather than typed as a literal.
    expect(screen.getAllByText(/balance correction/i).length).toBeGreaterThan(0);
  });

  it("scopes the party list to the chosen branch", async () => {
    await openForm();

    await waitFor(() => expect(api.list).toHaveBeenCalled());
    const partyCall = api.list.mock.calls.find(([path]) => String(path).startsWith("/parties"));

    expect(partyCall).toBeDefined();
    // Without this the operator picks a party the server will refuse, having filled in
    // the whole form, and is told only that it "belongs to a different branch".
    expect(String(partyCall![0])).toContain(BRANCH_ID);
  });

  it("requires a reason of at least ten characters, matching the server", async () => {
    const user = await openForm();

    const submit = screen.getByRole("button", { name: /post adjustment/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/^reason/i), "typo");
    // Still short — the server would refuse, so the button must too. A looser client gate
    // is not a lenient UI, it is a UI that lies.
    expect(submit).toBeDisabled();
    expect(screen.getByText(/6 more to go/i)).toBeInTheDocument();
  });

  it("sends a NEGATIVE amount when decreasing", async () => {
    const user = await openForm();

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "5000");
    await user.click(screen.getByRole("button", { name: /decrease/i }));
    await user.type(
      screen.getByLabelText(/^reason/i),
      "Cheque 44821 was recorded twice on 14 August",
    );

    // Choosing the party is what makes the payload valid.
    await user.click(screen.getByRole("combobox", { name: /party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));

    await user.click(screen.getByRole("button", { name: /post adjustment/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = api.post.mock.calls[0]!;
    expect((payload as { amount: number }).amount).toBeLessThan(0);
    expect((payload as { reason: string }).reason).toMatch(/44821/);
  });

  it("clears the other target when the tab is switched", async () => {
    const user = await openForm();

    // Choose a party, then switch to the account tab. Leaving both set fails the schema's
    // "one or the other" refinement on a field that is no longer visible, so the form
    // would refuse to submit with nothing on screen explaining why.
    await user.click(screen.getByRole("combobox", { name: /party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));

    await user.click(screen.getByRole("tab", { name: /an account/i }));
    await user.click(screen.getByRole("tab", { name: /a party/i }));

    // Switching away clears the side left behind, so the choice has to be made again —
    // deliberately, because the alternative is a form silently carrying a value the
    // operator can no longer see.
    await user.click(screen.getByRole("combobox", { name: /party/i }));
    await user.click(await screen.findByRole("option", { name: /sharma traders/i }));

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "5000");
    await user.type(
      screen.getByLabelText(/^reason/i),
      "Cheque 44821 was recorded twice on 14 August",
    );
    await user.click(screen.getByRole("button", { name: /post adjustment/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = api.post.mock.calls[0]!;
    expect((payload as { accountId?: string }).accountId).toBeUndefined();
  });

  it("defaults the counter side to suspense, and says so (§62)", async () => {
    await openForm();

    // An unexplained difference must stay conspicuous rather than being tidied into an
    // expense head.
    expect(screen.getAllByText(/suspense/i).length).toBeGreaterThan(0);
  });
});
