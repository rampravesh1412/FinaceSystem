import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowRight, Building2, ClipboardCheck, CreditCard, ListChecks,
  PiggyBank, Scale, TrendingUp, Wallet,
} from "lucide-react";
import { AGING_BUCKETS, KHATA_LABEL, type DashboardResponse } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { EmptyState } from "@/components/empty-state";
import { BranchProfitChart, BucketChart, RankedBarChart, TrendChart } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Dashboard (§31 SuperAdmin, §32 Branch, §33 Accountant).
 *
 * The layout enforces §21 visually: CASH FLOW and PROFIT live in separate, labelled
 * groups with their own charts, and the page never shows a figure that adds one to the
 * other. A branch can push ₹10,00,000 through its accounts and still lose money — the
 * dashboard has to make that legible, not hide it behind a single "today" number.
 *
 * Every tile drills through to the screen that explains it (§47).
 */
export function DashboardPage() {
  const { user } = useAuth();
  const [days, setDays] = React.useState(30);

  const query = useQuery({
    queryKey: ["dashboard", { days, branch: user?.activeBranchId }],
    queryFn: () => api.get<DashboardResponse>(`/dashboard${qs({ days })}`),
  });

  const greeting = getGreeting();
  const firstName = user?.name.split(" ")[0] ?? "there";

  if (query.isError) {
    return (
      <Card>
        <EmptyState
          icon={Scale}
          title="Could not load the dashboard"
          description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
        />
      </Card>
    );
  }

  const d = query.data;
  const m = d?.metrics;
  const loading = query.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting}, ${firstName}`}
        description={
          d?.scope === "BRANCH" && d.branch
            ? `${d.branch.code} — ${d.branch.name}`
            : "Across every branch."
        }
        actions={
          <div className="flex rounded-lg bg-surface-muted p-1" role="group" aria-label="Trend period">
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setDays(n)}
                aria-pressed={days === n}
                className={
                  days === n
                    ? "rounded-md bg-surface px-3 py-1 text-sm font-medium shadow-subtle"
                    : "rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
                }
              >
                {n}d
              </button>
            ))}
          </div>
        }
      />

      {/* ── Position: what we hold right now ──────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel>Position</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total balance" value={m?.totalBalance} icon={Scale} loading={loading} to="/bank-accounts" />
          <StatCard label="Bank" value={m?.bankBalance} icon={CreditCard} loading={loading} to="/bank-accounts" />
          <StatCard label="Cash in hand" value={m?.cashBalance} icon={Wallet} loading={loading} to="/bank-accounts" />
          <StatCard label="Held for members" value={m?.savingsHeld} icon={PiggyBank} loading={loading} to="/savings" />
        </div>
      </section>

      {/* ── Cash flow and profit, deliberately side by side and never combined ── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <SectionLabel hint="What moved through the accounts today.">Cash flow</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Money in" value={m?.todayIn} direction="in" loading={loading} to="/payment-in" />
            <StatCard label="Money out" value={m?.todayOut} direction="out" loading={loading} to="/payment-out" />
            <StatCard label="Net movement" value={m?.todayNet} direction="auto" loading={loading} to="/daybook" />
          </div>
        </section>

        <section className="space-y-3">
          <SectionLabel hint="What the business actually earned today.">Profit</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Income" value={m?.todayIncome} direction="in" loading={loading} to="/income" />
            <StatCard label="Expenses" value={m?.todayExpenses} direction="out" loading={loading} to="/expenses" />
            <StatCard label="Today's profit" value={m?.todayProfit} direction="auto" loading={loading} to="/reports/profit-loss" />
          </div>
        </section>
      </div>

      {/* An explicit note, because the distinction is the point (§21). */}
      <p className="rounded-md border border-border bg-surface-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Cash flow is not profit.</span>{" "}
        Money moving through the accounts and money earned are different questions — a day
        of heavy collections settles old debts without earning anything, and a profitable
        day may bank nothing at all. They are reported separately here and never added
        together.
      </p>

      {/* ── Trends ────────────────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Income vs expenses</CardTitle>
            <p className="text-xs text-muted-foreground">Last {days} days — the profit view.</p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-60 w-full" />
            ) : (
              <TrendChart
                data={d!.trend}
                series={[
                  { key: "income", label: "Income", slot: "primary" },
                  { key: "expenses", label: "Expenses", slot: "secondary" },
                ]}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Money in vs money out</CardTitle>
            <p className="text-xs text-muted-foreground">Last {days} days — the cash view.</p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-60 w-full" />
            ) : (
              <TrendChart
                data={d!.trend}
                series={[
                  { key: "moneyIn", label: "Money in", slot: "primary" },
                  { key: "moneyOut", label: "Money out", slot: "secondary" },
                ]}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Receivable, payable and attention ─────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel>Owed and owing</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Receivable — Lena Hai" value={m?.receivable} direction="in" loading={loading} to="/parties?balance=lena" />
          <StatCard label="Payable — Dena Hai" value={m?.payable} direction="out" loading={loading} to="/parties?balance=dena" />
          <StatCard label="Overdue" value={m?.overdueAmount} direction="out" loading={loading} to="/credit?overdueOnly=true" />
          <StatCard label="Open reconciliations" value={m?.unreconciledCount} asCount icon={ListChecks} loading={loading} />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Outstanding by age</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <BucketChart
                buckets={AGING_BUCKETS.map((b) => d!.agingBuckets[b.key] ?? 0)}
                labels={AGING_BUCKETS.map((b) => b.label)}
              />
            )}
            <Button asChild variant="ghost" size="sm" className="mt-3 w-full">
              <Link to="/credit">
                Open credit report
                <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Expenses this month</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-56 w-full" /> : <RankedBarChart data={d!.expenseBreakdown} />}
          </CardContent>
        </Card>
      </div>

      {/* Branch comparison is for unscoped users only — §32 forbids showing a scoped
          user another branch's numbers, and the server omits them entirely. */}
      {d && d.branches.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Branch performance</CardTitle>
            <p className="text-xs text-muted-foreground">Profit this month, by branch.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <BranchProfitChart data={d.branches.map((b) => ({ code: b.code, profit: b.profit }))} />

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Income</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Expenses</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Receivable</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.branches.map((b) => (
                  <TableRow key={b.branchId}>
                    <TableCell>
                      <span className="font-mono text-xs font-medium">{b.code}</span>
                      <span className="ml-2 text-sm text-muted-foreground">{b.name}</span>
                    </TableCell>
                    <TableCell className="text-right"><Money value={b.balance} showIcon={false} size="sm" /></TableCell>
                    <TableCell className="hidden text-right sm:table-cell"><Money value={b.income} showIcon={false} size="sm" /></TableCell>
                    <TableCell className="hidden text-right sm:table-cell"><Money value={b.expenses} showIcon={false} size="sm" /></TableCell>
                    <TableCell className="text-right"><Money value={b.profit} direction="auto" showIcon={false} size="sm" /></TableCell>
                    <TableCell className="hidden text-right lg:table-cell"><Money value={b.receivable} showIcon={false} size="sm" /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent transactions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="space-y-2 p-5">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : d!.recentTransactions.length === 0 ? (
              <EmptyState icon={TrendingUp} title="Nothing posted yet" />
            ) : (
              <ul className="divide-y divide-border">
                {d!.recentTransactions.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{t.party ?? t.typeLabel}</div>
                      <div className="font-mono text-2xs text-muted-foreground">
                        {t.txnNo} · {formatDate(t.date)}
                      </div>
                    </div>
                    {t.moneyIn ? (
                      <Money value={t.moneyIn} direction="in" size="sm" />
                    ) : t.moneyOut ? (
                      <Money value={t.moneyOut} direction="out" size="sm" />
                    ) : (
                      <Money value={t.amount} showIcon={false} size="sm" className="text-muted-foreground" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top parties</CardTitle>
            <p className="text-xs text-muted-foreground">By outstanding balance, either direction.</p>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="space-y-2 p-5">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : d!.topParties.length === 0 ? (
              <EmptyState icon={Building2} title="No party balances yet" />
            ) : (
              <ul className="divide-y divide-border">
                {d!.topParties.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-5 py-2.5">
                    <Link to={`/khata/${p.id}`} className="min-w-0 flex-1 truncate text-sm hover:text-accent">
                      {p.name}
                    </Link>
                    <Badge variant={p.direction === "LENA" ? "success" : p.direction === "DENA" ? "danger" : "default"}>
                      {KHATA_LABEL[p.direction as keyof typeof KHATA_LABEL]}
                    </Badge>
                    <Money
                      value={Math.abs(p.balance)}
                      direction={p.direction === "LENA" ? "in" : "out"}
                      size="sm"
                      showIcon={false}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {m && m.pendingApprovals > 0 ? (
        <Card className="border-warning/40 bg-warning-subtle/40">
          <CardContent className="flex items-center gap-3 p-4">
            <ClipboardCheck className="size-5 shrink-0 text-warning" aria-hidden />
            <div className="flex-1 text-sm">
              <span className="font-medium text-foreground">
                {m.pendingApprovals} transaction{m.pendingApprovals === 1 ? "" : "s"} awaiting approval.
              </span>{" "}
              <span className="text-muted-foreground">
                The approval queue arrives in phase 6.
              </span>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</h2>
      {hint ? <span className="text-2xs text-muted-foreground/70">{hint}</span> : null}
    </div>
  );
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

