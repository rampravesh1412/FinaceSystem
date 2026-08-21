import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, CreditCard, Phone } from "lucide-react";
import { AGING_BUCKETS, type AgingRow, type CreditSummary } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Credit & aging (§12).
 *
 * The aging is FIFO against the open entries: a party's balance is made up of their
 * OLDEST unsettled amounts, because payments clear the oldest invoice first. That is how
 * a collections conversation actually goes — "the March invoice is 90 days late" — rather
 * than an average age nobody can act on.
 */
export function CreditPage() {
  const [params, setParams] = useSearchParams();
  const bucket = params.get("bucket") ?? "";
  const overdueOnly = params.get("overdueOnly") === "true";
  const overLimit = params.get("overLimit") === "true";

  const query = useQuery({
    queryKey: ["credit", { bucket, overdueOnly, overLimit }],
    queryFn: () =>
      api.get<{ rows: AgingRow[]; summary: CreditSummary }>(
        `/credit${qs({ bucket, overdueOnly: overdueOnly || undefined, overLimit: overLimit || undefined })}`,
      ),
  });

  const toggle = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (next.get(key) === value) next.delete(key);
    else next.set(key, value);
    setParams(next);
  };

  const summary = query.data?.summary;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Credit & Outstanding"
        description="What is owed, how long it has been owed, and who is past their limit."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total outstanding" value={summary?.totalOutstanding} direction="in" loading={query.isPending} />
        <StatCard label="Total overdue" value={summary?.totalOverdue} direction="out" loading={query.isPending} />
        <StatCard label="Due this week" value={summary?.dueThisWeek} loading={query.isPending} />
        <StatCard label="Over limit" value={summary?.overLimitCount} asCount icon={AlertTriangle} loading={query.isPending} />
      </div>

      {/* Aging buckets, clickable to filter the table beneath (§47). */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Aging</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-4">
            {AGING_BUCKETS.map((b) => {
              const value = summary?.buckets[b.key] ?? 0;
              const active = bucket === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => toggle("bucket", b.key)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "border-accent bg-accent/8" : "border-border hover:bg-surface-muted",
                    // Older money is more worrying; the tint says so without relying on
                    // colour alone, since the bucket label states the age in words.
                    b.key === "b90plus" && !active && "border-destructive/30",
                  )}
                >
                  <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {b.label}
                  </div>
                  {query.isPending ? (
                    <Skeleton className="mt-1 h-6 w-24" />
                  ) : (
                    <Money value={value} showIcon={false} size="lg" />
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          variant={overdueOnly ? "accent" : "outline"}
          size="sm"
          onClick={() => toggle("overdueOnly", "true")}
        >
          Overdue only
        </Button>
        <Button
          variant={overLimit ? "accent" : "outline"}
          size="sm"
          onClick={() => toggle("overLimit", "true")}
        >
          Over limit only
        </Button>
        {(bucket || overdueOnly || overLimit) ? (
          <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams())}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        {query.isPending ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={CreditCard}
            title="Could not load the credit report"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          />
        ) : query.data.rows.length === 0 ? (
          <EmptyState
            icon={CreditCard}
            title="Nothing matched"
            description="No party sits in this bucket. Clear the filters to see the whole book."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Party</TableHead>
                <TableHead className="hidden lg:table-cell">Contact</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Overdue</TableHead>
                <TableHead className="hidden text-right xl:table-cell">Due date</TableHead>
                <TableHead className="text-right">Days</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Credit left</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.rows.map((row) => (
                <TableRow key={row.partyId}>
                  <TableCell>
                    <Link
                      to={`/khata/${row.partyId}`}
                      className="block min-w-0 rounded hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="truncate text-sm font-medium">{row.name}</div>
                      <div className="truncate font-mono text-2xs text-muted-foreground">{row.code}</div>
                    </Link>
                  </TableCell>

                  <TableCell className="hidden lg:table-cell">
                    {row.mobile ? (
                      <a href={`tel:${row.mobile}`} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                        <Phone className="size-3" aria-hidden />
                        {row.mobile}
                      </a>
                    ) : <Dash />}
                  </TableCell>

                  <TableCell className="text-right">
                    <Money value={row.balance} direction="auto" showIcon={false} />
                  </TableCell>

                  <TableCell className="hidden text-right sm:table-cell">
                    {row.overdueAmount ? (
                      <Money value={row.overdueAmount} showIcon={false} className="text-destructive" />
                    ) : <Dash />}
                  </TableCell>

                  <TableCell className="hidden text-right text-xs text-muted-foreground xl:table-cell">
                    {row.dueDate ? formatDate(row.dueDate) : "—"}
                  </TableCell>

                  <TableCell className="text-right">
                    {row.daysOverdue > 0 ? (
                      <Badge variant={row.daysOverdue > 90 ? "danger" : row.daysOverdue > 30 ? "warning" : "outline"}>
                        {row.daysOverdue}d
                      </Badge>
                    ) : <Dash />}
                  </TableCell>

                  <TableCell className="hidden text-right lg:table-cell">
                    {row.creditLimit > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Money value={row.availableCredit} showIcon={false} size="sm" className="text-muted-foreground" />
                        {row.isOverLimit ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertTriangle className="size-3.5 text-warning" aria-label="Over limit" />
                            </TooltipTrigger>
                            <TooltipContent>Past their credit limit</TooltipContent>
                          </Tooltip>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-2xs text-muted-foreground">No limit</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {summary && (summary.topDebtors.length > 0 || summary.topCreditors.length > 0) ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <TopList title="Top debtors — they owe us" rows={summary.topDebtors} direction="in" />
          <TopList title="Top creditors — we owe them" rows={summary.topCreditors} direction="out" />
        </div>
      ) : null}
    </div>
  );
}

function TopList({
  title,
  rows,
  direction,
}: {
  title: string;
  rows: Array<{ id: string; name: string; balance: number }>;
  direction: "in" | "out";
}) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2">
              <Link to={`/khata/${r.id}`} className="truncate text-sm hover:text-accent">{r.name}</Link>
              <Money value={r.balance} direction={direction} showIcon={false} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;
