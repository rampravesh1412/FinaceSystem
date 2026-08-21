import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Scale, TrendingUp } from "lucide-react";
import type { ProfitAndLoss } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ExportMenu } from "@/components/export-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SERIES } from "@/components/charts";

/**
 * Profit & Loss (§34).
 *
 * The cash-movement figure sits at the bottom in its own panel, clearly separated from
 * the profit calculation above it. §21: they answer different questions, and putting
 * them in the same column would invite exactly the addition that must never happen.
 */
export function ProfitLossPage() {
  const [params, setParams] = useSearchParams();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  const from = params.get("from") ?? monthStart;
  const to = params.get("to") ?? today;

  const setRange = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next);
  };

  const query = useQuery({
    queryKey: ["pnl", { from, to }],
    queryFn: () => api.get<ProfitAndLoss>(`/reports/profit-loss${qs({ from, to })}`),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Profit & Loss"
        description="What the business earned over the period — income less expenses."
        actions={
          <div className="flex items-center gap-2">
            <Input type="date" value={from} onChange={(e) => setRange("from", e.target.value)} className="w-auto" aria-label="From" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={to} onChange={(e) => setRange("to", e.target.value)} className="w-auto" aria-label="To" />
            <ExportMenu path="/export/profit-loss" params={{ from, to }} />
          </div>
        }
      />

      {query.isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : query.isError ? (
        <Card>
          <EmptyState
            icon={Scale}
            title="Could not load the report"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="grid gap-4 p-5 sm:grid-cols-4">
              <Headline label="Income" value={query.data.totalIncome} />
              <Headline label="Expenses" value={query.data.totalExpenses} />
              <Headline label="Net profit" value={query.data.netProfit} emphasis />
              <div className="space-y-0.5">
                <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Margin</div>
                <div className="tabular text-2xl font-semibold tracking-tight">
                  {query.data.margin === null ? "—" : `${query.data.margin.toFixed(1)}%`}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="Income" lines={query.data.income} total={query.data.totalIncome} slot="primary" />
            <Section title="Expenses" lines={query.data.expenses} total={query.data.totalExpenses} slot="secondary" />
          </div>

          {query.data.totalCharges > 0 ? (
            <p className="text-xs text-muted-foreground">
              Of the expenses above, <Money value={query.data.totalCharges} showIcon={false} size="sm" /> was
              bank charges and commission — kept as its own subtotal so charges stay traceable.
            </p>
          ) : null}

          {/* Reported alongside, never inside. */}
          <Card className="border-dashed">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Cash movement over the same period</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Money value={query.data.cashMovement} direction="auto" size="xl" showIcon={false} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                This is <span className="font-medium text-foreground">not</span> the profit above and is
                deliberately not added to it. Cash movement is what passed through the bank and the
                drawer; profit is what was earned. Collecting an old debt moves cash without earning
                anything, and an unpaid invoice earns without moving cash.
              </p>
            </CardContent>
          </Card>

          <p className="text-2xs text-muted-foreground">
            {formatDate(query.data.from)} to {formatDate(query.data.to)} · generated {formatDate(query.data.generatedAt)}
          </p>
        </>
      )}
    </div>
  );
}

function Headline({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className="space-y-0.5">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <Money value={value} direction={emphasis ? "auto" : "neutral"} size="xl" showIcon={false} />
    </div>
  );
}

function Section({
  title,
  lines,
  total,
  slot,
}: {
  title: string;
  lines: ProfitAndLoss["income"];
  total: number;
  slot: "primary" | "secondary";
}) {
  const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const colour = SERIES[slot][isDark ? "dark" : "light"];

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        {lines.length === 0 ? (
          <EmptyState icon={TrendingUp} title={`No ${title.toLowerCase()} in this period`} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Head</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="hidden w-28 sm:table-cell">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.ledgerAccountId}>
                    <TableCell>
                      <div className="text-sm">{line.name}</div>
                      <div className="font-mono text-2xs text-muted-foreground">{line.code}</div>
                    </TableCell>
                    <TableCell className="text-right"><Money value={line.amount} showIcon={false} /></TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {/* A share bar rather than a pie: length is far easier to compare
                          than angle, and the percentage is written beside it anyway. */}
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${line.share}%`, backgroundColor: colour }}
                          />
                        </div>
                        <span className="tabular w-9 text-right text-2xs text-muted-foreground">
                          {line.share.toFixed(0)}%
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Separator />
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total</span>
              <Money value={total} showIcon={false} className="font-semibold" />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
