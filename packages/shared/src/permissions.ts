/**
 * The permission catalogue — the single source of truth for authorization.
 *
 * This file is imported by BOTH the API (to build `requirePermission` guards) and the web
 * app (to hide sidebar entries and disable actions). That is deliberate: if the two ever
 * drifted, the UI would offer buttons the server refuses, or worse, hide a control while
 * the endpoint stayed open.
 *
 * Roles are NOT hard-coded gates. A role is a database row holding an array of these
 * strings, editable by a SuperAdmin at runtime. The constants below are the vocabulary;
 * the Role documents are the policy. The only role name the code ever special-cases is
 * SUPER_ADMIN, and only for the handful of actions reserved to it.
 */

export const PERMISSIONS = {
  // ── Finance: payments ────────────────────────────────────────────────────
  "finance.payment.create": "Create Payment In / Payment Out",
  "finance.payment.view": "View payments",
  "finance.payment.edit": "Edit an unposted payment",
  "finance.payment.delete": "Discard a draft payment",
  "finance.payment.reverse": "Reverse a posted payment",
  "finance.payment.approve": "Approve a pending payment",

  // ── Finance: expenses ────────────────────────────────────────────────────
  "finance.expense.create": "Record an expense",
  "finance.expense.view": "View expenses",
  "finance.expense.edit": "Edit an unposted expense",
  "finance.expense.delete": "Discard a draft expense",
  "finance.expense.approve": "Approve an expense",
  "finance.expense.reverse": "Reverse a posted expense",
  "finance.expense.manageCategories": "Create and edit expense heads",

  // ── Finance: income ──────────────────────────────────────────────────────
  "finance.income.create": "Record income",
  "finance.income.view": "View income",
  "finance.income.approve": "Approve income entries",
  "finance.income.reverse": "Reverse a posted income entry",
  "finance.income.manageHeads": "Create and edit income heads",

  // ── Banking ──────────────────────────────────────────────────────────────
  "finance.bank.create": "Create banks and bank accounts",
  "finance.bank.view": "View banks and bank accounts",
  "finance.bank.edit": "Edit bank account details",
  "finance.bank.viewFull": "See unmasked account numbers",
  "finance.bank.transfer": "Initiate a bank-to-bank transfer",
  "finance.bank.reconcile": "Perform bank reconciliation",
  "finance.bank.statement.import": "Import a bank statement",

  // ── Cash ─────────────────────────────────────────────────────────────────
  "finance.cash.view": "View cash accounts and cash book",
  "finance.cash.manage": "Create and edit cash accounts",
  "finance.cash.tally": "Perform the daily cash tally",

  // ── Parties, khata and credit ────────────────────────────────────────────
  "finance.party.create": "Create parties",
  "finance.party.view": "View parties and party ledgers",
  "finance.party.edit": "Edit party master data",
  "finance.party.adjust": "Post a party balance adjustment",
  "finance.party.creditLimit": "Set and change credit limits",
  "finance.khata.view": "View Digital Khata",
  "finance.khata.entry": "Add khata debit / credit entries",
  "finance.khata.share": "Share or export a party statement",

  // ── Bachat Khata (savings) ───────────────────────────────────────────────
  "finance.savings.view": "View savings accounts",
  "finance.savings.manage": "Open and close savings accounts",
  "finance.savings.transact": "Record deposits and withdrawals",
  "finance.savings.interest": "Post interest and bonus",

  // ── Settlement ───────────────────────────────────────────────────────────
  "finance.settlement.view": "View settlements",
  "finance.settlement.create": "Create a settlement",
  "finance.settlement.approve": "Approve a settlement",

  // ── Adjustments ──────────────────────────────────────────────────────────
  "finance.adjustment.create": "Create a balance adjustment",
  "finance.adjustment.approve": "Approve a high-value adjustment",

  // ── Charges and commission ───────────────────────────────────────────────
  "finance.charges.view": "View charge and commission rules",
  "finance.charges.manage": "Create and edit charge rules",

  // ── DayBook and ledger ───────────────────────────────────────────────────
  "finance.daybook.view": "View the DayBook",
  "finance.ledger.view": "View ledger accounts and entries",

  // ── Reporting ────────────────────────────────────────────────────────────
  "reports.view": "View financial reports",
  "reports.export": "Export reports to PDF / Excel / CSV",
  "reports.pnl": "View Profit & Loss",
  "reports.balanceSheet": "View the Balance Sheet",
  "reports.trialBalance": "View the Trial Balance",

  // ── Administration ───────────────────────────────────────────────────────

  "users.create": "Create users",
  "users.view": "View users",
  "users.edit": "Edit users",
  "users.disable": "Disable a user",
  "users.resetPassword": "Reset another user's password",

  "roles.view": "View roles and their permissions",
  "roles.manage": "Create roles and change role permissions",

  "approvals.view": "View the approval queue",
  "approvals.act": "Approve or reject items in the queue",

  "audit.view": "View audit logs",
  "audit.export": "Export audit logs",

  "period.view": "View financial periods",
  "period.manage": "Open, close and lock financial periods",

  "settings.view": "View system settings",
  "settings.manage": "Change system settings",

  "import.run": "Run data imports",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}

export function describePermission(p: Permission): string {
  return PERMISSIONS[p];
}

/* -------------------------------------------------------------------------- */
/* Grouping — used to render the role editor                                  */
/* -------------------------------------------------------------------------- */

export const PERMISSION_GROUPS: Array<{ key: string; label: string; match: RegExp }> = [
  { key: "payments", label: "Payments", match: /^finance\.payment\./ },
  { key: "expenses", label: "Expenses", match: /^finance\.expense\./ },
  { key: "income", label: "Income", match: /^finance\.income\./ },
  { key: "banking", label: "Banking", match: /^finance\.bank\./ },
  { key: "cash", label: "Cash", match: /^finance\.cash\./ },
  { key: "parties", label: "Parties & Khata", match: /^finance\.(party|khata)\./ },
  { key: "savings", label: "Bachat Khata", match: /^finance\.savings\./ },
  { key: "settlement", label: "Settlement", match: /^finance\.settlement\./ },
  { key: "adjustment", label: "Adjustments", match: /^finance\.adjustment\./ },
  { key: "charges", label: "Charges & Commission", match: /^finance\.charges\./ },
  { key: "ledger", label: "DayBook & Ledger", match: /^finance\.(daybook|ledger)\./ },
  { key: "reports", label: "Reports", match: /^reports\./ },
  { key: "users", label: "Users", match: /^users\./ },
  { key: "roles", label: "Roles & Permissions", match: /^roles\./ },
  { key: "approvals", label: "Approvals", match: /^approvals\./ },
  { key: "audit", label: "Audit", match: /^audit\./ },
  { key: "period", label: "Financial Period", match: /^period\./ },
  { key: "settings", label: "Settings", match: /^settings\.|^import\./ },
];

export function groupPermissions(): Array<{ key: string; label: string; permissions: Permission[] }> {
  return PERMISSION_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    permissions: ALL_PERMISSIONS.filter((p) => g.match.test(p)),
  })).filter((g) => g.permissions.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Seeded system roles                                                        */
/* -------------------------------------------------------------------------- */

export const SYSTEM_ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  BRANCH_ADMIN: "BRANCH_ADMIN",
  ACCOUNTANT: "ACCOUNTANT",
  VIEWER: "VIEWER",
} as const;

export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/**
 * Starting permission sets for the seeded roles. These are a *starting point* written to
 * the database at seed time, not a runtime authority — once seeded, a SuperAdmin can
 * change any of them from the Roles & Permissions screen.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRole, Permission[]> = {
  // Everything.
  SUPER_ADMIN: ALL_PERMISSIONS,

  // Full operational control over day-to-day finance, short of administering the system.
  BRANCH_ADMIN: [
    "finance.payment.create", "finance.payment.view", "finance.payment.edit",
    "finance.payment.delete", "finance.payment.reverse", "finance.payment.approve",
    "finance.expense.create", "finance.expense.view", "finance.expense.edit",
    "finance.expense.delete", "finance.expense.approve", "finance.expense.reverse",
    "finance.expense.manageCategories",
    "finance.income.create", "finance.income.view", "finance.income.approve",
    "finance.income.reverse", "finance.income.manageHeads",
    "finance.bank.create", "finance.bank.view", "finance.bank.edit", "finance.bank.viewFull",
    "finance.bank.transfer", "finance.bank.reconcile", "finance.bank.statement.import",
    "finance.cash.view", "finance.cash.manage", "finance.cash.tally",
    "finance.party.create", "finance.party.view", "finance.party.edit",
    "finance.party.adjust", "finance.party.creditLimit",
    "finance.khata.view", "finance.khata.entry", "finance.khata.share",
    "finance.savings.view", "finance.savings.manage", "finance.savings.transact",
    "finance.savings.interest",
    "finance.settlement.view", "finance.settlement.create", "finance.settlement.approve",
    "finance.adjustment.create",
    "finance.charges.view",
    "finance.daybook.view", "finance.ledger.view",
    "reports.view", "reports.export", "reports.pnl", "reports.balanceSheet",
    "reports.trialBalance",
    "users.create", "users.view", "users.edit", "users.disable",
    "approvals.view", "approvals.act",
    "audit.view",
    "period.view",
    "settings.view",
    "import.run",
  ],

  // Operational finance. Notably absent: approve, reverse, credit limits, user
  // management, period control. §4 of the brief is explicit that an accountant must not
  // silently inherit administrative power.
  ACCOUNTANT: [
    "finance.payment.create", "finance.payment.view", "finance.payment.edit",
    "finance.expense.create", "finance.expense.view", "finance.expense.edit",
    "finance.income.create", "finance.income.view",
    "finance.bank.view", "finance.bank.transfer", "finance.bank.reconcile",
    "finance.cash.view", "finance.cash.tally",
    "finance.party.create", "finance.party.view", "finance.party.edit",
    "finance.khata.view", "finance.khata.entry",
    "finance.savings.view", "finance.savings.transact",
    "finance.settlement.view", "finance.settlement.create",
    "finance.adjustment.create",
    "finance.charges.view",
    "finance.daybook.view", "finance.ledger.view",
    "reports.view",
    "approvals.view",
    "period.view",
  ],

  // Read-only. Useful for auditors and owners who should never mutate the books.
  VIEWER: [
    "finance.payment.view", "finance.expense.view", "finance.income.view",
    "finance.bank.view", "finance.cash.view", "finance.party.view",
    "finance.khata.view", "finance.savings.view", "finance.settlement.view",
    "finance.charges.view", "finance.daybook.view", "finance.ledger.view",
    "reports.view", "reports.pnl", "reports.balanceSheet", "reports.trialBalance",
    "period.view",
  ],
};

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Does this permission set satisfy the requirement?
 *
 * Supports a trailing wildcard so a role can be granted `finance.payment.*`, and the
 * global `*` which only the SuperAdmin role should ever hold.
 */
export function hasPermission(granted: readonly string[], required: Permission): boolean {
  if (granted.includes("*")) return true;
  if (granted.includes(required)) return true;

  return granted.some((g) => {
    if (!g.endsWith(".*")) return false;
    return required.startsWith(g.slice(0, -1));
  });
}

export function hasAnyPermission(granted: readonly string[], required: Permission[]): boolean {
  return required.some((r) => hasPermission(granted, r));
}

export function hasAllPermissions(granted: readonly string[], required: Permission[]): boolean {
  return required.every((r) => hasPermission(granted, r));
}
