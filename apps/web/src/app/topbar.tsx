import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Check, ChevronsUpDown, LogOut, Menu, Moon, Search, Sun, User as UserIcon } from "lucide-react";
import { useAuth } from "@/features/auth/auth-context";
import { NotificationBell } from "@/components/notification-bell";
import { useTheme } from "@/hooks/use-theme";
import { initials } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function Topbar({
  onOpenMobileNav,
  onOpenCommandPalette,
}: {
  onOpenMobileNav: () => void;
  onOpenCommandPalette: () => void;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>

      <BranchSwitcher />

      <div className="flex-1" />

      {/* Command palette trigger. Shows the shortcut so it is discoverable (§30). */}
      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="hidden h-9 items-center gap-2 rounded-md border border-input bg-surface px-3 text-sm text-muted-foreground shadow-sm transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex md:w-56 lg:w-64"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="truncate">Search…</span>
        <kbd className="ml-auto hidden rounded border border-border bg-surface-muted px-1.5 py-0.5 text-2xs font-medium md:inline">
          ⌘K
        </kbd>
      </button>

      <Button variant="ghost" size="icon" className="sm:hidden" onClick={onOpenCommandPalette} aria-label="Search">
        <Search />
      </Button>

      <NotificationBell />

      <ThemeToggle />

      <Separator orientation="vertical" className="mx-1 h-6" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-9 gap-2 px-1.5 sm:px-2">
            <Avatar className="size-7">
              <AvatarFallback>{initials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="hidden min-w-0 text-left leading-tight sm:block">
              <div className="truncate text-xs font-medium">{user.name}</div>
              <div className="truncate text-2xs text-muted-foreground">{user.role.label}</div>
            </div>
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Signed in</DropdownMenuLabel>
          <div className="px-2 pb-2">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted-foreground">{user.email}</div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant={user.isSuperAdmin ? "accent" : "outline"}>{user.role.label}</Badge>
              {user.isSuperAdmin ? (
                <Badge variant="info">All branches</Badge>
              ) : (
                <Badge variant="outline">
                  {user.branches.length} branch{user.branches.length === 1 ? "" : "es"}
                </Badge>
              )}
            </div>
          </div>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("/profile")}>
            <UserIcon />
            Profile & password
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => void onLogout()}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

/**
 * Branch context switcher.
 *
 * The list comes from the server-issued session, so it can only ever contain branches the
 * user actually holds. Selecting one calls `/auth/switch-branch`, which re-validates the
 * choice server-side — the dropdown is a convenience, not the authority.
 */
function BranchSwitcher() {
  const { user, switchBranch } = useAuth();
  const [switching, setSwitching] = React.useState(false);

  if (!user || user.branches.length === 0) return null;

  const active = user.branches.find((b) => b.id === user.activeBranchId);

  // Nothing to switch between — render the branch as a static label instead of a dropdown
  // that does nothing when clicked.
  if (user.branches.length === 1) {
    const only = user.branches[0]!;
    return (
      <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-sm">
        <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-medium">{only.code}</span>
        <span className="hidden truncate text-muted-foreground sm:inline">{only.name}</span>
      </div>
    );
  }

  const onSelect = async (branchId: string | null) => {
    if (branchId === user.activeBranchId) return;
    setSwitching(true);
    try {
      await switchBranch(branchId);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2" loading={switching}>
          <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{active ? active.code : "All branches"}</span>
          <span className="hidden max-w-[10rem] truncate text-muted-foreground md:inline">
            {active ? active.name : `${user.branches.length} branches`}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Branch in context</DropdownMenuLabel>

        {/* Un-narrows the context: every branch the user holds, combined. */}
        <DropdownMenuItem onSelect={() => void onSelect(null)}>
          <span className="w-10 shrink-0 font-mono text-xs font-medium">All</span>
          <span className="truncate">All branches</span>
          {user.activeBranchId === null ? <Check className="ml-auto size-4 text-accent" /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />

        {user.branches.map((branch) => (
          <DropdownMenuItem key={branch.id} onSelect={() => void onSelect(branch.id)}>
            <span className="w-10 shrink-0 font-mono text-xs font-medium">{branch.code}</span>
            <span className="truncate">{branch.name}</span>
            {branch.id === user.activeBranchId ? <Check className="ml-auto size-4 text-accent" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Switch to {theme === "dark" ? "light" : "dark"} mode</TooltipContent>
    </Tooltip>
  );
}
