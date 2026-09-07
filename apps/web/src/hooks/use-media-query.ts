import * as React from "react";

/**
 * Subscribe to a media query.
 *
 * `useSyncExternalStore` rather than an effect + state, because the effect version
 * renders once with the wrong answer before it corrects itself. On a phone that meant the
 * desktop table mounted, measured, and was replaced by the card list a frame later — a
 * visible flash on every navigation, and a wasted layout pass on the slowest devices.
 *
 * The server snapshot is `false` for the same reason the app is authored mobile-first:
 * a `min-width` query is false at the narrowest width, so pre-paint we assume the small
 * layout and widen, never the reverse.
 */
function subscribe(query: string) {
  return (onChange: () => void) => {
    const mql = window.matchMedia(query);
    // Safari below 14 has no addEventListener on MediaQueryList. The app supports iOS
    // Safari as a PWA target, so the legacy path is not hypothetical here.
    if (mql.addEventListener) {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  };
}

export function useMediaQuery(query: string): boolean {
  return React.useSyncExternalStore(
    React.useMemo(() => subscribe(query), [query]),
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Tailwind's `lg` — the breakpoint at which the fixed sidebar appears. */
export const LG_QUERY = "(min-width: 1024px)";
/** Tailwind's `md` — the breakpoint at which tables stop becoming card lists. */
export const MD_QUERY = "(min-width: 768px)";
/** Tailwind's `sm`. */
export const SM_QUERY = "(min-width: 640px)";

/** True on phones and small tablets — below `md`, where a data table cannot fit. */
export function useIsMobile(): boolean {
  return !useMediaQuery(MD_QUERY);
}

/** True below `lg`, where navigation is a drawer plus a bottom bar rather than a rail. */
export function useIsCompact(): boolean {
  return !useMediaQuery(LG_QUERY);
}

/**
 * True when the browser reports a coarse primary pointer — a finger rather than a mouse.
 *
 * Distinct from width: a 1280px-wide tablet still needs 44px hit targets, and a 700px
 * desktop window does not. Used to size controls, never to choose a layout.
 */
export function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
