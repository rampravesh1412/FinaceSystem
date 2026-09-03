import { useNavigate } from "react-router-dom";
import { LogOut, Menu, Moon, Search, Sun, User as UserIcon } from "lucide-react";
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
