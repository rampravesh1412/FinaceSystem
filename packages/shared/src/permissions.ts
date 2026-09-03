/**
 * The permission catalogue — the single source of truth for authorization.
 *
 * One entry per thing in the left sidebar, and each entry drives three things at once:
 *
 *   1. the sidebar   (label, icon, route, order, group)
 *   2. the API guard (requirePermission("payment_in.approve"))
 *   3. the UI guard  (<Can permission="payment_in.approve">)
 *
 * That one-to-one relationship is the point of the file. The previous catalogue was a flat
 * list of capability strings that did NOT line up with the menu, and it failed in both
 * directions: five ledger screens shared `finance.ledger.view`, so General Ledger could not
 * be granted without Expense Ledger; and seventeen keys — every per-module `approve`,
 * `finance.party.creditLimit`, `finance.khata.entry` among them — were grantable on the
 * Roles screen while no route ever checked them, so ticking the box did nothing and the
 * real gate was something else entirely.
 *
 * A permission is `<module>.<action>`. Modules are nouns from the menu; actions are the
 * verbs that module genuinely supports, which is why `actions` is per-module rather than a
 * fixed seven — a Balance Sheet cannot be approved and a Broadcast cannot be edited.
 *
 * Roles are NOT hard-coded gates. A role is a database row holding these strings, editable
 * by a SuperAdmin at runtime. The constants below are the vocabulary; the Role documents
 * are the policy. The only role the code special-cases is a super admin, and only for the
 * handful of actions reserved to it.
 */

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

export const ACTION = {
  VIEW: "view",
  CREATE: "create",
  EDIT: "edit",
  DELETE: "delete",
  APPROVE: "approve",
  REJECT: "reject",
  EXPORT: "export",

  /**
   * Beyond CRUD — and each one is here because collapsing it into CRUD would have merged
   * two decisions a desk makes separately.
   */
  /** Post a reversing entry against something already on the books. Not a delete: §25 and
   *  §62 forbid deletes outright, and the correction is itself a posting. */
  REVERSE: "reverse",
  /** See unmasked bank account digits. Reading the number is a different act from reading
   *  the row it sits on. */
  VIEW_FULL: "viewFull",
  /** Record a member deposit or withdrawal, as distinct from opening the account. */
  TRANSACT: "transact",
  /** Post interest or bonus — money created by a rule rather than handed over. */
  INTEREST: "interest",
  /** Load an external file into the system: a bank statement, a party list. */
  IMPORT: "import",
  /** Set another person's password. */
  RESET_PASSWORD: "resetPassword",
} as const;

export type PermissionAction = (typeof ACTION)[keyof typeof ACTION];

export const ACTION_LABEL: Record<PermissionAction, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  approve: "Approve",
  reject: "Reject",
  export: "Export",
  reverse: "Reverse",
  viewFull: "See full number",
  transact: "Transact",
  interest: "Post interest",
  import: "Import",
  resetPassword: "Reset password",
};

/** The order actions appear as columns in the role matrix. */
export const ACTION_ORDER: PermissionAction[] = [
  "view", "create", "edit", "delete", "approve", "reject", "reverse",
  "transact", "interest", "import", "export", "viewFull", "resetPassword",
];

const V = ACTION.VIEW;
const C = ACTION.CREATE;
const E = ACTION.EDIT;
const D = ACTION.DELETE;
const A = ACTION.APPROVE;
const R = ACTION.REJECT;
const X = ACTION.EXPORT;
const RV = ACTION.REVERSE;

/* -------------------------------------------------------------------------- */
/* Modules                                                                    */
/* -------------------------------------------------------------------------- */

export type PermissionGroup =
  | "Overview"
  | "Finance"
  | "Ledger"
  | "Expenses & Income"
  | "Banking"
  | "Reports"
  | "Administration";

export interface ModuleDefinition {
  /** Stable machine key. Never rename one — migrate instead. */
  key: string;
  label: string;
  description: string;
  group: PermissionGroup;
  /** The actions this module meaningfully supports. The matrix renders only these. */
  actions: readonly PermissionAction[];
  /** Lucide icon name; the web maps it to a component. */
  icon: string;
  route: string;
  order: number;
  /** Guards its APIs but has no sidebar entry of its own. */
  hideInMenu?: boolean;
  /** Only a super admin may hold this, however it was granted. */
  superAdminOnly?: boolean;
  /** Implementation phase (§66) — above CURRENT_PHASE renders disabled, not hidden. */
  phase: number;
  /** Command-palette keywords. */
  keywords?: readonly string[];
}

export const MODULE_CATALOG = [
  /* ── Overview ─────────────────────────────────────────────────────────── */
  {
    key: "dashboard",
    label: "Dashboard",
    description: "Landing overview with balances, recent activity and alerts",
    group: "Overview",
    /**
     * Gated at all, which it was not.
     *
     * The Dashboard previously carried no permission, so every role saw it — including a
     * role created specifically to see one screen. It summarises the whole business, so it
     * is exactly the screen that should be a decision.
     */
    actions: [V, X],
    icon: "LayoutDashboard",
    route: "/",
    order: 10,
    phase: 1,
    keywords: ["home", "summary"],
  },

  /* ── Finance ──────────────────────────────────────────────────────────── */
  {
    key: "daybook",
    label: "DayBook",
    description: "Every transaction of the day in one chronological register",
    group: "Finance",
    actions: [V, X],
    icon: "Notebook",
    route: "/daybook",
    order: 20,
    phase: 3,
    keywords: ["day book", "journal"],
  },
  {
    /**
     * Payment In and Payment Out are separate modules, not one `payments` key.
     *
     * They used to share `finance.payment.view`, which made "may take receipts, may not
     * disburse" unexpressible — the single most ordinary split on a finance desk.
     */
    key: "payment_in",
    label: "Payment In",
    description: "Money received from a party, and the receipts against it",
    group: "Finance",
    actions: [V, C, E, D, A, R, RV, X],
    icon: "TrendingUp",
    route: "/payment-in",
    order: 30,
    phase: 3,
    keywords: ["receipt", "collection"],
  },
  {
    key: "payment_out",
    label: "Payment Out",
    description: "Money paid to a party, and the vouchers against it",
    group: "Finance",
    actions: [V, C, E, D, A, R, RV, X],
    icon: "TrendingDown",
    route: "/payment-out",
    order: 40,
    phase: 3,
    keywords: ["pay", "disburse"],
  },
  {
    key: "bank_transfer",
    label: "Bank Transfer",
    description: "Moving money between our own accounts",
    group: "Finance",
    actions: [V, C, A, R, RV],
    icon: "ArrowLeftRight",
    route: "/bank-transfers",
    order: 50,
    phase: 3,
    keywords: ["neft", "rtgs", "imps"],
  },
  {
    key: "cash_book",
    label: "Cash Book",
    description: "Statement of every cash drawer",
    group: "Finance",
    actions: [V, X],
    icon: "Wallet",
    route: "/cash-book",
    order: 60,
    phase: 7,
    keywords: ["statement", "drawer"],
  },
  {
    key: "cash_tally",
    label: "Daily Cash Tally",
    description: "Counting the drawer against the books, and recording short or excess",
    group: "Finance",
    actions: [V, C, X],
    icon: "Scale",
    route: "/cash-tally",
    order: 70,
    phase: 5,
    keywords: ["count", "drawer", "short", "excess"],
  },
  {
    key: "bank_book",
    label: "Bank Book",
    description: "Statement of every bank account",
    group: "Finance",
    actions: [V, X],
    icon: "BookOpen",
    route: "/bank-book",
    order: 80,
    phase: 7,
    keywords: ["statement"],
  },

  /* ── Ledger ───────────────────────────────────────────────────────────── */
  {
    key: "parties",
    label: "Parties",
    description: "Customers, vendors and distributors — the master record",
    group: "Ledger",
    actions: [V, C, E, D, X],
    icon: "Users",
    route: "/parties",
    order: 100,
    phase: 2,
    keywords: ["customer", "vendor", "supplier"],
  },
  {
    key: "khata",
    label: "Digital Khata",
    description: "Running lena-dena account with a party",
    group: "Ledger",
    // CREATE is adding a debit or credit line; EXPORT is sharing the statement.
    actions: [V, C, X],
    icon: "BadgeIndianRupee",
    route: "/khata",
    order: 110,
    phase: 4,
    keywords: ["lena", "dena", "udhaar"],
  },
  {
    /**
     * Credit is its own module because `finance.party.creditLimit` was a permission that
     * enforced nothing — the limit was writable by anyone who could edit a party. A credit
     * limit is the ceiling on what the business is willing to lose to one customer, and
     * that is not the same decision as correcting their phone number.
     */
    key: "credit",
    label: "Credit",
    description: "Outstanding, ageing, and the credit limit each party is allowed",
    group: "Ledger",
    actions: [V, E, X],
    icon: "CreditCard",
    route: "/credit",
    order: 120,
    phase: 4,
    keywords: ["outstanding", "overdue", "aging", "limit"],
  },
  {
    key: "savings",
    label: "Bachat Khata",
    description: "Member savings accounts, their deposits and their interest",
    group: "Ledger",
    // Savings postings reach the approval queue and can be reversed like any other.
    actions: [V, C, E, A, R, RV, ACTION.TRANSACT, ACTION.INTEREST, X],
    icon: "PiggyBank",
    route: "/savings",
    order: 130,
    phase: 4,
    keywords: ["savings", "deposit"],
  },
  {
    key: "savings_ledger",
    label: "Savings Ledger",
    description: "Member-by-member savings statement",
    group: "Ledger",
    actions: [V, X],
    icon: "BookOpen",
    route: "/savings-ledger",
    order: 140,
    phase: 10,
    keywords: ["member statement"],
  },
  {
    key: "party_ledger",
    label: "Party Ledger",
    description: "Statement of one party's account",
    group: "Ledger",
    actions: [V, X],
    icon: "ScrollText",
    route: "/party-ledger",
    order: 150,
    phase: 7,
    keywords: ["statement"],
  },
  {
    key: "general_ledger",
    label: "General Ledger",
    description: "Any account in the chart, including suspense and equity",
    group: "Ledger",
    actions: [V, X],
    icon: "Layers",
    route: "/ledger",
    order: 160,
    phase: 10,
    keywords: ["chart of accounts", "any account", "suspense", "equity"],
  },
  {
    key: "import_parties",
    label: "Import Parties",
    description: "Bulk-load parties from a spreadsheet",
    group: "Ledger",
    actions: [V, ACTION.IMPORT],
    icon: "Upload",
    route: "/import",
    order: 170,
    phase: 7,
    keywords: ["bulk", "csv", "excel", "upload", "migrate"],
  },
  {
    /**
     * Off the menu, and deliberately not merged into Khata.
     *
     * An adjustment moves a balance without money changing hands, which is the one posting
     * with no external evidence behind it. It is raised from the Khata and Party screens,
     * so it has no sidebar entry — but it keeps its own key so that "may correct a balance"
     * stays a grant somebody made rather than a side effect of holding Khata.
     */
    key: "adjustments",
    label: "Balance Adjustments",
    description: "Correcting a balance without a money movement behind it",
    group: "Ledger",
    actions: [V, C, A, R, RV],
    icon: "Sliders",
    route: "/khata",
    order: 175,
    hideInMenu: true,
    phase: 4,
    keywords: ["adjust", "correction", "write off"],
  },

  /* ── Expenses & Income ────────────────────────────────────────────────── */
  {
    key: "expenses",
    label: "Expenses",
    description: "What the business spent, by head",
    group: "Expenses & Income",
    actions: [V, C, E, D, A, R, RV, X],
    icon: "Receipt",
    route: "/expenses",
    order: 200,
    phase: 3,
    keywords: ["salary", "rent", "panel", "domain"],
  },
  {
    key: "income",
    label: "Income",
    description: "What the business earned, by head",
    group: "Expenses & Income",
    actions: [V, C, E, D, A, R, RV, X],
    icon: "Coins",
    route: "/income",
    order: 210,
    phase: 3,
  },
  {
    /**
     * Heads is its own module. It shared `finance.expense.view` with Expenses, which meant
     * anyone who could read a spend figure could also open the chart of heads — and the
     * chart is what every future posting is classified against.
     */
    key: "heads",
    label: "Expense & Income Heads",
    description: "The chart of expense and income heads every posting is classified against",
    group: "Expenses & Income",
    actions: [V, C, E, D],
    icon: "FolderTree",
    route: "/heads",
    order: 220,
    phase: 10,
    keywords: ["category", "head", "chart of accounts", "salary", "rent"],
  },
  {
    key: "expense_ledger",
    label: "Expense Ledger",
    description: "Statement of one expense head",
    group: "Expenses & Income",
    actions: [V, X],
    icon: "Receipt",
    route: "/expense-ledger",
    order: 230,
    phase: 10,
    keywords: ["head statement", "spend by head"],
  },
  {
    key: "income_ledger",
    label: "Income Ledger",
    description: "Statement of one income head",
    group: "Expenses & Income",
    actions: [V, X],
    icon: "Coins",
    route: "/income-ledger",
    order: 240,
    phase: 10,
    keywords: ["head statement", "earned by head"],
  },
  {
    key: "charges",
    label: "Charges & Commission",
    description: "Charge rules, who bears them and where they land",
    group: "Expenses & Income",
    actions: [V, C, E, D],
    icon: "Percent",
    route: "/charges",
    order: 250,
    phase: 7,
    keywords: ["distributor", "rate", "commission"],
  },

  /* ── Banking ──────────────────────────────────────────────────────────── */
  {
    key: "banks",
    label: "Banks",
    description: "The banks the business holds accounts with",
    group: "Banking",
    actions: [V, C, E, D],
    icon: "Landmark",
    route: "/banks",
    order: 300,
    phase: 2,
    keywords: ["hdfc", "icici", "sbi", "axis"],
  },
  {
    key: "bank_accounts",
    label: "Accounts",
    description: "Bank accounts and cash drawers, their balances and their limits",
    group: "Banking",
    // VIEW_FULL is separate: reading the digits is not reading the row.
    actions: [V, C, E, D, ACTION.VIEW_FULL, X],
    icon: "CreditCard",
    route: "/bank-accounts",
    order: 310,
    phase: 2,
    keywords: ["bank account", "cash", "drawer", "balance"],
  },
  {
    key: "reconciliation",
    label: "Reconciliation",
    description: "Matching a bank statement against the books",
    group: "Banking",
    actions: [V, C, E, ACTION.IMPORT],
    icon: "ListChecks",
    route: "/reconciliation",
    order: 320,
    phase: 4,
    keywords: ["match", "statement"],
  },
  {
    key: "settlements",
    label: "Settlements",
    description: "Clearing what is owed, in whole or in part",
    group: "Banking",
    actions: [V, C, A, R, RV, X],
    icon: "Handshake",
    route: "/settlements",
    order: 330,
    phase: 4,
  },

  /* ── Reports ──────────────────────────────────────────────────────────── */
  {
    key: "reports",
    label: "Financial Reports",
    description: "Cash flow and the operational report set",
    group: "Reports",
    actions: [V, X],
    icon: "FileBarChart",
    route: "/reports",
    order: 400,
    phase: 5,
  },
  {
    key: "profit_loss",
    label: "Profit & Loss",
    description: "Income against expenses for a period",
    group: "Reports",
    actions: [V, X],
    icon: "TrendingUp",
    route: "/reports/profit-loss",
    order: 410,
    phase: 5,
    keywords: ["p&l", "pnl"],
  },
  {
    key: "monthly_history",
    label: "Monthly History",
    description: "Month-by-month trend of the P&L",
    group: "Reports",
    actions: [V, X],
    icon: "CalendarRange",
    route: "/reports/monthly-history",
    order: 420,
    phase: 5,
    keywords: ["monthly", "history", "trend", "month"],
  },
  {
    key: "balance_sheet",
    label: "Balance Sheet",
    description: "What the business owns and owes, as at a date",
    group: "Reports",
    actions: [V, X],
    icon: "Scale",
    route: "/reports/balance-sheet",
    order: 430,
    phase: 5,
  },
  {
    key: "trial_balance",
    label: "Trial Balance",
    description: "Every account's debit and credit, proving the books tie",
    group: "Reports",
    actions: [V, X],
    icon: "FileSpreadsheet",
    route: "/reports/trial-balance",
    order: 440,
    phase: 5,
  },

  /* ── Administration ───────────────────────────────────────────────────── */
  {
    key: "users",
    label: "Users",
    description: "Staff accounts, their role and their status",
    group: "Administration",
    actions: [V, C, E, D, ACTION.RESET_PASSWORD, X],
    icon: "Users",
    route: "/users",
    order: 500,
    phase: 1,
    keywords: ["staff", "team"],
  },
  {
    key: "roles",
    label: "Roles & Permissions",
    description: "Roles and the permission matrix that drives the whole system",
    group: "Administration",
    actions: [V, C, E, D],
    icon: "ShieldCheck",
    route: "/roles",
    order: 510,
    phase: 1,
    keywords: ["access", "rbac", "permission"],
  },
  {
    key: "approvals",
    label: "Approvals",
    description: "The queue of postings waiting on a second pair of eyes",
    group: "Administration",
    actions: [V, A, R],
    icon: "ClipboardCheck",
    route: "/approvals",
    order: 520,
    phase: 6,
  },
  {
    key: "audit",
    label: "Audit Logs",
    description: "Who changed what, when, and from where",
    group: "Administration",
    actions: [V, X],
    icon: "History",
    route: "/audit",
    order: 530,
    phase: 6,
    keywords: ["trail", "activity"],
  },
  {
    key: "periods",
    label: "Financial Period",
    description: "Opening, closing and locking a financial period",
    group: "Administration",
    actions: [V, C, E],
    icon: "CalendarClock",
    route: "/periods",
    order: 540,
    phase: 6,
    keywords: ["year end", "close"],
  },
  {
    key: "settings",
    label: "Settings",
    description: "Organisation details, fiscal year and approval thresholds",
    group: "Administration",
    actions: [V, E],
    icon: "Settings",
    route: "/settings",
    order: 550,
    phase: 8,
    keywords: ["organisation", "fiscal year", "approval thresholds", "gstin"],
  },
] as const satisfies readonly ModuleDefinition[];

export type ModuleKey = (typeof MODULE_CATALOG)[number]["key"];

/**
 * Every valid permission string, as a type.
 *
 * Derived from the catalogue rather than written out, so `requirePermission` cannot name a
 * module/action pair the matrix does not offer — the drift that let seventeen dead keys
 * sit on the Roles screen is a compile error now.
 */
type Entry = (typeof MODULE_CATALOG)[number];

/**
 * Written as a generic so the conditional DISTRIBUTES over the union.
 *
 * Inlining it — `Entry extends { key: infer K … } ? … : …` — does not distribute, because
 * distribution only happens for a naked type parameter. The non-distributing version
 * unions every key with every action and yields the cross product: 494 strings including
 * `dashboard.transact` and `settings.resetPassword`, which the matrix never offers and no
 * guard should be able to name.
 */
type PermissionOf<T> = T extends {
  key: infer K extends string;
  actions: readonly (infer Act extends string)[];
}
  ? `${K}.${Act}`
  : never;

export type Permission = PermissionOf<Entry>;

export const ALL_PERMISSIONS: Permission[] = MODULE_CATALOG.flatMap((m) =>
  m.actions.map((a) => `${m.key}.${a}` as Permission),
);

const MODULE_BY_KEY = new Map<string, ModuleDefinition>(
  MODULE_CATALOG.map((m) => [m.key, m as ModuleDefinition]),
);

export function getModule(key: string): ModuleDefinition | undefined {
  return MODULE_BY_KEY.get(key);
}

/** Split "payment_in.approve" into its parts. Returns null for anything unrecognised. */
export function parsePermission(
  value: string,
): { module: ModuleDefinition; action: PermissionAction } | null {
  const at = value.lastIndexOf(".");
  if (at < 0) return null;
  const mod = MODULE_BY_KEY.get(value.slice(0, at));
  const action = value.slice(at + 1) as PermissionAction;
  if (!mod || !mod.actions.includes(action)) return null;
  return { module: mod, action };
}

export function isPermission(value: string): value is Permission {
  return parsePermission(value) !== null;
}

export function describePermission(p: string): string {
  const parsed = parsePermission(p);
  if (!parsed) return p;
  return `${ACTION_LABEL[parsed.action]} — ${parsed.module.label}`;
}

/* -------------------------------------------------------------------------- */
/* Grouping — used to render the role matrix and the sidebar                  */
/* -------------------------------------------------------------------------- */

export const PERMISSION_GROUP_ORDER: PermissionGroup[] = [
  "Overview", "Finance", "Ledger", "Expenses & Income", "Banking", "Reports", "Administration",
];

/** The catalogue grouped and ordered, for the matrix and the sidebar. */
export function groupModules(
  options: { includeHidden?: boolean } = {},
): Array<{ group: PermissionGroup; modules: ModuleDefinition[] }> {
  return PERMISSION_GROUP_ORDER.map((group) => ({
    group,
    modules: (MODULE_CATALOG as readonly ModuleDefinition[])
      .filter((m) => m.group === group && (options.includeHidden || !m.hideInMenu))
      .sort((a, b) => a.order - b.order),
  })).filter((g) => g.modules.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Seeded system roles                                                        */
/*                                                                            */
/* The grants themselves live below `expandLegacy`, which they are derived     */
/* from — evaluating them any earlier reads it before it is initialised, and   */
/* the module throws on import.                                               */
/* -------------------------------------------------------------------------- */

export const SYSTEM_ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  BRANCH_ADMIN: "BRANCH_ADMIN",
  ACCOUNTANT: "ACCOUNTANT",
  VIEWER: "VIEWER",
} as const;

export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Which module owns each kind of transaction.
 *
 * Reversal and approval are single endpoints acting on rows of nine different types, so
 * the permission is not knowable at the route — it depends on what is being acted on. The
 * server guard and the button that offers the action both read this map, because the one
 * thing worse than a hidden button is a button the server refuses.
 */
export const MODULE_OF_TRANSACTION_TYPE: Record<string, string> = {
  PAYMENT_IN: "payment_in",
  PAYMENT_OUT: "payment_out",
  BANK_TRANSFER: "bank_transfer",
  EXPENSE: "expenses",
  INCOME: "income",
  ADJUSTMENT: "adjustments",
  SETTLEMENT: "settlements",
  SAVINGS: "savings",
  /** A balance asserted rather than transacted; correcting one is an adjustment. */
  OPENING_BALANCE: "adjustments",
};

/** The permission for taking `action` on a transaction of this type, if any module owns it. */
export function transactionPermissionFor(
  transactionType: string,
  action: PermissionAction,
): Permission | null {
  const module = MODULE_OF_TRANSACTION_TYPE[transactionType];
  if (!module) return null;
  const candidate = `${module}.${action}`;
  return isPermission(candidate) ? candidate : null;
}

/* -------------------------------------------------------------------------- */
/* Legacy vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The old capability strings, and what each one becomes.
 *
 * Kept in the shipping code rather than only in the migration script, because role
 * documents, audit rows and JWTs written before the change still carry the old strings —
 * `expandLegacy` lets a session minted five minutes before deploy keep working until it
 * expires, instead of the whole desk being locked out at once.
 *
 * The mapping is deliberately GENEROUS: a role that held `finance.ledger.view` gets all
 * five ledger screens, because it could open all five yesterday. Splitting a key must not
 * quietly take access away — tightening is a decision for the Roles screen, made by a
 * person, visible in the audit log.
 */
export const LEGACY_PERMISSION_MAP: Record<string, Permission[]> = {
  "finance.payment.create": ["payment_in.create", "payment_out.create"],
  "finance.payment.view": ["payment_in.view", "payment_out.view"],
  // PATCH on a payment was guarded by `reverse`, so both land here.
  "finance.payment.edit": ["payment_in.edit", "payment_out.edit"],
  "finance.payment.delete": ["payment_in.delete", "payment_out.delete"],
  "finance.payment.reverse": [
    "payment_in.reverse", "payment_out.reverse", "payment_in.edit", "payment_out.edit",
    "bank_transfer.reverse",
  ],
  "finance.payment.approve": ["payment_in.approve", "payment_out.approve"],

  "finance.expense.create": ["expenses.create"],
  "finance.expense.view": ["expenses.view", "heads.view"],
  "finance.expense.edit": ["expenses.edit"],
  "finance.expense.delete": ["expenses.delete"],
  "finance.expense.approve": ["expenses.approve"],
  "finance.expense.reverse": ["expenses.reverse"],
  "finance.expense.manageCategories": ["heads.create", "heads.edit", "heads.delete"],

  "finance.income.create": ["income.create"],
  "finance.income.view": ["income.view", "heads.view"],
  "finance.income.approve": ["income.approve"],
  "finance.income.reverse": ["income.reverse"],
  "finance.income.manageHeads": ["heads.create", "heads.edit", "heads.delete"],

  "finance.bank.create": ["banks.create", "bank_accounts.create"],
  "finance.bank.view": ["banks.view", "bank_accounts.view", "bank_book.view"],
  "finance.bank.edit": ["banks.edit", "bank_accounts.edit"],
  "finance.bank.viewFull": ["bank_accounts.viewFull"],
  "finance.bank.transfer": ["bank_transfer.view", "bank_transfer.create"],
  "finance.bank.reconcile": ["reconciliation.view", "reconciliation.create", "reconciliation.edit"],
  "finance.bank.statement.import": ["reconciliation.import"],

  "finance.cash.view": ["cash_book.view", "cash_tally.view", "bank_accounts.view"],
  "finance.cash.manage": ["bank_accounts.create", "bank_accounts.edit"],
  "finance.cash.tally": ["cash_tally.create"],

  "finance.party.create": ["parties.create"],
  "finance.party.view": ["parties.view", "credit.view", "party_ledger.view"],
  "finance.party.edit": ["parties.edit"],
  "finance.party.adjust": ["adjustments.create"],
  "finance.party.creditLimit": ["credit.edit"],

  "finance.khata.view": ["khata.view"],
  "finance.khata.entry": ["khata.create"],
  "finance.khata.share": ["khata.export"],

  "finance.savings.view": ["savings.view", "savings_ledger.view"],
  "finance.savings.manage": ["savings.create", "savings.edit"],
  "finance.savings.transact": ["savings.transact"],
  "finance.savings.interest": ["savings.interest"],

  "finance.settlement.view": ["settlements.view"],
  "finance.settlement.create": ["settlements.create"],
  "finance.settlement.approve": ["settlements.approve"],

  // Khata lines were guarded by this key, so holding it must keep them working.
  "finance.adjustment.create": ["adjustments.view", "adjustments.create", "khata.create"],
  "finance.adjustment.approve": ["adjustments.approve"],

  "finance.charges.view": ["charges.view"],
  "finance.charges.manage": ["charges.create", "charges.edit", "charges.delete"],

  "finance.daybook.view": ["daybook.view"],
  "finance.ledger.view": [
    "general_ledger.view", "party_ledger.view", "savings_ledger.view",
    "expense_ledger.view", "income_ledger.view",
  ],

  "reports.view": ["reports.view", "dashboard.view"],
  "reports.export": [
    "reports.export", "daybook.export", "profit_loss.export", "balance_sheet.export",
    "trial_balance.export", "general_ledger.export", "party_ledger.export",
    "savings_ledger.export", "expense_ledger.export", "income_ledger.export",
    "cash_book.export", "bank_book.export",
  ],
  "reports.pnl": ["profit_loss.view", "monthly_history.view"],
  "reports.balanceSheet": ["balance_sheet.view"],
  "reports.trialBalance": ["trial_balance.view"],

  "users.create": ["users.create"],
  "users.view": ["users.view"],
  "users.edit": ["users.edit"],
  "users.disable": ["users.delete"],
  "users.resetPassword": ["users.resetPassword"],

  "roles.view": ["roles.view"],
  "roles.manage": ["roles.create", "roles.edit", "roles.delete"],

  "approvals.view": ["approvals.view"],
  /**
   * `approvals.act` approved EVERYTHING, so it expands to every module's approve and
   * reject. That is not a widening — it is what the key already did.
   */
  "approvals.act": [
    "approvals.approve", "approvals.reject",
    "payment_in.approve", "payment_in.reject",
    "payment_out.approve", "payment_out.reject",
    "bank_transfer.approve", "bank_transfer.reject",
    "expenses.approve", "expenses.reject",
    "income.approve", "income.reject",
    "settlements.approve", "settlements.reject",
    "adjustments.approve", "adjustments.reject",
  ],

  "audit.view": ["audit.view"],
  "audit.export": ["audit.export"],

  "period.view": ["periods.view"],
  "period.manage": ["periods.create", "periods.edit"],

  "settings.view": ["settings.view"],
  "settings.manage": ["settings.edit"],

  "import.run": ["import_parties.view", "import_parties.import"],
};

/**
 * Translate a granted set that may still hold old strings.
 *
 * Unknown values are dropped rather than kept: a string that names nothing cannot grant
 * anything, and carrying it forward would only make the next reader wonder what it did.
 */
export function expandLegacy(granted: readonly string[]): string[] {
  const out = new Set<string>();
  for (const g of granted) {
    if (g === "*" || g.endsWith(".*")) {
      out.add(g);
      continue;
    }
    if (isPermission(g)) {
      out.add(g);
      continue;
    }
    for (const mapped of LEGACY_PERMISSION_MAP[g] ?? []) out.add(mapped);
  }
  return [...out];
}

/* -------------------------------------------------------------------------- */
/* Seeded role defaults                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What each seeded role could do BEFORE the catalogue was rewritten.
 *
 * The new defaults are derived from these rather than retyped, and that is the whole
 * point: hand-writing them drifted immediately — the first attempt quietly handed
 * BRANCH_ADMIN `audit.export`, `users.resetPassword` and `periods.edit`, none of which it
 * had. Deriving them means a seeded role does exactly what it did before, and any change
 * to what a role may do is a deliberate edit to this list rather than a side effect of
 * reorganising the vocabulary.
 */
const LEGACY_ROLE_DEFAULTS: Record<Exclude<SystemRole, "SUPER_ADMIN">, string[]> = {
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

  VIEWER: [
    "finance.payment.view", "finance.expense.view", "finance.income.view",
    "finance.bank.view", "finance.cash.view", "finance.party.view",
    "finance.khata.view", "finance.savings.view", "finance.settlement.view",
    "finance.charges.view", "finance.daybook.view", "finance.ledger.view",
    "reports.view", "reports.pnl", "reports.balanceSheet", "reports.trialBalance",
    "period.view",
  ],
};

/**
 * Starting permission sets for the seeded roles — a starting point written at seed time,
 * not a runtime authority. Once seeded, a SuperAdmin changes any of it from the Roles
 * screen with no deploy.
 *
 * Every role also gains `dashboard.view`, which is new: the Dashboard used to carry no
 * permission at all, so every role could open it. Granting it explicitly keeps that true
 * while making it something that can now be taken away.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRole, Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  BRANCH_ADMIN: withDashboard(LEGACY_ROLE_DEFAULTS.BRANCH_ADMIN),
  ACCOUNTANT: withDashboard(LEGACY_ROLE_DEFAULTS.ACCOUNTANT),
  VIEWER: withDashboard(LEGACY_ROLE_DEFAULTS.VIEWER),
};

function withDashboard(legacy: string[]): Permission[] {
  return [...new Set(["dashboard.view", ...expandLegacy(legacy)])] as Permission[];
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Does this permission set satisfy the requirement?
 *
 * Supports a trailing wildcard so a role can be granted `payment_in.*`, and the global `*`
 * which only a super admin role should ever hold. Legacy strings are understood here too,
 * so a session minted before the catalogue changed still evaluates correctly.
 */
export function hasPermission(granted: readonly string[], required: Permission): boolean {
  if (granted.includes("*")) return true;
  if (granted.includes(required)) return true;

  for (const g of granted) {
    if (g.endsWith(".*") && required.startsWith(g.slice(0, -1))) return true;
    // An old string still in a live JWT: does what it used to grant cover this?
    const legacy = LEGACY_PERMISSION_MAP[g];
    if (legacy?.includes(required)) return true;
  }

  return false;
}

/**
 * Every stored string that would grant this permission.
 *
 * For querying the roles collection directly — "which roles may approve?" is a database
 * question, and a `$in` needs the literal strings rather than a predicate. It covers the
 * key itself, the module wildcard, the global wildcard, and any legacy string that still
 * expands to it, because a role document written before the catalogue changed is still
 * live until the migration runs.
 */
export function grantStringsFor(permission: Permission): string[] {
  const module = permission.slice(0, permission.lastIndexOf("."));
  const legacy = Object.entries(LEGACY_PERMISSION_MAP)
    .filter(([, targets]) => targets.includes(permission))
    .map(([key]) => key);
  return ["*", `${module}.*`, permission, ...legacy];
}

export function hasAnyPermission(granted: readonly string[], required: Permission[]): boolean {
  return required.some((r) => hasPermission(granted, r));
}

export function hasAllPermissions(granted: readonly string[], required: Permission[]): boolean {
  return required.every((r) => hasPermission(granted, r));
}
