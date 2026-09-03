import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight, Banknote, CalendarRange, FileSpreadsheet, Notebook, Scale, TrendingUp, Wallet,
} from "lucide-react";
import type { Permission } from "@amiri/shared";
import { api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { ExportMenu } from "@/components/export-menu";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The reports hub.
 *
 * Its one job beyond navigation is §21: state, on the way in, that CASH FLOW and PROFIT
 * are different questions. An operator who reads "₹4,00,000 came in today" as profit will
 * misjudge the business, and the place to head that off is before they open a report, not
 * in a footnote inside one.
 *
 * The period picker here drives the export buttons, so a report can be exported for a
 * chosen range without opening it first.
 */
export function ReportsIndexPage() {
  const { can } = useAuth();
  const [from, setFrom] = React.useState(() => monthStart());
  const [to, setTo] = React.useState(() => new Date().toISOString().slice(0, 10));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Financial Reports"
        description="Everything derived from the ledger. Choose a period once and it carries across the exports below."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="from">From</Label>
          <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="to">To</Label>
          <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
        </div>
      </div>

      <PeriodHeadline from={from} to={to} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ReportCard
          to="/reports/profit-loss"
          icon={TrendingUp}
          title="Profit & Loss"
          description="Income earned less expenses incurred, for the period. Not the same as cash received."
          exportPath="/export/profit-loss"
          params={{ from, to }}
          permission="profit_loss.view"
          can={can}
        />
        <ReportCard
          to="/reports/monthly-history"
          icon={CalendarRange}
          title="Monthly History"
          description="Profit, expenses and party movement month by month, so this period can be read against the ones before it."
          params={{ from, to }}
          permission="monthly_history.view"
          can={can}
        />
        <ReportCard
          to="/reports/balance-sheet"
          icon={Scale}
          title="Balance Sheet"
          description="What is owned, what is owed and what is left, as at the end date."
          exportPath="/export/balance-sheet"
          params={{ asOf: to }}
          permission="balance_sheet.view"
          can={can}
        />
        <ReportCard
          to="/reports/trial-balance"
          icon={FileSpreadsheet}
          title="Trial Balance"
          description="Every account's net position. Proves debits equal credits."
          exportPath="/export/trial-balance"
          params={{ asOf: to }}
          permission="trial_balance.view"
          can={can}
        />
        <ReportCard
          to="/daybook"
          icon={Notebook}
          title="DayBook"
          description="Every transaction as posted, in order, with its running effect."
          exportPath="/export/daybook"
          params={{ from, to }}
          permission="daybook.view"
          can={can}
        />
        <ReportCard
          to="/cash-tally"
          icon={Wallet}
          title="Daily Cash Tally"
          description="What the drawer should hold against what was counted. Differences are reported, never absorbed."
          permission="cash_book.view"
          can={can}
        />
        <ReportCard
          to="/audit"
          icon={FileSpreadsheet}
          title="Audit Trail"
          description="Who did what, when, and what the values were before and after."
          exportPath="/export/audit"
          params={{ from, to }}
          permission="audit.view"
          can={can}
        />
      </div>
    </div>
  );
}

/* ── Cash vs profit, side by side (§21) ──────────────────────────────────── */

interface CashFlow {
  netCashFlow: number;
  inflow: number;
  outflow: number;
}

interface ProfitLoss {
  netProfit: number;
  totalIncome: number;
  totalExpenses: number;
}

function PeriodHeadline({ from, to }: { from: string; to: string }) {
  const cashFlow = useQuery({
    queryKey: ["cash-flow", from, to],
    queryFn: () => api.get<CashFlow>(`/reports/cash-flow${qs({ from, to })}`),
    enabled: Boolean(from && to),
  });

  const pnl = useQuery({
    queryKey: ["profit-loss", from, to],
    queryFn: () => api.get<ProfitLoss>(`/reports/profit-loss${qs({ from, to })}`),
    enabled: Boolean(from && to),
  });

  const loading = cashFlow.isPending || pnl.isPending;
  const failed = cashFlow.isError || pnl.isError;

  if (failed) return null;

  return (
    <Card className="p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Banknote className="size-3.5" aria-hidden />
            Cash moved
          </div>
          {loading ? (
            <Skeleton className="h-8 w-40" />
          ) : (
            <Money value={cashFlow.data!.netCashFlow} direction="auto" size="xl" showIcon={false} />
          )}
          <p className="text-xs text-muted-foreground">
            Money that actually entered and left the accounts. Includes loans, transfers and
            capital — none of which are earnings.
          </p>
        </div>

        <div className="space-y-1 sm:border-l sm:border-border sm:pl-4">
          <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="size-3.5" aria-hidden />
            Profit earned
          </div>
          {loading ? (
            <Skeleton className="h-8 w-40" />
          ) : (
            <Money value={pnl.data!.netProfit} direction="auto" size="xl" showIcon={false} />
          )}
          <p className="text-xs text-muted-foreground">
            Income earned less expenses incurred. A day of heavy cash turnover can still be a
            loss — these two numbers answer different questions.
          </p>
        </div>
      </div>
    </Card>
  );
}

/* ── Card ────────────────────────────────────────────────────────────────── */

function ReportCard({
  to, icon: Icon, title, description, exportPath, params, permission, can,
}: {
  to: string;
  icon: typeof Scale;
  title: string;
  description: string;
  exportPath?: string;
  params?: Record<string, string>;
  permission: Permission;
  can: (p: Permission) => boolean;
}) {
  // Hidden rather than disabled: the sidebar already tells the user what exists, and a hub
  // full of cards they cannot open is noise.
  if (!can(permission)) return null;

  return (
    <Card className="flex flex-col justify-between gap-4 p-4 transition-shadow hover:shadow-card">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Link
          to={to}
          className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          Open
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        {exportPath ? <ExportMenu path={exportPath} params={params} label="Export" /> : null}
      </div>
    </Card>
  );
}

function monthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}
