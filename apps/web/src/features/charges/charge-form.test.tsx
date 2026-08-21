import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = { get: vi.fn(), list: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() };
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api };
});
vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({ user: { id: "6501aa000000000000000001", isSuperAdmin: true }, can: () => true }),
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");
const { NewChargeRuleButton } = await import("./charge-form");

/**
 * Charge rules (§18, §39).
 *
 * Rates are integer BASIS POINTS. 1.75% is 175 — exactly, forever. The form takes a percent
 * because that is what a person says, and the conversion is the one place a float touches
 * the value; it is rounded immediately and never stored.
 *
 * A commission that drifts by a paisa per transaction is a month-end reconciliation
 * nightmare, and floats drift. These tests pin the conversion, including the case that
 * actually breaks it: 1.75 × 100 in IEEE-754 is 174.99999999999997.
 */
describe("charge rule form", () => {
  beforeEach(() => {
    api.post.mockResolvedValue({ id: "c1", name: "Test", sampleOn100k: 175000 });
  });

  async function openForm() {
    const user = userEvent.setup();
    renderWithProviders(<NewChargeRuleButton />);
    await user.click(screen.getByRole("button", { name: /new rule/i }));
    await screen.findByRole("dialog");
    return user;
  }

  it("converts a percent to exact integer basis points", async () => {
    const user = await openForm();

    const rate = screen.getByLabelText(/^rate/i);
    await user.clear(rate);
    await user.type(rate, "1.75");

    // 175, not 174.99999999999997 — the float is rounded the instant it is produced.
    expect(await screen.findByText(/\b175\b/)).toBeInTheDocument();
  });

  it("shows the worked example so a rate is legible without arithmetic", async () => {
    const user = await openForm();

    const rate = screen.getByLabelText(/^rate/i);
    await user.clear(rate);
    await user.type(rate, "1.75");

    // 1.75% of ₹1,00,000 = ₹1,750.
    expect(await screen.findByText(/1,750/)).toBeInTheDocument();
  });

  it("sends integer basis points, never the percent", async () => {
    const user = await openForm();

    await user.type(screen.getByLabelText(/^name/i), "Distributor Commission");
    await user.type(screen.getByLabelText(/^code/i), "DIST_COMM");

    const rate = screen.getByLabelText(/^rate/i);
    await user.clear(rate);
    await user.type(rate, "1.75");

    await user.click(screen.getByRole("button", { name: /create rule/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = api.post.mock.calls[0]!;
    const sent = payload as { rateBps?: number; ratePercent?: number };

    expect(sent.rateBps).toBe(175);
    expect(Number.isInteger(sent.rateBps)).toBe(true);
    // A percent crossing the wire would mean the server converting too — two
    // implementations, two chances to round differently.
    expect(sent).not.toHaveProperty("ratePercent");
  });

  it("keeps the highest tier open-ended, structurally", async () => {
    const user = await openForm();

    await user.click(screen.getByRole("combobox", { name: /how is it calculated/i }));
    await user.click(await screen.findByRole("option", { name: /tiered/i }));

    // The last band's ceiling is not an input at all — an amount above the highest ceiling
    // would match no band and be charged nothing, so the invalid shape is not buildable.
    expect(await screen.findByText(/and above/i)).toBeInTheDocument();
    expect(screen.getByText(/would match no band/i)).toBeInTheDocument();
  });

  it("sends tiers with a null ceiling on the last band", async () => {
    const user = await openForm();

    await user.type(screen.getByLabelText(/^name/i), "Tiered Fee");
    await user.type(screen.getByLabelText(/^code/i), "TIERED_FEE");

    await user.click(screen.getByRole("combobox", { name: /how is it calculated/i }));
    await user.click(await screen.findByRole("option", { name: /tiered/i }));

    await user.click(screen.getByRole("button", { name: /create rule/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = api.post.mock.calls[0]!;
    const tiers = (payload as { tiers: Array<{ upTo: unknown; rateBps: number }> }).tiers;

    expect(tiers.at(-1)!.upTo).toBeNull();
    expect(tiers.every((t) => Number.isInteger(t.rateBps))).toBe(true);
  });
});
