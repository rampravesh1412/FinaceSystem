import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight, BadgeIndianRupee, BookOpen, CalendarClock, CalendarRange, ClipboardCheck, Coins, CreditCard, FileBarChart, FileSpreadsheet, Landmark, LayoutDashboard, Notebook, PiggyBank, Receipt, ScrollText, Scale, Settings, ShieldCheck, TrendingDown, TrendingUp, Users, Wallet, Percent, Handshake, ListChecks, History, Upload, FolderTree, Layers,
} from "lucide-react";
import type { Permission } from "@amiri/shared";

/**
 * The sidebar (§44).
 *
 * Each entry declares the permission that reveals it. `filterNavigation` drops anything
 * the signed-in user cannot use, and then drops any section left empty — so an accountant
 * never sees an "Administration" heading with nothing beneath it.
 *
 * This is presentation only. Every route behind these links is independently guarded on
 * the server; hiding a link is a courtesy, not a control.
 *
 * `phase` marks what is not yet built. Those entries render as disabled with a "Soon"
 * chip rather than being hidden, so the shape of the finished product is visible and
 * nobody clicks through to a blank screen and assumes it is broken. §66 is explicit that
 * unbuilt functionality must not be faked — a disabled link states the truth.
 */
export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  permission?: Permission;
  /** Implementation phase. Anything above 1 is not wired to a backend yet. */
  phase: number;
  /** Keywords for the command palette. */
  keywords?: string[];
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", to: "/", icon: LayoutDashboard, phase: 1, keywords: ["home", "summary"] },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "DayBook", to: "/daybook", icon: Notebook, permission: "finance.daybook.view", phase: 3, keywords: ["day book", "journal"] },
      { label: "Payment In", to: "/payment-in", icon: TrendingUp, permission: "finance.payment.view", phase: 3, keywords: ["receipt", "collection"] },
      { label: "Payment Out", to: "/payment-out", icon: TrendingDown, permission: "finance.payment.view", phase: 3, keywords: ["pay", "disburse"] },
      { label: "Bank Transfer", to: "/bank-transfers", icon: ArrowLeftRight, permission: "finance.bank.transfer", phase: 3, keywords: ["neft", "rtgs", "imps"] },
      { label: "Cash Book", to: "/cash-book", icon: Wallet, permission: "finance.cash.view", phase: 7, keywords: ["statement", "drawer"] },
      { label: "Daily Cash Tally", to: "/cash-tally", icon: Scale, permission: "finance.cash.view", phase: 5, keywords: ["count", "drawer", "short", "excess"] },
      { label: "Bank Book", to: "/bank-book", icon: BookOpen, permission: "finance.bank.view", phase: 7, keywords: ["statement"] },
    ],
  },
  {
    label: "Ledger",
    items: [
      { label: "Parties", to: "/parties", icon: Users, permission: "finance.party.view", phase: 2, keywords: ["customer", "vendor", "supplier"] },
      { label: "Digital Khata", to: "/khata", icon: BadgeIndianRupee, permission: "finance.khata.view", phase: 4, keywords: ["lena", "dena", "udhaar"] },
      { label: "Credit", to: "/credit", icon: CreditCard, permission: "finance.party.view", phase: 4, keywords: ["outstanding", "overdue", "aging"] },
      { label: "Bachat Khata", to: "/savings", icon: PiggyBank, permission: "finance.savings.view", phase: 4, keywords: ["savings", "deposit"] },
      { label: "Savings Ledger", to: "/savings-ledger", icon: BookOpen, permission: "finance.ledger.view", phase: 10, keywords: ["member statement"] },
      { label: "Party Ledger", to: "/party-ledger", icon: ScrollText, permission: "finance.ledger.view", phase: 7, keywords: ["statement"] },
      { label: "General Ledger", to: "/ledger", icon: Layers, permission: "finance.ledger.view", phase: 10, keywords: ["chart of accounts", "any account", "suspense", "equity"] },
      { label: "Import Parties", to: "/import", icon: Upload, permission: "import.run", phase: 7, keywords: ["bulk", "csv", "excel", "upload", "migrate"] },
    ],
  },
  {
    label: "Expenses & Income",
    items: [
      { label: "Expenses", to: "/expenses", icon: Receipt, permission: "finance.expense.view", phase: 3, keywords: ["salary", "rent", "panel", "domain"] },
      { label: "Income", to: "/income", icon: Coins, permission: "finance.income.view", phase: 3 },
      { label: "Expense & Income Heads", to: "/heads", icon: FolderTree, permission: "finance.expense.view", phase: 10, keywords: ["category", "head", "chart of accounts", "salary", "rent"] },
      { label: "Expense Ledger", to: "/expense-ledger", icon: Receipt, permission: "finance.ledger.view", phase: 10, keywords: ["head statement", "spend by head"] },
      { label: "Income Ledger", to: "/income-ledger", icon: Coins, permission: "finance.ledger.view", phase: 10, keywords: ["head statement", "earned by head"] },
      { label: "Charges & Commission", to: "/charges", icon: Percent, permission: "finance.charges.view", phase: 7, keywords: ["distributor", "rate"] },
    ],
  },
  {
    label: "Banking",
    items: [
      { label: "Banks", to: "/banks", icon: Landmark, permission: "finance.bank.view", phase: 2, keywords: ["hdfc", "icici", "sbi", "axis"] },
      { label: "Accounts", to: "/bank-accounts", icon: CreditCard, permission: "finance.bank.view", phase: 2, keywords: ["bank account", "cash", "drawer", "balance"] },
      { label: "Reconciliation", to: "/reconciliation", icon: ListChecks, permission: "finance.bank.reconcile", phase: 4, keywords: ["match", "statement"] },
      { label: "Settlements", to: "/settlements", icon: Handshake, permission: "finance.settlement.view", phase: 4 },
    ],
  },
  {
    label: "Reports",
    items: [
      { label: "Financial Reports", to: "/reports", icon: FileBarChart, permission: "reports.view", phase: 5 },
      { label: "Profit & Loss", to: "/reports/profit-loss", icon: TrendingUp, permission: "reports.pnl", phase: 5, keywords: ["p&l", "pnl"] },
      { label: "Monthly History", to: "/reports/monthly-history", icon: CalendarRange, permission: "reports.pnl", phase: 5, keywords: ["monthly", "history", "trend", "month"] },
      { label: "Balance Sheet", to: "/reports/balance-sheet", icon: Scale, permission: "reports.balanceSheet", phase: 5 },
      { label: "Trial Balance", to: "/reports/trial-balance", icon: FileSpreadsheet, permission: "reports.trialBalance", phase: 5 },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Users", to: "/users", icon: Users, permission: "users.view", phase: 1, keywords: ["staff", "team"] },
      { label: "Roles & Permissions", to: "/roles", icon: ShieldCheck, permission: "roles.view", phase: 1, keywords: ["access", "rbac"] },
      { label: "Approvals", to: "/approvals", icon: ClipboardCheck, permission: "approvals.view", phase: 6 },
      { label: "Audit Logs", to: "/audit", icon: History, permission: "audit.view", phase: 6, keywords: ["trail", "activity"] },
      { label: "Financial Period", to: "/periods", icon: CalendarClock, permission: "period.view", phase: 6, keywords: ["year end", "close"] },
      { label: "Settings", to: "/settings", icon: Settings, permission: "settings.view", phase: 8, keywords: ["organisation", "fiscal year", "approval thresholds", "gstin"] },
    ],
  },
];

/** Drop what the user cannot access, then drop any section that empties out. */
export function filterNavigation(
  can: (permission: Permission) => boolean,
): NavSection[] {
  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((section) => section.items.length > 0);
}

/** The phase currently implemented end to end. */
export const CURRENT_PHASE = 10;

export function isAvailable(item: NavItem): boolean {
  return item.phase <= CURRENT_PHASE;
}
