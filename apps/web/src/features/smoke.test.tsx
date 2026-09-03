import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";

const api = {
  get: vi.fn(),
  list: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api };
});


vi.mock("@/features/auth/auth-context", () => ({
  useAuth: () => ({
    user: {
      id: "6501aa000000000000000001",
      name: "Test Operator",
      email: "test@amiri.co",
      role: { id: "r", name: "SUPER_ADMIN", label: "Super Admin" },
      permissions: ["*"],
      isSuperAdmin: true,
      mustChangePassword: false,
    },
    status: "authenticated",
    can: () => true,
    logout: vi.fn(),
  }),
  Can: ({ children }: { children: React.ReactNode }) => children,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { renderWithProviders } = await import("@/test/harness");

/**
 * Render smoke tests.
 *
 * Every previous phase verified screens by asking the dev server for a route and checking
 * for HTTP 200. That only proves the HTML shell was served — it never executes React, so a
 * render-time crash is completely invisible to it. `<Button asChild>` threw on every route
 * that used it, for several phases, and the 200s kept coming.
 *
 * These tests actually mount each screen. They assert almost nothing about behaviour: the
 * bar is that the component renders without throwing, with empty data and with populated
 * data. That is a low bar, and it is exactly the bar that was not being cleared.
 */

/** Empty-but-well-formed responses, so a screen renders its empty state rather than crashing. */
function emptyList() {
  return {
    items: [],
    meta: { page: 1, limit: 25, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
  };
}

const SCREENS: Array<{ name: string; load: () => Promise<{ default?: unknown } & Record<string, unknown>>; export: string }> = [
  { name: "Dashboard", load: () => import("@/features/dashboard/dashboard-page"), export: "DashboardPage" },
  { name: "Parties", load: () => import("@/features/parties/parties-page"), export: "PartiesPage" },
  { name: "Banks", load: () => import("@/features/banking/banks-page"), export: "BanksPage" },
  { name: "Accounts", load: () => import("@/features/banking/bank-accounts-page"), export: "BankAccountsPage" },
  { name: "Users", load: () => import("@/features/users/users-page"), export: "UsersPage" },
  { name: "Roles", load: () => import("@/features/roles/roles-page"), export: "RolesPage" },
  { name: "Khata", load: () => import("@/features/khata/khata-page"), export: "KhataPage" },
  { name: "Credit", load: () => import("@/features/credit/credit-page"), export: "CreditPage" },
  { name: "Savings", load: () => import("@/features/savings/savings-page"), export: "SavingsPage" },
  { name: "Settlements", load: () => import("@/features/settlements/settlements-page"), export: "SettlementsPage" },
  { name: "Reconciliation", load: () => import("@/features/reconciliation/reconciliation-page"), export: "ReconciliationPage" },
  { name: "Charges", load: () => import("@/features/charges/charges-page"), export: "ChargesPage" },
  { name: "Heads", load: () => import("@/features/heads/heads-page"), export: "HeadsPage" },
  { name: "Import", load: () => import("@/features/imports/import-page"), export: "ImportPage" },
  { name: "Settings", load: () => import("@/features/settings/settings-page"), export: "SettingsPage" },
  { name: "Trial balance", load: () => import("@/features/reports/trial-balance-page"), export: "TrialBalancePage" },
  { name: "Reports hub", load: () => import("@/features/reports/reports-index-page"), export: "ReportsIndexPage" },
  { name: "Monthly history", load: () => import("@/features/reports/monthly-history-page"), export: "MonthlyHistoryPage" },
  { name: "Cash tally", load: () => import("@/features/reports/cash-tally-page"), export: "CashTallyPage" },
  { name: "Approvals", load: () => import("@/features/governance/approvals-page"), export: "ApprovalsPage" },
  { name: "Audit", load: () => import("@/features/governance/audit-page"), export: "AuditPage" },
  { name: "Periods", load: () => import("@/features/governance/periods-page"), export: "PeriodsPage" },
  { name: "Cash book", load: () => import("@/features/books/ledger-book-page"), export: "CashBookPage" },
  { name: "General ledger", load: () => import("@/features/books/ledger-book-page"), export: "GeneralLedgerPage" },
  { name: "Expense ledger", load: () => import("@/features/books/ledger-book-page"), export: "ExpenseLedgerPage" },
  { name: "Income ledger", load: () => import("@/features/books/ledger-book-page"), export: "IncomeLedgerPage" },
  { name: "Savings ledger", load: () => import("@/features/books/ledger-book-page"), export: "SavingsLedgerPage" },
];

describe("every screen renders without throwing", () => {
  beforeEach(() => {
    api.list.mockResolvedValue(emptyList());
    // Screens read a variety of shapes; an array satisfies the list-like ones and an
    // object with common fields satisfies the report-like ones.
    api.get.mockImplementation((path: string) =>
      Promise.resolve(
        /trial-balance|profit-loss|balance-sheet|cash-flow|dashboard|cash-tally|settings|reconciliation\/[a-f0-9]/.test(
          String(path),
        )
          ? {
              rows: [], totalDebit: 0, totalCredit: 0, difference: 0, asOf: new Date().toISOString(),
              income: [], expenses: [], totalIncome: 0, totalExpenses: 0, totalCharges: 0, netProfit: 0, margin: null,
              assets: [], liabilities: [], equity: [], totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
              netCashFlow: 0, inflow: 0, outflow: 0,
              profile: { legalName: "AMIRI", fiscalStartMonth: 4 }, fiscalStartMonthEditable: true,
              updatedAt: null, updatedBy: null,
              users: 0, activeUsers: 0, ledgerEntries: 0, oldestEntry: null, newestEntry: null,
              counts: { matched: 0, unmatched: 0, missingInSystem: 0, missingInBank: 0, duplicate: 0, needsReview: 0 },
              items: [], unread: 0,
            }
          : [],
      ),
    );
  });

  for (const screenUnderTest of SCREENS) {
    it(`renders ${screenUnderTest.name}`, async () => {
      const module = await screenUnderTest.load();
      const Component = module[screenUnderTest.export] as React.ComponentType;

      expect(Component, `${screenUnderTest.export} is not exported`).toBeTypeOf("function");

      // The assertion is simply that this does not throw. React logs render errors rather
      // than rejecting, so the check is that something reached the DOM afterwards.
      const { container } = renderWithProviders(<Component />);
      await waitFor(() => expect(container.firstChild).toBeTruthy());
    });
  }
});

describe("the dashboard's slotted link", () => {
  beforeEach(() => {
    api.list.mockResolvedValue(emptyList());
    api.get.mockResolvedValue({
      totalBalance: 0, bankBalance: 0, cashBalance: 0, savingsHeld: 0,
      todayIn: 0, todayOut: 0, todayNet: 0, todayIncome: 0, todayExpense: 0,
      agingBuckets: {}, trend: [], topExpenses: [],
    });
  });

  it("renders the credit report link that used to crash the route", async () => {
    const { DashboardPage } = await import("@/features/dashboard/dashboard-page");
    renderWithProviders(<DashboardPage />);

    // `<Button asChild><Link/></Button>` — the exact construction that threw.
    await waitFor(() => {
      expect(screen.getAllByRole("link").length).toBeGreaterThan(0);
    });
  });
});
