import { PageHeader } from "@/components/page-header";
import { ExportMenu } from "@/components/export-menu";
import { Can } from "@/features/auth/auth-context";
import { TransactionTable } from "./transaction-table";
import { NewTransactionButton } from "./transaction-form";

/** Default export period: this month to date, matching what the table shows first. */
function monthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Phase 3 screens.
 *
 * All five are the same table with the endpoint pinned — the per-type filtering happens on
 * the server, so each screen is a thin wrapper rather than a copy. Every row opens the
 * §46 details drawer, where the actual ledger entries and the audit timeline live.
 */

export function DayBookPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="DayBook"
        description="Every transaction, in one journal. Click any row to see the ledger entries behind it."
        actions={
          <>
            {/* The export endpoint requires an explicit period — a DayBook with no
                range would be the entire ledger under a name that promises one day. */}
            <ExportMenu path="/export/daybook" params={{ from: monthStart(), to: today() }} />
            <Can permission="finance.payment.create">
              <NewTransactionButton mode="PAYMENT_IN" label="Payment In" />
            </Can>
          </>
        }
      />
      <TransactionTable
        endpoint="/transactions"
        cacheKey="daybook"
        emptyTitle="Nothing posted yet"
        emptyDescription="Payments, transfers, expenses and income all appear here as they are posted."
      />
    </div>
  );
}

export function PaymentInPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Payment In"
        description="Money received from parties. Each posting debits an account and reduces what the party owes."
        actions={
          <Can permission="finance.payment.create">
            <NewTransactionButton mode="PAYMENT_IN" label="Record receipt" />
          </Can>
        }
      />
      <TransactionTable
        endpoint="/payment-in"
        cacheKey="payment-in"
        showType={false}
        emptyTitle="No payments received yet"
        emptyDescription="Recorded collections will appear here."
      />
    </div>
  );
}

export function PaymentOutPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Payment Out"
        description="Money paid to parties. Each posting credits an account and settles what we owe."
        actions={
          <Can permission="finance.payment.create">
            <NewTransactionButton mode="PAYMENT_OUT" label="Record payment" />
          </Can>
        }
      />
      <TransactionTable
        endpoint="/payment-out"
        cacheKey="payment-out"
        showType={false}
        emptyTitle="No payments made yet"
        emptyDescription="Disbursements will appear here."
      />
    </div>
  );
}

export function BankTransferPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Bank Transfers"
        description="Movements between our own accounts. The destination always receives the full gross; any fee is charged separately to the source."
        actions={
          <Can permission="finance.bank.transfer">
            <NewTransactionButton mode="BANK_TRANSFER" label="New transfer" />
          </Can>
        }
      />
      <TransactionTable
        endpoint="/bank-transfers"
        cacheKey="bank-transfers"
        showType={false}
        emptyTitle="No transfers yet"
        emptyDescription="Bank-to-bank movements will appear here."
      />
    </div>
  );
}

export function ExpensesPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Expenses"
        description="Costs booked against expense heads, paid from an account or left as a payable."
        actions={
          <Can permission="finance.expense.create">
            <NewTransactionButton mode="EXPENSE" label="Record expense" />
          </Can>
        }
      />
      <TransactionTable
        endpoint="/expenses"
        cacheKey="expenses"
        showType={false}
        searchPlaceholder="Search voucher, invoice no or narration…"
        emptyTitle="No expenses recorded yet"
        emptyDescription="Salary, rent, panel and domain costs will appear here."
      />
    </div>
  );
}

export function IncomePage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Income"
        description="Earnings credited to an income head. Distinct from a Payment In — no party receivable is settled."
        actions={
          <>
            <ExportMenu path="/export/daybook" params={{ from: monthStart(), to: today() }} />
            <Can permission="finance.income.create">
              <NewTransactionButton mode="INCOME" label="Record Income" />
            </Can>
          </>
        }
      />
      <TransactionTable
        endpoint="/income"
        cacheKey="income"
        showType={false}
        emptyTitle="No income recorded yet"
        emptyDescription="Commission, interest and service income will appear here."
      />
    </div>
  );
}
