import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Link } from "react-router-dom";
import { Button } from "./button";

/**
 * `<Button asChild>` (Radix Slot).
 *
 * This shipped broken and stayed broken for several phases. `Slot` requires exactly one
 * child, and the button rendered two — the spinner position and the real child — so every
 * `asChild` button threw "Slot failed to slot onto its children" and took the whole route
 * down with it. It threw even when `loading` was false, because the `null` in the spinner
 * position still counts as a child.
 *
 * It survived because the verification for each phase checked that the dev server returned
 * HTTP 200 for a route. That only proves the HTML shell was served; it never executes
 * React, so a render-time crash is completely invisible to it.
 */
describe("Button asChild", () => {
  it("renders a link child without throwing", () => {
    render(
      <MemoryRouter>
        <Button asChild variant="ghost">
          <Link to="/credit">Open credit report</Link>
        </Button>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: /open credit report/i });
    expect(link).toBeInTheDocument();
    // The button's classes are merged onto the child rather than wrapping it.
    expect(link.className).toContain("inline-flex");
  });

  it("still slots correctly when the child has several children of its own", () => {
    render(
      <MemoryRouter>
        <Button asChild>
          <Link to="/credit">
            Open credit report
            <span data-testid="icon">→</span>
          </Link>
        </Button>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("shows the spinner alongside a slotted child while loading", () => {
    const { container } = render(
      <MemoryRouter>
        <Button asChild loading>
          <Link to="/credit">Open credit report</Link>
        </Button>
      </MemoryRouter>,
    );

    expect(container.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.getByRole("link", { name: /open credit report/i })).toBeInTheDocument();
  });

  it("still behaves as an ordinary button without asChild", () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole("button", { name: /save/i });
    // A submitting button must be unclickable, not merely styled as busy.
    expect(button).toBeDisabled();
  });
});
