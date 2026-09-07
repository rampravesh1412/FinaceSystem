import * as React from "react";

/**
 * Progressive Web App runtime: install prompt, display mode, and update handling.
 *
 * The awkward part of `beforeinstallprompt` is that Chrome fires it during page load —
 * routinely BEFORE React has mounted. A component that subscribes in `useEffect` misses
 * it and the install button never appears, which is why so many "Install" buttons in the
 * wild only work after a refresh.
 *
 * So the listeners are attached at MODULE SCOPE, the moment this file is first imported
 * (`main.tsx` imports it before `createRoot`), and the event is parked in a tiny store.
 * Components read the store through `useInstallPrompt`, whenever they happen to mount.
 */

/** Not in TypeScript's DOM lib — it is Chromium-only and still non-standard. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export type InstallAvailability =
  /** Chromium fired `beforeinstallprompt` — a real one-tap install is available. */
  | "prompt"
  /** iOS/iPadOS Safari, which has no install API. The user adds it by hand. */
  | "ios"
  /** Already running as an installed app. */
  | "installed"
  /** A browser that cannot install this (Firefox desktop, an in-app webview, SSR). */
  | "unsupported";

interface InstallState {
  availability: InstallAvailability;
  /** True while the browser's own install sheet is open. */
  prompting: boolean;
}

/* ── Platform detection ───────────────────────────────────────────────────── */

const isBrowser = typeof window !== "undefined";

/**
 * Running as an installed app rather than in a browser tab.
 *
 * Two checks because they disagree: `display-mode: standalone` is the standard and is
 * what Android/desktop report, while iOS only ever set the non-standard
 * `navigator.standalone`. iOS 17+ does support the media query, older iOS does not, and
 * this app is expected to run on both.
 */
export function isStandalone(): boolean {
  if (!isBrowser) return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * iOS or iPadOS, on any browser.
 *
 * iPadOS 13+ reports itself as "Macintosh", so the platform string alone identifies an
 * iPad as a desktop Mac. The touch-points check is what separates them.
 */
export function isIOS(): boolean {
  if (!isBrowser) return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Safari proper, as opposed to Chrome/Firefox/Edge on iOS.
 *
 * Worth distinguishing because on iOS only Safari can add to the home screen — telling a
 * Chrome-on-iPhone user to tap Share and look for "Add to Home Screen" sends them hunting
 * for a menu item that is not there.
 */
export function isIOSSafari(): boolean {
  if (!isIOS()) return false;
  const ua = navigator.userAgent;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|Brave/.test(ua);
}

/* ── Store ────────────────────────────────────────────────────────────────── */

function initialAvailability(): InstallAvailability {
  if (!isBrowser) return "unsupported";
  if (isStandalone()) return "installed";
  if (isIOS()) return "ios";
  return "unsupported";
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { availability: initialAvailability(), prompting: false };

/** Stable identity: `useSyncExternalStore` re-renders forever if this is rebuilt. */
const SERVER_STATE: InstallState = { availability: "unsupported", prompting: false };

const listeners = new Set<() => void>();

function setState(next: Partial<InstallState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

if (isBrowser) {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppressing the default is what stops Chrome's own mini-infobar and hands us the
    // right to show the invitation where it belongs — on the sign-in screen.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    // Chromium has been known to fire this even in a standalone window; "installed" is
    // the stronger fact and must not be downgraded by it.
    if (state.availability !== "installed") setState({ availability: "prompt" });
  });

  window.addEventListener("appinstalled", () => {
    deferred = null;
    setState({ availability: "installed", prompting: false });
  });

  // Launching the installed app from the home screen while a tab is still open, or a
  // desktop PWA being popped in or out of a window.
  const mql = window.matchMedia("(display-mode: standalone)");
  const onDisplayChange = () => {
    if (isStandalone()) setState({ availability: "installed" });
  };
  if (mql.addEventListener) mql.addEventListener("change", onDisplayChange);
  else mql.addListener(onDisplayChange);
}

/* ── Hook ─────────────────────────────────────────────────────────────────── */

export interface InstallPrompt extends InstallState {
  /** True when there is anything useful to offer the user. */
  canInstall: boolean;
  /**
   * Open the browser's install sheet. Resolves to the user's choice, or `null` on a
   * platform with no install API (iOS), where the caller should show instructions.
   */
  install: () => Promise<"accepted" | "dismissed" | null>;
}

export function useInstallPrompt(): InstallPrompt {
  const snapshot = React.useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    () => state,
    () => SERVER_STATE,
  );

  const install = React.useCallback(async () => {
    if (!deferred) return null;
    setState({ prompting: true });
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      // The event is single-use: Chrome will fire a fresh one if the user declines and
      // becomes eligible again, so holding on to a spent one only produces a no-op click.
      deferred = null;
      setState({
        prompting: false,
        availability: outcome === "accepted" ? "installed" : "unsupported",
      });
      return outcome;
    } catch {
      setState({ prompting: false });
      return null;
    }
  }, []);

  return {
    ...snapshot,
    canInstall: snapshot.availability === "prompt" || snapshot.availability === "ios",
    install,
  };
}

/* ── Service worker registration ──────────────────────────────────────────── */

/**
 * Register the worker, and tell the caller when a new version is waiting.
 *
 * The new worker is deliberately NOT activated automatically. Swapping the JS bundle
 * under a user who is half-way through entering a payment would either lose the form or
 * mix two builds of the code, so the app surfaces a "Reload" affordance and the user
 * chooses the moment.
 */
export function registerServiceWorker(onUpdateReady: (activate: () => void) => void): void {
  if (!isBrowser || !("serviceWorker" in navigator)) return;

  // Vite serves modules unbundled in development and the worker's asset caching fights
  // that: an edited file keeps being served from the cache until a hard reload. The
  // worker is a production concern, so in development any previous one is removed.
  if (import.meta.env.DEV) {
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister();
    });
    return;
  }

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        // Already waiting when the page loaded — a previous visit downloaded it.
        if (registration.waiting) {
          onUpdateReady(() => activate(registration));
        }

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // `controller` is null on the very first install. Announcing "a new version is
            // available" to somebody who just opened the app for the first time is noise.
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              onUpdateReady(() => activate(registration));
            }
          });
        });
      })
      .catch(() => {
        /* An unregistrable worker costs offline support, not the application. */
      });

    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // Guarded: Chrome can fire this more than once, and an unguarded reload here is the
      // classic infinite refresh loop.
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}

function activate(registration: ServiceWorkerRegistration) {
  registration.waiting?.postMessage("SKIP_WAITING");
}
