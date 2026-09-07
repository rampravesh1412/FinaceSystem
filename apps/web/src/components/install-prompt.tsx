import * as React from "react";
import {
  Check, Download, Gauge, MoreVertical, Plus, Share, Smartphone, WifiOff, X, Zap,
} from "lucide-react";
import { isIOSSafari, useInstallPrompt } from "@/lib/pwa";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * "Install this app".
 *
 * Two platforms, two completely different mechanics, one component:
 *
 *  - **Chromium** (Android, desktop Chrome/Edge) gives a real install API. One tap.
 *  - **iOS** gives nothing. Safari can only add to the home screen through its own Share
 *    sheet, so the honest thing is to show the user exactly which buttons to press — with
 *    the right icons, because "the Share button" means nothing until you have seen it.
 *
 * A dismissal is remembered so the card is an invitation rather than a nag, and it is
 * remembered per-browser rather than per-account: installing is a property of the device
 * in your hand, not of who is signed in on it.
 */

const DISMISS_KEY = "amiri-install-dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    // Private mode, or storage blocked. Showing the card is the better failure.
    return false;
  }
}

function useDismissal() {
  const [dismissed, setDismissed] = React.useState(readDismissed);
  const dismiss = React.useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* not persisted; it still hides for this visit */
    }
  }, []);
  return { dismissed, dismiss };
}

const BENEFITS = [
  { icon: Zap, label: "Opens straight from your home screen" },
  { icon: Gauge, label: "Full screen — no browser bars eating the ledger" },
  { icon: WifiOff, label: "Loads on a weak connection" },
] as const;

/* ── The login-screen card ────────────────────────────────────────────────── */

export function InstallAppCard({ className }: { className?: string }) {
  const { availability, prompting, install } = useInstallPrompt();
  const { dismissed, dismiss } = useDismissal();
  const [showIOS, setShowIOS] = React.useState(false);

  // Already installed, or a browser that cannot: say nothing rather than advertise
  // something the user cannot act on.
  if (availability === "installed" || availability === "unsupported") return null;
  if (dismissed) return null;

  const ios = availability === "ios";

  return (
    <>
      <div
        className={cn(
          "relative overflow-hidden rounded-lg border border-accent/25 bg-accent/[0.06] p-4",
          className,
        )}
      >
        <div
          className="pointer-events-none absolute -right-8 -top-10 size-28 rounded-full bg-accent/10 blur-2xl"
          aria-hidden
        />

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install suggestion"
          className="touch-target absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>

        <div className="relative flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-accent to-accent/70 shadow-subtle">
            <Smartphone className="size-5 text-accent-foreground" aria-hidden />
          </div>

          <div className="min-w-0 flex-1 pr-6">
            <p className="text-sm font-semibold tracking-tight">Install AMIRI Finance</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {ios
                ? "Add it to your home screen and it opens like any other app on your iPhone."
                : "Get the app on this device — it opens instantly and runs full screen."}
            </p>

            <ul className="mt-3 space-y-1.5">
              {BENEFITS.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Icon className="size-3.5 shrink-0 text-accent" aria-hidden />
                  <span>{label}</span>
                </li>
              ))}
            </ul>

            <Button
              type="button"
              variant="accent"
              size="sm"
              loading={prompting}
              onClick={() => (ios ? setShowIOS(true) : void install())}
              className="mt-3.5 h-9 w-full sm:w-auto"
            >
              {ios ? <Share className="size-4" /> : <Download className="size-4" />}
              {ios ? "How to add it" : "Install app"}
            </Button>
          </div>
        </div>
      </div>

      <IOSInstallDialog open={showIOS} onOpenChange={setShowIOS} />
    </>
  );
}

/* ── Compact button, for the topbar and the profile menu ──────────────────── */

export function InstallAppButton({ className }: { className?: string }) {
  const { availability, prompting, install } = useInstallPrompt();
  const [showIOS, setShowIOS] = React.useState(false);

  if (availability === "installed" || availability === "unsupported") return null;
  const ios = availability === "ios";

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={prompting}
        onClick={() => (ios ? setShowIOS(true) : void install())}
        className={cn("touch-target", className)}
      >
        <Download className="size-4" />
        Install app
      </Button>
      <IOSInstallDialog open={showIOS} onOpenChange={setShowIOS} />
    </>
  );
}

/* ── iOS instructions ─────────────────────────────────────────────────────── */

function Step({
  n, children, icon: Icon,
}: {
  n: number;
  children: React.ReactNode;
  icon?: typeof Share;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-2xs font-semibold text-accent">
        {n}
      </span>
      <span className="flex-1 text-sm leading-relaxed text-muted-foreground">
        {children}
        {Icon ? (
          <Icon className="mx-1 inline size-4 -translate-y-px text-foreground" aria-hidden />
        ) : null}
      </span>
    </li>
  );
}

export function IOSInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Chrome and Firefox on iOS render the same WebKit engine but cannot add to the home
  // screen at all — only Safari can. Pointing them at a Share menu they do not have is
  // worse than telling them the truth.
  const safari = isIOSSafari();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to your home screen</DialogTitle>
          <DialogDescription>
            {safari
              ? "iPhone and iPad install apps through Safari's Share menu — three taps."
              : "On iPhone and iPad, only Safari can add an app to the home screen."}
          </DialogDescription>
        </DialogHeader>

        {safari ? (
          <ol className="space-y-3.5">
            <Step n={1} icon={Share}>
              Tap the <span className="font-medium text-foreground">Share</span> button in
              the toolbar — the square with an arrow pointing out of it
            </Step>
            <Step n={2} icon={Plus}>
              Scroll down and choose{" "}
              <span className="font-medium text-foreground">Add to Home Screen</span>
            </Step>
            <Step n={3}>
              Tap <span className="font-medium text-foreground">Add</span> — AMIRI Finance
              will appear on your home screen with its own icon.
            </Step>
          </ol>
        ) : (
          <ol className="space-y-3.5">
            <Step n={1} icon={MoreVertical}>
              Open this page in <span className="font-medium text-foreground">Safari</span>{" "}
              — from the menu, choose “Open in Safari”
            </Step>
            <Step n={2} icon={Share}>
              Tap <span className="font-medium text-foreground">Share</span>, then{" "}
              <span className="font-medium text-foreground">Add to Home Screen</span>
            </Step>
          </ol>
        )}

        <div className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
          <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          <span>
            Your books are never stored on the device. The installed app is the same
            secure session — it still signs in, and every balance still comes from the
            server.
          </span>
        </div>

        <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
          Got it
        </Button>
      </DialogContent>
    </Dialog>
  );
}
