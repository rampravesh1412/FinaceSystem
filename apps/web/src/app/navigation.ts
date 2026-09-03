import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight, BadgeIndianRupee, BookOpen, CalendarClock, CalendarRange, ClipboardCheck,
  Coins, CreditCard, FileBarChart, FileSpreadsheet, Handshake, History, Landmark,
  LayoutDashboard, Layers, ListChecks, Notebook, Percent, PiggyBank, Receipt, Scale,
  ScrollText, Settings, ShieldCheck, Sliders, TrendingDown, TrendingUp, Upload, Users, Wallet,
  FolderTree, HelpCircle,
} from "lucide-react";
import {
  MODULE_CATALOG,
  groupModules,
  type ModuleDefinition,
  type Permission,
  type PermissionGroup,
} from "@amiri/shared";

/**
 * The sidebar (§44).
 *
 * DERIVED from the permission catalogue rather than written alongside it. When the two were
 * separate lists they disagreed: five ledger entries pointed at one `finance.ledger.view`,
 * so they could not be granted apart, and the Dashboard named no permission at all and was
 * therefore visible to everybody. A menu entry and the permission that reveals it are the
 * same fact, so they are now written once.
 *
 * This is presentation only. Every route behind these links is independently guarded on the
 * server; hiding a link is a courtesy, not a control.
 *
 * `phase` marks what is not yet built. Those entries render as disabled with a "Soon" chip
 * rather than being hidden, so the shape of the finished product is visible and nobody
 * clicks through to a blank screen and assumes it is broken (§66).
 */

/** Icon names live in the catalogue as strings, because it is shared with the server. */
const ICONS: Record<string, LucideIcon> = {
  ArrowLeftRight, BadgeIndianRupee, BookOpen, CalendarClock, CalendarRange, ClipboardCheck,
  Coins, CreditCard, FileBarChart, FileSpreadsheet, FolderTree, Handshake, History, Landmark,
  LayoutDashboard, Layers, ListChecks, Notebook, Percent, PiggyBank, Receipt, Scale,
  ScrollText, Settings, ShieldCheck, Sliders, TrendingDown, TrendingUp, Upload, Users, Wallet,
};

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** The permission that reveals it — always the module's own `view`. */
  permission: Permission;
  phase: number;
  keywords?: readonly string[];
}

export interface NavSection {
  label: PermissionGroup;
  items: NavItem[];
}

function toNavItem(m: ModuleDefinition): NavItem {
  return {
    label: m.label,
    to: m.route,
    // An unmapped icon name renders a placeholder rather than crashing the whole shell.
    icon: ICONS[m.icon] ?? HelpCircle,
    permission: `${m.key}.view` as Permission,
    phase: m.phase,
    keywords: m.keywords,
  };
}

export const NAVIGATION: NavSection[] = groupModules()
  .map((g) => ({
    label: g.group,
    // A module with no `view` has nothing to navigate to.
    items: g.modules.filter((m) => m.actions.includes("view")).map(toNavItem),
  }))
  .filter((s) => s.items.length > 0);

/** Drop what the user cannot access, then drop any section that empties out. */
export function filterNavigation(can: (permission: Permission) => boolean): NavSection[] {
  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(item.permission)),
  })).filter((section) => section.items.length > 0);
}

/** The phase currently implemented end to end. */
export const CURRENT_PHASE = 10;

export function isAvailable(item: NavItem): boolean {
  return item.phase <= CURRENT_PHASE;
}

/**
 * The permission guarding a route, for the router's own checks.
 *
 * Longest-prefix match, so `/reports/profit-loss` resolves to Profit & Loss rather than to
 * Financial Reports at `/reports`.
 */
const ROUTE_PERMISSIONS: Array<{ route: string; permission: Permission }> = [
  ...(MODULE_CATALOG as readonly ModuleDefinition[])
    .filter((m) => m.actions.includes("view"))
    .map((m) => ({ route: m.route, permission: `${m.key}.view` as Permission })),
].sort((a, b) => b.route.length - a.route.length);

export function permissionForRoute(pathname: string): Permission | undefined {
  return ROUTE_PERMISSIONS.find(
    (r) => r.route !== "/" && (pathname === r.route || pathname.startsWith(`${r.route}/`)),
  )?.permission;
}
