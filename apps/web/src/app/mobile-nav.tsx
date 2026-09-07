import * as React from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  ArrowLeftRight, LayoutDashboard, MoreHorizontal, Notebook, Plus,
  Receipt, TrendingDown, TrendingUp, Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Permission } from "@amiri/shared";
import { useAuth } from "@/features/auth/auth-context";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The bottom tab bar (mobile only).
 *
 * A hamburger drawer is a perfectly good *directory* and a poor *primary navigation*: it
 * costs two taps and a decision before anything happens, and on a phone held one-handed
 * it puts every destination in the hardest corner to reach. The four screens people
 * actually live in belong under the thumb.
 *
 * The drawer does not go away — "More" opens it, and it still holds the full permission-
 * filtered menu. This bar is a shortcut layer over it, not a replacement.
 *
 * Hidden from `lg` up, where the sidebar rail is present and this would be redundant.
 */

interface Tab {
  label: string;
  to: string;
  icon: LucideIcon;
  permission: Permission;
  /** `/` matches everything, so it must only light up on an exact match. */
  end?: boolean;
}

/**
 * Candidates in priority order, filtered by permission down to the first three.
 *
 * A list rather than four fixed tabs because roles here differ sharply: an approver may
 * have no `payment_in.create` at all and a cashier may never see Reports. Fixed tabs
 * would leave one of them staring at a control that refuses them.
 */
const TAB_CANDIDATES: Tab[] = [
  { label: "Home", to: "/", icon: LayoutDashboard, permission: "dashboard.view", end: true },
  { label: "DayBook", to: "/daybook", icon: Notebook, permission: "daybook.view" },
  { label: "Khata", to: "/khata", icon: Wallet, permission: "khata.view" },
  { label: "Parties", to: "/parties", icon: Receipt, permission: "parties.view" },
  { label: "Reports", to: "/reports", icon: TrendingUp, permission: "reports.view" },
  { label: "Payment In", to: "/payment-in", icon: TrendingUp, permission: "payment_in.view" },
];

interface QuickAction {
  label: string;
  description: string;
  mode: "PAYMENT_IN" | "PAYMENT_OUT" | "EXPENSE" | "INCOME" | "BANK_TRANSFER";
  icon: LucideIcon;
  permission: Permission;
  tone: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: "Payment In", description: "Money received from a party",
    mode: "PAYMENT_IN", icon: TrendingUp, permission: "payment_in.create",
    tone: "bg-success/15 text-success ring-1 ring-success/20",
  },
  {
    label: "Payment Out", description: "Money paid to a party",
    mode: "PAYMENT_OUT", icon: TrendingDown, permission: "payment_out.create",
    tone: "bg-destructive/15 text-destructive ring-1 ring-destructive/20",
  },
  {
    label: "Expense", description: "A cost booked against a head",
    mode: "EXPENSE", icon: Receipt, permission: "expenses.create",
    tone: "bg-warning/15 text-warning ring-1 ring-warning/25",
  },
  {
    label: "Income", description: "Earnings booked against a head",
    mode: "INCOME", icon: Wallet, permission: "income.create",
    tone: "bg-info/15 text-info ring-1 ring-info/20",
  },
  {
    label: "Bank Transfer", description: "Move money between accounts",
    mode: "BANK_TRANSFER", icon: ArrowLeftRight, permission: "bank_transfer.create",
    tone: "bg-accent/15 text-accent ring-1 ring-accent/20",
  },
];

/**
 * Loaded on demand.
 *
 * The transaction form is the largest screen in the app — Zod schemas, the reference-data
 * queries, the confirmation step. Importing it here would pull all of that into the shell
 * chunk that every user downloads before the login form paints, undoing the code-splitting
 * `router.tsx` is careful about. It arrives when somebody actually taps a quick action.
 */
const TransactionFormDialog = React.lazy(async () => ({
  default: (await import("@/features/transactions/transaction-form")).TransactionFormDialog,
}));

export function MobileNav({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { can } = useAuth();
  const [quickOpen, setQuickOpen] = React.useState(false);
  const [mode, setMode] = React.useState<QuickAction["mode"] | null>(null);

  // Four when there is no quick-add button to make room for, three when there is. Five
  // labelled cells is already tight at 360px; six turns the labels into ellipses.
  const permitted = React.useMemo(
    () => TAB_CANDIDATES.filter((t) => can(t.permission)),
    [can],
  );
  const actions = React.useMemo(
    () => QUICK_ACTIONS.filter((a) => can(a.permission)),
    [can],
  );

  // With nothing to post, the centre button is a button that opens an empty sheet. The
  // bar then runs four tabs plus More across the full width instead.
  const showQuickAdd = actions.length > 0;
  const tabs = permitted.slice(0, showQuickAdd ? 3 : 4);
  const left = showQuickAdd ? tabs.slice(0, 2) : tabs;
  const right = showQuickAdd ? tabs.slice(2) : [];

  return (
    <>
      <nav
        data-mobile-nav
        aria-label="Primary"
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 lg:hidden",
          "border-t border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75",
          // Sits above the home indicator on a gesture-navigation phone rather than under it.
          "pb-safe",
        )}
      >
        <div className="flex h-14 items-stretch">
          {left.map((tab) => <TabButton key={tab.to} tab={tab} />)}

          {showQuickAdd ? (
            <div className="flex flex-1 items-center justify-center">
              <button
                type="button"
                onClick={() => setQuickOpen(true)}
                aria-label="Record a transaction"
                aria-expanded={quickOpen}
                className={cn(
                  "-mt-5 flex size-12 items-center justify-center rounded-full",
                  "bg-accent text-accent-foreground shadow-raised ring-4 ring-background",
                  "transition-transform active:scale-95",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                )}
              >
                <Plus className="size-6" aria-hidden />
              </button>
            </div>
          ) : null}

          {right.map((tab) => <TabButton key={tab.to} tab={tab} />)}

          <button
            type="button"
            onClick={onOpenMenu}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 text-muted-foreground transition-colors active:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <MoreHorizontal className="size-5" aria-hidden />
            <span className="text-[10px] font-medium leading-none">More</span>
          </button>
        </div>
      </nav>

      <QuickAddSheet
        open={quickOpen}
        onOpenChange={setQuickOpen}
        actions={actions}
        onPick={(picked) => {
          setQuickOpen(false);
          setMode(picked);
        }}
      />

      {mode ? (
        <React.Suspense fallback={null}>
          <TransactionFormDialog
            mode={mode}
            open
            // Unmounted on close rather than merely hidden, so the next quick action opens
            // a clean form instead of the last one's half-typed amount.
            onOpenChange={(open) => !open && setMode(null)}
          />
        </React.Suspense>
      ) : null}
    </>
  );
}

function TabButton({ tab }: { tab: Tab }) {
  const Icon = tab.icon;
  return (
    <NavLink
      to={tab.to}
      end={tab.end}
      className={({ isActive }) =>
        cn(
          "relative flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive ? "text-accent" : "text-muted-foreground active:bg-surface-muted",
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Not colour alone (§43) — a bar at the top edge marks the active tab too. */}
          {isActive ? (
            <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-accent" aria-hidden />
          ) : null}
          <Icon className="size-5" aria-hidden />
          <span className="max-w-full truncate px-1 text-[10px] font-medium leading-none">
            {tab.label}
          </span>
        </>
      )}
    </NavLink>
  );
}

/**
 * The quick-add sheet.
 *
 * Slides up from the bottom because that is where the button is — a dialog that appears
 * in the middle of the screen breaks the connection to what was pressed, and on a phone
 * it lands under the keyboard as soon as anything is focused.
 */
function QuickAddSheet({
  open, onOpenChange, actions, onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: QuickAction[];
  onPick: (mode: QuickAction["mode"]) => void;
}) {
  const { pathname } = useLocation();

  // Navigating with the sheet open would leave it hanging over the new screen.
  React.useEffect(() => {
    onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0 pb-safe">
        {/* SheetContent renders its own close button, top-right — hence the right padding. */}
        <div className="border-b border-border px-5 py-3.5 pr-14">
          <h2 className="text-base font-semibold tracking-tight">Record a transaction</h2>
          <p className="text-xs text-muted-foreground">Posted to the books immediately.</p>
        </div>

        <div className="max-h-[60dvh] overflow-y-auto p-2">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.mode}
                type="button"
                onClick={() => onPick(action.mode)}
                className="flex w-full items-center gap-3.5 rounded-lg px-3 py-3 text-left transition-colors active:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", action.tone)}>
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{action.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {action.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
