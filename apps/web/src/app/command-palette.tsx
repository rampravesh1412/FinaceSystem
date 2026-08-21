import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Moon, Sun, LogOut } from "lucide-react";
import { useAuth } from "@/features/auth/auth-context";
import { useTheme } from "@/hooks/use-theme";
import { filterNavigation, isAvailable } from "./navigation";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList, CommandSeparator, CommandShortcut,
} from "@/components/ui/command";

/**
 * Command palette (§30).
 *
 * Phase 1 indexes navigation and app actions. Phases 2+ add server-backed search over
 * transaction ids, parties, banks, accounts and references — that will be a debounced
 * query against a dedicated `/search` endpoint rather than a client-side filter, because
 * the searchable set is far too large to ship to the browser (§69).
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { can, logout } = useAuth();
  const { theme, toggle } = useTheme();

  const sections = React.useMemo(
    () =>
      filterNavigation(can)
        .map((section) => ({ ...section, items: section.items.filter(isAvailable) }))
        .filter((section) => section.items.length > 0),
    [can],
  );

  const run = React.useCallback(
    (action: () => void) => {
      onOpenChange(false);
      // Deferred so the dialog's close animation and focus restore finish before the
      // route changes — otherwise focus lands on an unmounted node.
      requestAnimationFrame(action);
    },
    [onOpenChange],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search pages and actions…" />
      <CommandList>
        <CommandEmpty>
          Nothing matched.
          <div className="mt-1 text-2xs">
            Transaction, party and account search arrives with phase&nbsp;2.
          </div>
        </CommandEmpty>

        {sections.map((section) => (
          <CommandGroup key={section.label} heading={section.label}>
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.to}
                  value={`${section.label} ${item.label} ${(item.keywords ?? []).join(" ")}`}
                  onSelect={() => run(() => navigate(item.to))}
                >
                  <Icon aria-hidden />
                  <span>{item.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem value="theme dark light appearance" onSelect={() => run(toggle)}>
            {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
            <span>Switch to {theme === "dark" ? "light" : "dark"} mode</span>
          </CommandItem>
          <CommandItem
            value="sign out logout"
            onSelect={() => run(() => void logout().then(() => navigate("/login", { replace: true })))}
          >
            <LogOut aria-hidden />
            <span>Sign out</span>
            <CommandShortcut>⇧⌘Q</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** Registers the ⌘K / Ctrl-K shortcut and owns the palette's open state. */
export function useCommandPalette() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return { open, setOpen };
}
