import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * jsdom gaps that Radix and the charting library rely on.
 *
 * Radix measures elements to position popovers and checks `matchMedia` for reduced motion;
 * jsdom implements neither. Without these stubs every dialog test fails on an unrelated
 * `TypeError`, which trains people to distrust the suite.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}

// Radix Select calls these on the trigger; jsdom leaves them undefined.
Element.prototype.scrollIntoView ??= vi.fn();
Element.prototype.hasPointerCapture ??= (() => false) as never;
Element.prototype.setPointerCapture ??= vi.fn();
Element.prototype.releasePointerCapture ??= vi.fn();

afterEach(() => cleanup());
