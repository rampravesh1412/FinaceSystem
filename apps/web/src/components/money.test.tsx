import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Money } from "./money";

/**
 * The `<Money>` component (§39, §43).
 *
 * Every amount on every screen goes through here, so the failure modes are systemic rather
 * than local. Three of them matter enough to pin down:
 *
 *   - It must never re-derive. It formats the integer paise the server computed; a
 *     component that divided by 100 itself would be a second implementation of money.
 *   - Direction must never be carried by colour alone (§43) — a red figure and a green one
 *     have to stay distinguishable on a greyscale printout and to a colour-blind reader.
 *   - `null` is not zero. A missing figure and a figure of zero mean different things, and
 *     rendering the first as "₹0.00" is a lie the operator cannot detect.
 */
describe("Money", () => {
  it("formats paise in Indian digit grouping without re-deriving", () => {
    render(<Money value={12510100} />);
    // 12,510,100 paise = ₹1,25,101.00 — 2-2-3 grouping, not 125,101.00.
    expect(screen.getByText(/1,25,101\.00/)).toBeInTheDocument();
  });

  it("renders large amounts in lakhs and crores correctly", () => {
    const { rerender } = render(<Money value={1_00_00_000_00} />);
    expect(screen.getByText(/1,00,00,000\.00/)).toBeInTheDocument();

    rerender(<Money value={9_50_000_00} />);
    expect(screen.getByText(/9,50,000\.00/)).toBeInTheDocument();
  });

  it("distinguishes a missing amount from zero", () => {
    const { rerender } = render(<Money value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();

    rerender(<Money value={0} />);
    expect(screen.getByText(/0\.00/)).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("carries direction with a glyph, not colour alone (§43)", () => {
    const { container, rerender } = render(<Money value={5000} direction="in" showIcon />);
    // An svg glyph accompanies the figure — colour is never the only signal.
    expect(container.querySelector("svg")).toBeTruthy();

    rerender(<Money value={5000} direction="out" showIcon />);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("derives direction from the sign when asked to, and only then", () => {
    // "auto" is right for a running balance; a payment-out row stores a positive amount
    // that means money leaving, which is why it is not the default.
    const { container: negative } = render(<Money value={-5000} direction="auto" showIcon />);
    const { container: positive } = render(<Money value={5000} direction="auto" showIcon />);

    expect(negative.querySelector("svg")).toBeTruthy();
    expect(positive.querySelector("svg")).toBeTruthy();
    expect(negative.innerHTML).not.toBe(positive.innerHTML);
  });

  it("uses tabular figures so a column of amounts aligns", () => {
    const { container } = render(<Money value={100} />);
    expect(container.querySelector(".tabular")).toBeTruthy();
  });

  it("keeps the paise, because a ledger line without them is not a ledger line", () => {
    render(<Money value={12345} />);
    expect(screen.getByText(/123\.45/)).toBeInTheDocument();
  });
});
