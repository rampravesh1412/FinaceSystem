import * as React from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/features/auth/auth-context";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { MobileNav } from "./mobile-nav";
import { CommandPalette, useCommandPalette } from "./command-palette";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { RouteFallback } from "@/components/route-fallback";
import { PageTransition } from "@/components/motion";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "amiri-sidebar-collapsed";

/**
 * The authenticated shell.
 *
 * Responsive per §48. Three layouts, not two:
 *
 *  - **lg and up** — a fixed sidebar rail, collapsible to icons.
 *  - **below lg** — a slide-over drawer, opened from the topbar or from "More".
 *  - **below lg** — additionally, a bottom tab bar carrying the four screens people
 *    actually live in, plus a quick-add button for posting a transaction.
 *
 * The drawer closes on navigation, which sounds obvious and is the single most common
 * defect in mobile admin navigation.
 */
export function AppLayout() {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const palette = useCommandPalette();

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* preference is simply not persisted */
      }
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-dvh bg-background">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden border-r border-sidebar-border transition-[width] duration-200 lg:block",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          // `w-[85vw]` rather than the default 75%: on a 360px phone three-quarters is
          // 270px, and the longer menu labels ("Reconciliation", "Expense Ledger") were
          // truncating. Capped so it never becomes a full-screen takeover on a tablet.
          className="w-[85vw] max-w-[19rem] border-sidebar-border p-0"
          closeClassName="bg-sidebar-border/70 text-sidebar-muted hover:bg-sidebar-border hover:text-sidebar-foreground sm:bg-sidebar-border/70"
        >
          <Sidebar collapsed={false} onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className={cn("flex min-w-0 flex-1 flex-col transition-[padding] duration-200", collapsed ? "lg:pl-16" : "lg:pl-60")}>
        <Topbar
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenCommandPalette={() => palette.setOpen(true)}
        />
        {/*
          `pb-nav` reserves the height of the bottom tab bar plus the home indicator, so
          the last row of a table is scrollable clear of it rather than sitting
          permanently underneath. It is dropped from `lg`, where there is no bar.
        */}
        <main className="min-w-0 flex-1 px-4 py-5 pb-nav sm:px-6 sm:py-6 lg:pb-6">
          {/* One boundary for every lazy route, here rather than per-route: the fallback
              is the same page-shaped skeleton whichever screen is arriving. */}
          <React.Suspense fallback={<RouteFallback />}>
            {/* Keyed on the path so each route genuinely re-enters. Without the key React
                reuses the subtree and the animation runs once, on first load only. */}
            <PageTransition key={pathname}>
              <Outlet />
            </PageTransition>
          </React.Suspense>
        </main>
      </div>

      <MobileNav onOpenMenu={() => setMobileNavOpen(true)} />

      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
    </div>
  );
}

/**
 * Route guard.
 *
 * Renders nothing decisive until the silent refresh has resolved — bouncing to /login
 * during that window would sign out every user on every page reload.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    // The attempted path is preserved so sign-in returns the user where they were going.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <AppLayout />;
}
