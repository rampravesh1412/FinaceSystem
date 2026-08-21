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

vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({
    user: { id: "6501aa000000000000000001", activeBranchId: "6501aa000000000000000003", isSuperAdmin: true },
    can: () => true,
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const { NewPartyButton } = await import("./party-form");

/**
 * The party form's opening balance (§8, §11).
 *
 * This is the highest-value component test in the application, because the bug it guards
 * against is SILENT. A party's opening balance is signed — positive means they owe us —
 * and an inverted one still leaves the trial balance tying perfectly. Nothing downstream
 * catches it. The books balance; they are simply about a different reality.
 *
 * So the form asks the direction as a question and applies the sign itself, and these tests
 * assert on the payload rather than on the rendering: what matters is the number that
 * reaches the server.
 */
describe("party form — opening balance sign", () => {
  beforeEach(() => {
    api.list.mockResolvedValue({
      items: [{ id: BRANCH_ID, name: "Head Office", code: "101", city: "Patna" }],
      meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
    });
    api.post.mockResolvedValue({ id: "p1", name: "Sharma Traders", balance: 12510100 });
  });

  async function openForm() {
    const user = userEvent.setup();
    renderWithProviders(<NewPartyButton />);
    await user.click(screen.getByRole("button", { name: /new party/i }));
    await screen.findByRole("dialog");
    return user;
  }

  it('sends a POSITIVE opening balance for "they owe us"', async () => {
    const user = await openForm();

    await user.type(screen.getByLabelText(/party name/i), "Sharma Traders");
    await user.click(screen.getByRole("tab", { name: /opening & credit/i }));

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "125101");

    // "They owe us" is the default, but assert it rather than assume it.
    expect(screen.getByRole("button", { name: /they owe us/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: /create party/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = api.post.mock.calls[0]!;
    expect((payload as { openingBalance: number }).openingBalance).toBeGreaterThan(0);
  });

  it('sends a NEGATIVE opening balance for "we owe them"', async () => {
    const user = await openForm();

    await user.type(screen.getByLabelText(/party name/i), "Verma Supplies");
    await user.click(screen.getByRole("tab", { name: /opening & credit/i }));

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "88500");

    await user.click(screen.getByRole("button", { name: /we owe them/i }));
    await user.click(screen.getByRole("button", { name: /create party/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = api.post.mock.calls[0]!;
    // The bug this exists to catch: an inverted opening balance still ties.
    expect((payload as { openingBalance: number }).openingBalance).toBeLessThan(0);
  });

  it("ignores a minus the operator types, deferring to the direction chosen", async () => {
    const user = await openForm();

    await user.type(screen.getByLabelText(/party name/i), "Double Negative Traders");
    await user.click(screen.getByRole("tab", { name: /opening & credit/i }));

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "-5000");

    // "They owe us" is selected, so the result must be positive regardless of the sign
    // typed — otherwise a minus plus "we owe them" would cancel into the wrong direction.
    await user.click(screen.getByRole("button", { name: /create party/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = api.post.mock.calls[0]!;
    expect((payload as { openingBalance: number }).openingBalance).toBeGreaterThan(0);
  });

  it("states the Lena/Dena reading back before submission", async () => {
    const user = await openForm();

    await user.click(screen.getByRole("tab", { name: /opening & credit/i }));
    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "88500");
    await user.click(screen.getByRole("button", { name: /we owe them/i }));

    // The operator sees the consequence in words, not just a signed integer.
    expect(await screen.findByText(/DENA HAI — we owe them/i)).toBeInTheDocument();
  });
});
