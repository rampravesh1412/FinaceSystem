import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { CalendarRange, TrendingDown, TrendingUp } from "lucide-react";
import type { MonthlyHistory, MonthlyHistoryRow } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Monthly history — the year read one row at a time.
 *
 * The P&L answers "how did we do over this window". This answers the question that comes
 * straight after it: "and how does that compare with the months before". Same arithmetic,
 * same source — the server computes a month's row exactly as the P&L computes its totals,
 * and a test pins them together so this table can never quietly drift from the report it
 * summarises.
 *
 * §21 is why cash sits in its own column group, separated from profit rather than beside
 * it: a month can bank a great deal and still have lost money, and the layout should make
 * that visible instead of inviting the reader to add the two.
 */
export function MonthlyHistoryPage() {
  const [params, setParams] = useSearchParams();

  const today = new Date().toISOString().slice(0, 10);
  // Twelve months back, so the page opens on a year of trading rather than one month.
  const defaultFrom = (() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 11);
    return `${d.toISOString().slice(0, 7)}-01`;
  })();

  const from = params.get("from") ?? defaultFrom;
  const to = params.get("to") ?? today;

  const setRange = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next);
  };

  const query = useQuery({
    queryKey: ["monthly-history", { from, to }],
    queryFn: () => api.get<MonthlyHistory>(`/reports/monthly-history${qs({ from, to })}`),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Monthly history"
        description="Profit, expenses and party movement, month by month."
        actions={
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={from}
              onChange={(e) => setRange("from", e.target.value)}
              className="w-auto"
              aria-label="From"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => setRange("to", e.target.value)}
              className="w-auto"
              aria-label="To"
            />
          </div>
        }
      />

      {query.isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : query.isError ? (
        <Card>
          <EmptyState
            icon={CalendarRange}
            title="Could not load the history"
            description={
              query.error instanceof ApiError ? query.error.message : "Something went wrong."
            }
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : query.data.months.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarRange}
            title="No months in this range"
            description="Widen the dates to cover at least one month."
          />
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="grid gap-4 p-5 sm:grid-cols-4">
              <Headline label="Income" value={query.data.totals.income} />
              <Headline label="Expenses" value={query.data.totals.expenses} />
              <Headline label="Net profit" value={query.data.totals.netProfit} emphasis />
              <div className="space-y-0.5">
                <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Margin
                </div>
                <div className="tabular text-2xl font-semibold tracking-tight">
                  {query.data.totals.margin === null
                    ? "—"
                    : `${query.data.totals.margin.toFixed(1)}%`}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Month by month</CardTitle>
            </CardHeader>
            <CardContent>
              {/* The table is wide; it scrolls inside its own box rather than the page. */}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Income</TableHead>
                      <TableHead className="text-right">Expenses</TableHead>
                      <TableHead className="text-right">Net profit</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Party balance</TableHead>
                      <TableHead className="text-right">Cash net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.months.map((month) => (
                      <MonthRow
                        key={month.month}
                        month={month}
                        best={month.month === query.data.bestMonth}
                        worst={month.month === query.data.worstMonth}
                      />
                    ))}

                    <TableRow className="border-t-2 font-medium">
                      <TableCell>Total</TableCell>
                      <TableCell className="text-right">
                        <Money value={query.data.totals.income} showIcon={false} size="sm" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={query.data.totals.expenses} showIcon={false} size="sm" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={query.data.totals.netProfit}
                          direction="auto"
                          showIcon={false}
                          size="sm"
                        />
                      </TableCell>
                      <TableCell className="text-right tabular text-xs text-muted-foreground">
                        {query.data.totals.margin === null
                          ? "—"
                          : `${query.data.totals.margin.toFixed(1)}%`}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={query.data.totals.partyReceived}
                          showIcon={false}
                          size="sm"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={query.data.totals.partyPaid} showIcon={false} size="sm" />
                      </TableCell>
                      {/* A closing position is not a column that sums. */}
                      <TableCell className="text-right text-muted-foreground">—</TableCell>
                      <TableCell className="text-right">
                        <Money
                          value={query.data.totals.cashNet}
                          direction="auto"
                          showIcon={false}
                          size="sm"
                        />
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {query.data.totals.charges > 0 ? (
            <p className="text-xs text-muted-foreground">
              Of the expenses above,{" "}
              <Money value={query.data.totals.charges} showIcon={false} size="sm" /> was bank
              charges and commission — kept traceable rather than folded into other expenses.
            </p>
          ) : null}

          <Card className="border-dashed">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Why cash sits apart from profit</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs leading-relaxed text-muted-foreground">
                The <span className="font-medium text-foreground">Cash net</span> column is what
                passed through the bank and the drawer. It is{" "}
                <span className="font-medium text-foreground">not</span> the net profit beside it
                and is never added to it. Collecting an old debt moves cash without earning
                anything; an unpaid invoice earns without moving cash. A month can do well on one
                column and badly on the other.
              </p>
            </CardContent>
          </Card>

          <p className="text-2xs text-muted-foreground">
            {formatDate(query.data.from)} to {formatDate(query.data.to)} · generated{" "}
            {formatDate(query.data.generatedAt)}
          </p>
        </>
      )}
    </div>
  );
}

function MonthRow({
  month,
  best,
  worst,
}: {
  month: MonthlyHistoryRow;
  best: boolean;
  worst: boolean;
}) {
  // A month nobody traded in is shown, and shown as quiet — the row being present is the
  // point, since a missing row reads as a broken report rather than a quiet month.
  const quiet = month.entries === 0;

  return (
    <TableRow className={quiet ? "text-muted-foreground" : undefined}>
      <TableCell className="whitespace-nowrap font-medium">
        <span className="flex items-center gap-1.5">
          {month.label}
          {best && !quiet ? (
            <Badge variant="info" className="gap-1">
              <TrendingUp className="size-3" aria-hidden />
              Best
            </Badge>
          ) : null}
          {worst && !best && !quiet ? (
            <Badge variant="outline" className="gap-1">
              <TrendingDown className="size-3" aria-hidden />
              Lowest
            </Badge>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <Money value={month.income} showIcon={false} size="sm" />
      </TableCell>
      <TableCell className="text-right">
        <Money value={month.expenses} showIcon={false} size="sm" />
      </TableCell>
      <TableCell className="text-right">
        <Money value={month.netProfit} direction="auto" showIcon={false} size="sm" />
      </TableCell>
      <TableCell className="text-right tabular text-xs">
        {month.margin === null ? "—" : `${month.margin.toFixed(1)}%`}
      </TableCell>
      <TableCell className="text-right">
        <Money value={month.partyReceived} showIcon={false} size="sm" />
      </TableCell>
      <TableCell className="text-right">
        <Money value={month.partyPaid} showIcon={false} size="sm" />
      </TableCell>
      <TableCell className="text-right">
        <Money value={month.partyClosing} direction="auto" showIcon={false} size="sm" />
      </TableCell>
      <TableCell className="text-right">
        <Money value={month.cashNet} direction="auto" showIcon={false} size="sm" />
      </TableCell>
    </TableRow>
  );
}

function Headline({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <Money
        value={value}
        direction={emphasis ? "auto" : undefined}
        showIcon={false}
        size="xl"
      />
    </div>
  );
}
