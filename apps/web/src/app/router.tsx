import * as React from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import type { Permission } from "@amiri/shared";
import { RequireAuth } from "./app-layout";
import { NotFoundPage } from "./not-found-page";
import { LoginPage } from "@/features/auth/login-page";
import { useAuth } from "@/features/auth/auth-context";
import { EmptyState } from "@/components/empty-state";
import { ShieldAlert } from "lucide-react";


/**
 * Every screen except the two a session always begins with is loaded on demand.
 *
 * Statically importing all thirty put them in one 783 kB entry chunk, so an accountant
 * signing in to record a receipt downloaded the roles editor, the reconciliation
 * workspace and the charting library before the login form appeared. Now each screen is
 * its own chunk and arrives when it is first opened.
 *
 * Login stays eager — it is the first paint of an unauthenticated session, and lazily
 * loading it would trade bundle size for a spinner nobody asked for.
 *
 * The Dashboard does NOT stay eager, despite being the first screen after sign-in. It
 * renders charts, so importing it statically pulled Recharts (384 kB) into the initial
 * graph — which meant the login form downloaded the entire charting library before it
 * could be typed into. Lazily loaded, its chunk is fetched while the silent token refresh
 * is still in flight, so an authenticated user sees no delay and an unauthenticated one
 * never pays for it at all.
 */
const lazyPage = <K extends string>(
  load: () => Promise<Record<K, React.ComponentType>>,
  name: K,
) => React.lazy(async () => ({ default: (await load())[name] }));

const DashboardPage = lazyPage(() => import("@/features/dashboard/dashboard-page"), "DashboardPage");
const ProfilePage = lazyPage(() => import("@/features/auth/profile-page"), "ProfilePage");
const UsersPage = lazyPage(() => import("@/features/users/users-page"), "UsersPage");
const RolesPage = lazyPage(() => import("@/features/roles/roles-page"), "RolesPage");
const BanksPage = lazyPage(() => import("@/features/banking/banks-page"), "BanksPage");
const BankAccountsPage = lazyPage(() => import("@/features/banking/bank-accounts-page"), "BankAccountsPage");
const PartiesPage = lazyPage(() => import("@/features/parties/parties-page"), "PartiesPage");

const DayBookPage = lazyPage(() => import("@/features/transactions/pages"), "DayBookPage");
const PaymentInPage = lazyPage(() => import("@/features/transactions/pages"), "PaymentInPage");
const PaymentOutPage = lazyPage(() => import("@/features/transactions/pages"), "PaymentOutPage");
const BankTransferPage = lazyPage(() => import("@/features/transactions/pages"), "BankTransferPage");
const ExpensesPage = lazyPage(() => import("@/features/transactions/pages"), "ExpensesPage");
const IncomePage = lazyPage(() => import("@/features/transactions/pages"), "IncomePage");

const KhataPage = lazyPage(() => import("@/features/khata/khata-page"), "KhataPage");
const CreditPage = lazyPage(() => import("@/features/credit/credit-page"), "CreditPage");
const SavingsPage = lazyPage(() => import("@/features/savings/savings-page"), "SavingsPage");

const ProfitLossPage = lazyPage(() => import("@/features/reports/pnl-page"), "ProfitLossPage");
const MonthlyHistoryPage = lazyPage(() => import("@/features/reports/monthly-history-page"), "MonthlyHistoryPage");
const BalanceSheetPage = lazyPage(() => import("@/features/reports/balance-sheet-page"), "BalanceSheetPage");
const CashTallyPage = lazyPage(() => import("@/features/reports/cash-tally-page"), "CashTallyPage");
const ReportsIndexPage = lazyPage(() => import("@/features/reports/reports-index-page"), "ReportsIndexPage");
const TrialBalancePage = lazyPage(() => import("@/features/reports/trial-balance-page"), "TrialBalancePage");

const CashBookPage = lazyPage(() => import("@/features/books/ledger-book-page"), "CashBookPage");
const GeneralLedgerPage = lazyPage(() => import("@/features/books/ledger-book-page"), "GeneralLedgerPage");
const ExpenseLedgerPage = lazyPage(() => import("@/features/books/ledger-book-page"), "ExpenseLedgerPage");
const IncomeLedgerPage = lazyPage(() => import("@/features/books/ledger-book-page"), "IncomeLedgerPage");
const SavingsLedgerPage = lazyPage(() => import("@/features/books/ledger-book-page"), "SavingsLedgerPage");
const BankBookPage = lazyPage(() => import("@/features/books/ledger-book-page"), "BankBookPage");
const PartyLedgerPage = lazyPage(() => import("@/features/books/ledger-book-page"), "PartyLedgerPage");

const HeadsPage = lazyPage(() => import("@/features/heads/heads-page"), "HeadsPage");
const ChargesPage = lazyPage(() => import("@/features/charges/charges-page"), "ChargesPage");
const SettlementsPage = lazyPage(() => import("@/features/settlements/settlements-page"), "SettlementsPage");
const ReconciliationPage = lazyPage(() => import("@/features/reconciliation/reconciliation-page"), "ReconciliationPage");
const ImportPage = lazyPage(() => import("@/features/imports/import-page"), "ImportPage");
const SettingsPage = lazyPage(() => import("@/features/settings/settings-page"), "SettingsPage");

const ApprovalsPage = lazyPage(() => import("@/features/governance/approvals-page"), "ApprovalsPage");
const AuditPage = lazyPage(() => import("@/features/governance/audit-page"), "AuditPage");
const PeriodsPage = lazyPage(() => import("@/features/governance/periods-page"), "PeriodsPage");

/**
 * Client-side permission gate.
 *
 * A courtesy that avoids rendering a screen whose every request would be refused. The
 * server enforces the same permission on each route independently — removing this
 * component would change what the user sees, not what they can do.
 */
function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: React.ReactNode;
}) {
  const { can } = useAuth();
  if (can(permission)) return <>{children}</>;
  return (
    <EmptyState
      icon={ShieldAlert}
      title="You do not have access to this screen"
      description="Your role does not include the permission this page requires. An administrator can grant it."
    />
  );
}

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <RequireAuth />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "profile", element: <ProfilePage /> },
      {
        path: "daybook",
        element: (
          <RequirePermission permission="daybook.view">
            <DayBookPage />
          </RequirePermission>
        ),
      },
      {
        path: "payment-in",
        element: (
          <RequirePermission permission="payment_in.view">
            <PaymentInPage />
          </RequirePermission>
        ),
      },
      {
        path: "payment-out",
        element: (
          <RequirePermission permission="payment_out.view">
            <PaymentOutPage />
          </RequirePermission>
        ),
      },
      {
        path: "bank-transfers",
        element: (
          <RequirePermission permission="bank_transfer.view">
            <BankTransferPage />
          </RequirePermission>
        ),
      },
      {
        path: "expenses",
        element: (
          <RequirePermission permission="expenses.view">
            <ExpensesPage />
          </RequirePermission>
        ),
      },
      {
        path: "income",
        element: (
          <RequirePermission permission="income.view">
            <IncomePage />
          </RequirePermission>
        ),
      },
      {
        path: "approvals",
        element: (
          <RequirePermission permission="approvals.view">
            <ApprovalsPage />
          </RequirePermission>
        ),
      },
      {
        path: "audit",
        element: (
          <RequirePermission permission="audit.view">
            <AuditPage />
          </RequirePermission>
        ),
      },
      {
        path: "periods",
        element: (
          <RequirePermission permission="periods.view">
            <PeriodsPage />
          </RequirePermission>
        ),
      },
      {
        path: "reports/profit-loss",
        element: (
          <RequirePermission permission="profit_loss.view">
            <ProfitLossPage />
          </RequirePermission>
        ),
      },
      {
        path: "reports/monthly-history",
        element: (
          <RequirePermission permission="monthly_history.view">
            <MonthlyHistoryPage />
          </RequirePermission>
        ),
      },
      {
        path: "reports/balance-sheet",
        element: (
          <RequirePermission permission="balance_sheet.view">
            <BalanceSheetPage />
          </RequirePermission>
        ),
      },
      {
        path: "cash-tally",
        element: (
          <RequirePermission permission="cash_tally.view">
            <CashTallyPage />
          </RequirePermission>
        ),
      },
      {
        path: "khata",
        element: (
          <RequirePermission permission="khata.view">
            <KhataPage />
          </RequirePermission>
        ),
      },
      {
        // The party id is optional: /khata is the picker, /khata/:partyId the statement.
        path: "khata/:partyId",
        element: (
          <RequirePermission permission="khata.view">
            <KhataPage />
          </RequirePermission>
        ),
      },
      {
        path: "credit",
        element: (
          <RequirePermission permission="credit.view">
            <CreditPage />
          </RequirePermission>
        ),
      },
      {
        path: "savings",
        element: (
          <RequirePermission permission="savings.view">
            <SavingsPage />
          </RequirePermission>
        ),
      },
      {
        path: "banks",
        element: (
          <RequirePermission permission="banks.view">
            <BanksPage />
          </RequirePermission>
        ),
      },
      {
        path: "bank-accounts",
        element: (
          <RequirePermission permission="bank_accounts.view">
            <BankAccountsPage />
          </RequirePermission>
        ),
      },
      {
        path: "parties",
        element: (
          <RequirePermission permission="parties.view">
            <PartiesPage />
          </RequirePermission>
        ),
      },
      {
        path: "users",
        element: (
          <RequirePermission permission="users.view">
            <UsersPage />
          </RequirePermission>
        ),
      },
      {
        path: "roles",
        element: (
          <RequirePermission permission="roles.view">
            <RolesPage />
          </RequirePermission>
        ),
      },
      {
        path: "reports",
        element: (
          <RequirePermission permission="reports.view">
            <ReportsIndexPage />
          </RequirePermission>
        ),
      },
      {
        path: "reports/trial-balance",
        element: (
          <RequirePermission permission="trial_balance.view">
            <TrialBalancePage />
          </RequirePermission>
        ),
      },
      {
        path: "ledger",
        element: (
          <RequirePermission permission="general_ledger.view">
            <GeneralLedgerPage />
          </RequirePermission>
        ),
      },
      {
        path: "expense-ledger",
        element: (
          <RequirePermission permission="expense_ledger.view">
            <ExpenseLedgerPage />
          </RequirePermission>
        ),
      },
      {
        path: "income-ledger",
        element: (
          <RequirePermission permission="income_ledger.view">
            <IncomeLedgerPage />
          </RequirePermission>
        ),
      },
      {
        path: "savings-ledger",
        element: (
          <RequirePermission permission="savings_ledger.view">
            <SavingsLedgerPage />
          </RequirePermission>
        ),
      },
      {
        path: "cash-book",
        element: (
          <RequirePermission permission="cash_book.view">
            <CashBookPage />
          </RequirePermission>
        ),
      },
      {
        path: "bank-book",
        element: (
          <RequirePermission permission="bank_book.view">
            <BankBookPage />
          </RequirePermission>
        ),
      },
      {
        path: "party-ledger",
        element: (
          <RequirePermission permission="party_ledger.view">
            <PartyLedgerPage />
          </RequirePermission>
        ),
      },
      {
        path: "heads",
        element: (
          <RequirePermission permission="heads.view">
            <HeadsPage />
          </RequirePermission>
        ),
      },
      {
        path: "charges",
        element: (
          <RequirePermission permission="charges.view">
            <ChargesPage />
          </RequirePermission>
        ),
      },
      {
        path: "reconciliation",
        element: (
          <RequirePermission permission="reconciliation.view">
            <ReconciliationPage />
          </RequirePermission>
        ),
      },
      {
        path: "settlements",
        element: (
          <RequirePermission permission="settlements.view">
            <SettlementsPage />
          </RequirePermission>
        ),
      },
      {
        path: "import",
        element: (
          <RequirePermission permission="import_parties.view">
            <ImportPage />
          </RequirePermission>
        ),
      },
      {
        path: "settings",
        element: (
          <RequirePermission permission="settings.view">
            <SettingsPage />
          </RequirePermission>
        ),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
