import { NavLink } from "react-router-dom";
import { Landmark, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAuth } from "@/features/auth/auth-context";
import { filterNavigation, isAvailable, type NavItem } from "./navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The sidebar (§44).
 *
 * Collapsible to an icon rail, because a data-dense DayBook wants the horizontal space
 * back. When collapsed, every item keeps a tooltip so the rail stays navigable — an icon
 * rail with no labels and no tooltips is a guessing game.
 */
export function Sidebar({
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  /** Called after a link is followed, so the mobile drawer can close itself. */
  onNavigate?: () => void;
}) {
  const { can } = useAuth();
  const sections = filterNavigation(can);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div
        className={cn(
          "flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent/15 ring-1 ring-sidebar-accent/25">
          <Landmark className="size-4 text-sidebar-accent" aria-hidden />
        </div>
        {!collapsed ? (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold tracking-tight">AMIRI Finance</div>
            <div className="truncate text-2xs uppercase tracking-widest text-sidebar-muted">
              Financial OS
            </div>
          </div>
        ) : null}
      </div>

      <ScrollArea className="flex-1">
        <nav className={cn("space-y-5 py-4", collapsed ? "px-2" : "px-3")} aria-label="Main">
          {sections.map((section) => (
            <div key={section.label} className="space-y-1">
              {!collapsed ? (
                <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-sidebar-muted">
                  {section.label}
                </div>
              ) : (
                <div className="mx-auto my-2 h-px w-6 bg-sidebar-border" aria-hidden />
              )}

              {section.items.map((item) => (
                <SidebarLink
                  key={item.to}
                  item={item}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          ))}
        </nav>
      </ScrollArea>

      {onToggleCollapsed ? (
        <div className="shrink-0 border-t border-sidebar-border p-2">
          <Button
            variant="ghost"
            size={collapsed ? "icon" : "sm"}
            onClick={onToggleCollapsed}
            className={cn(
              "text-sidebar-muted hover:bg-sidebar-border/60 hover:text-sidebar-foreground",
              collapsed ? "mx-auto" : "w-full justify-start gap-2",
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            {!collapsed ? <span>Collapse</span> : null}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SidebarLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const available = isAvailable(item);
  const Icon = item.icon;

  const base = cn(
    "group relative flex items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors",
    collapsed && "justify-center px-0",
  );

  /**
   * An unbuilt screen renders as a disabled row, never as a working link (§66).
   * Showing it keeps the product's shape legible; disabling it keeps the promise honest.
   */
  if (!available) {
    const content = (
      <div className={cn(base, "cursor-not-allowed text-sidebar-muted/55")} aria-disabled>
        <Icon className="size-4 shrink-0" aria-hidden />
        {!collapsed ? (
          <>
            <span className="truncate">{item.label}</span>
            <span className="ml-auto rounded-full border border-sidebar-border px-1.5 py-px text-[9px] font-medium uppercase tracking-wider">
              Soon
            </span>
          </>
        ) : null}
      </div>
    );

    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right">
          {item.label} — arrives in phase {item.phase}
        </TooltipContent>
      </Tooltip>
    );
  }

  const link = (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          base,
          isActive
            ? "bg-sidebar-accent/15 font-medium text-sidebar-foreground"
            : "text-sidebar-foreground/75 hover:bg-sidebar-border/50 hover:text-sidebar-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* An active indicator that is not colour-only. */}
          {isActive ? (
            <span
              className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-sidebar-accent"
              aria-hidden
            />
          ) : null}
          <Icon
            className={cn("size-4 shrink-0", isActive ? "text-sidebar-accent" : "opacity-80")}
            aria-hidden
          />
          {!collapsed ? <span className="truncate">{item.label}</span> : null}
        </>
      )}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}
