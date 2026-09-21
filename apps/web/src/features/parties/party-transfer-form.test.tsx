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

const { renderWithProviders } = await import("@/test/harness");
const { PartyTransferButton } = await import("./party-transfer-form");

const RAMANUJ = "6501aa0000000000000000a1";
const EDDIGO = "6501aa0000000000000000a2";

describe("party to party transfer", () => {
  beforeEach(() => {
    api.post.mockReset();
    api.list.mockResolvedValue({
      items: [
        { id: RAMANUJ, name: "Ramanuj", code: "PTY-00001", balance: 50_000_00 },
        { id: EDDIGO, name: "Eddigo", code: "PTY-00002", balance: -20_000_00 },
      ],
      meta: { page: 1, limit: 100, total: 2, totalPages: 1, hasNext: false, hasPrev: false },
    });
    api.post.mockResolvedValue({ txnNo: "PTY-TRF-2026-000001" });
  });

  async function openForm() {
    const user = userEvent.setup();
    renderWithProviders(<PartyTransferButton />);
    await user.click(screen.getByRole("button", { name: /party to party transfer/i }));
    await screen.findByRole("dialog");
    return user;
  }

  it("posts from, to and amount, and reads both balances back first", async () => {
    const user = await openForm();

    await user.click(screen.getByRole("combobox", { name: /from party/i }));
    await user.click(await screen.findByRole("option", { name: /ramanuj/i }));
    await user.click(screen.getByRole("combobox", { name: /to party/i }));
    await user.click(await screen.findByRole("option", { name: /eddigo/i }));

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "10000");

    // Ramanuj owes 50,000 → 40,000; we owe Eddigo 20,000 → 10,000.
    expect(await screen.findByText(/Lena hai ₹40,000/)).toBeInTheDocument();
    expect(screen.getByText(/Dena hai ₹10,000/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^transfer$/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [path, body] = api.post.mock.calls[0]!;
    expect(path).toBe("/party-transfers");
    expect(body).toMatchObject({ fromPartyId: RAMANUJ, toPartyId: EDDIGO, amount: 10_000_00 });
  });

  it("does not post without both parties", async () => {
    const user = await openForm();

    const amount = screen.getByLabelText(/^amount/i);
    await user.clear(amount);
    await user.type(amount, "10000");
    await user.click(screen.getByRole("button", { name: /^transfer$/i }));

    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(api.post).not.toHaveBeenCalled();
  });
});
