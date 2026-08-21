import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, Scale, TriangleAlert } from "lucide-react";
import type { BalanceSheet } from "@amiri/shared";
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

/**
 * Balance Sheet (§34).
 *
 * The accounting identity is stated at the top and checked, not assumed. If assets ever
 * failed to equal liabilities plus equity the banner would say so rather than the page
 * quietly rendering a sheet that does not balance.
 */
export function BalanceSheetPage() {
  const [params, setParams] = useSearchParams();
  const asOf = params.get("asOf") ?? new Date().toISOString().slice(0, 10);

  const query = useQuery({
    queryKey: ["balance-sheet", asOf],
    queryFn: () => api.get<BalanceSheet>(`/reports/balance-sheet${qs({ asOf })}`),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Balance Sheet"
        description="What the business owns, owes, and is worth, as at a date."
        actions={
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={asOf}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.set("asOf", e.target.value);
                setParams(next);
              }}
              className="w-auto"
              aria-label="As at"
            />
            <ExportMenu path="/export/balance-sheet" params={{ asOf }} />
          </div>
        }
      />

      {query.isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : query.isError ? (
        <Card>
          <EmptyState
            icon={Scale}
            title="Could not load the balance sheet"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        </Card>
      ) : (
        <>
          {/* The identity, checked. Colour is paired with an icon and words. */}
          <div
            className={
              query.data.balances
                ? "flex items-center gap-3 rounded-lg border border-success/30 bg-success-subtle px-4 py-3"
                : "flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/8 px-4 py-3"
            }
          >
            {query.data.balances ? (
              <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
            ) : (
              <TriangleAlert className="size-5 shrink-0 text-destructive" aria-hidden />
            )}
            <div className="text-sm">
              <span className="font-medium text-foreground">
                {query.data.balances ? "The sheet balances." : "THE SHEET DOES NOT BALANCE."}
              </span>{" "}
              <span className="text-muted-foreground">
                Assets <Money value={query.data.totalAssets} showIcon={false} size="sm" /> = liabilities{" "}
                <Money value={query.data.totalLiabilities} showIcon={false} size="sm" /> + equity{" "}
                <Money value={query.data.totalEquity} showIcon={false} size="sm" />
                {query.data.balances ? "." : ` — out by ${query.data.difference / 100}. This is a bug; do not rely on this report.`}
              </span>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="Assets" subtitle="What we own and are owed" lines={query.data.assets} total={query.data.totalAssets} />

            <div className="space-y-5">
              <Section title="Liabilities" subtitle="What we owe" lines={query.data.liabilities} total={query.data.totalLiabilities} />

              <Card className="overflow-hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Equity</CardTitle>
                  <p className="text-xs text-muted-foreground">Owner's stake plus what has been earned</p>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableBody>
                      {query.data.equity.map((line) => (
                        <TableRow key={line.ledgerAccountId}>
                          <TableCell className="text-sm">{line.name}</TableCell>
                          <TableCell className="text-right"><Money value={line.amount} showIcon={false} /></TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableCell className="text-sm">
                          Retained earnings
                          <div className="text-2xs text-muted-foreground">
                            Income less expenses to date — computed, not a stored account
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={query.data.retainedEarnings} direction="auto" showIcon={false} />
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                  <Separator />
                  <div className="flex items-center justify-between px-3 py-2.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total equity</span>
                    <Money value={query.data.totalEquity} showIcon={false} className="font-semibold" />
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <p className="text-2xs text-muted-foreground">
            As at {formatDate(query.data.asOf)} · generated {formatDate(query.data.generatedAt)}
          </p>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  lines,
  total,
}: {
  title: string;
  subtitle: string;
  lines: BalanceSheet["assets"];
  total: number;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="p-0">
        {lines.length === 0 ? (
          <EmptyState icon={Scale} title={`No ${title.toLowerCase()}`} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Separator />
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total {title.toLowerCase()}</span>
              <Money value={total} showIcon={false} className="font-semibold" />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
