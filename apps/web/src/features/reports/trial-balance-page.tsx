import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileSpreadsheet, TriangleAlert } from "lucide-react";
import type { TrialBalance } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ExportMenu } from "@/components/export-menu";
import { VirtualNotice, VirtualRows, VirtualScroller } from "@/components/virtual-rows";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Trial balance (§34).
 *
 * The report whose entire job is to prove the books tie. It is computed from ledger
 * ENTRIES, never from cached account balances — a check derived from the thing it is
 * checking proves nothing.
 *
 * `difference` is displayed prominently even when it is zero. Hiding it while it is zero
 * and revealing it when it is not would mean the one screen that can tell you the ledger
 * has broken looks identical either way until you notice a new element appearing.
 */
export function TrialBalancePage() {
  const [asOf, setAsOf] = React.useState(() => new Date().toISOString().slice(0, 10));
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ["trial-balance", asOf],
    queryFn: () => api.get<TrialBalance>(`/ledger/trial-balance${qs({ asOf })}`),
    placeholderData: (prev) => prev,
  });

  const tb = query.data;
  const ties = tb?.difference === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Trial Balance"
        description="Every account's net position, computed from entries. Debits must equal credits."
        actions={<ExportMenu path="/export/trial-balance" params={{ asOf }} />}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="asOf">As at</Label>
          <Input id="asOf" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-auto" />
        </div>

        {tb ? (
          <div
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              ties
                ? "border-success/40 bg-success/5 text-success-foreground"
                : "border-destructive/40 bg-destructive/5 text-destructive"
            }`}
          >
            {ties ? (
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            ) : (
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
            )}
            <span>
              {ties ? (
                <>The ledger ties. Difference <span className="tabular font-medium">₹0.00</span>.</>
              ) : (
                <>
                  {/* §62: reported, never repaired. A trial balance that did not tie would be
                      a posting bug, and the only correct response is to show it. */}
                  Out of balance by{" "}
                  <span className="tabular font-semibold">
                    <Money value={Math.abs(tb.difference)} showIcon={false} size="sm" />
                  </span>{" "}
                  — this is a posting fault, not something to adjust away.
                </>
              )}
            </span>
          </div>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        {query.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={FileSpreadsheet}
            title="Could not load the trial balance"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          />
        ) : tb!.rows.length === 0 ? (
          <EmptyState
            icon={FileSpreadsheet}
            title="Nothing posted yet"
            description={`No ledger entries exist on or before ${formatDate(asOf)}.`}
          />
        ) : (
          <>
            {/* Windowed above 150 rows: a chart of accounts with five thousand parties is
                five thousand rows, and the report is worthless if it shows a subset. */}
            <VirtualScroller scrollRef={scrollRef}>
              <Table className="table-sticky-head" wrapperClassName="overflow-visible">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">Code</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="hidden sm:table-cell">Class</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <VirtualRows rows={tb!.rows} scrollRef={scrollRef} columns={5} estimateRowHeight={41}>
                    {(row) => (
                      <TableRow key={row.ledgerAccountId}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{row.code}</TableCell>
                        <TableCell className="text-sm">{row.name}</TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Badge variant="outline" className="text-2xs">
                            {row.accountClass.toLowerCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {row.debit ? <Money value={row.debit} showIcon={false} /> : <Dash />}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.credit ? <Money value={row.credit} showIcon={false} /> : <Dash />}
                        </TableCell>
                      </TableRow>
                    )}
                  </VirtualRows>
                </TableBody>
              </Table>
            </VirtualScroller>

            {/* Totals live OUTSIDE the scroller. They are the point of the report, and a
                footer that scrolls out of sight in a five-thousand-row table is a footer
                nobody reads. */}
            <Table>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3} className="text-xs uppercase tracking-wider text-muted-foreground">
                    Totals
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={tb!.totalDebit} showIcon={false} className="font-semibold" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={tb!.totalCredit} showIcon={false} className="font-semibold" />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>

            <VirtualNotice total={tb!.rows.length} />
          </>
        )}
      </Card>
    </div>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;
