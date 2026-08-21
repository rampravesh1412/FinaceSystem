import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Handshake } from "lucide-react";
import type { SettlementRow } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { Can } from "@/features/auth/auth-context";
import { ExecuteSettlementButton, NewSettlementButton } from "./settlement-actions";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Settlements (§24).
 *
 * A settlement is an INTENT with postings hanging off it, which is what makes partial
 * settlement legible: the row shows what was agreed, what has actually been paid, and the
 * gap between them. A screen that only showed a status would hide the shortfall.
 */
export function SettlementsPage() {
  const [page, setPage] = React.useState(1);

  const query = useQuery({
    queryKey: ["settlements", page],
    queryFn: () => api.list<SettlementRow>(`/settlements${qs({ page, limit: 25 })}`),
    placeholderData: (prev) => prev,
  });

  const meta = query.data?.meta as { pendingAmount?: number } | undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settlements"
        description="Agreed amounts and what has actually been paid against them."
        actions={
          <Can permission="finance.settlement.create">
            <NewSettlementButton />
          </Can>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Outstanding to settle" value={meta?.pendingAmount} direction="out" loading={query.isPending} />
        <StatCard label="Settlements" value={query.data?.meta.total} asCount icon={Handshake} loading={query.isPending} />
        <StatCard
          label="Completed"
          value={query.data?.items.filter((s) => s.status === "COMPLETED").length}
          asCount
          loading={query.isPending}
        />
      </div>

      <Card className="overflow-hidden">
        {query.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={Handshake}
            title="Could not load settlements"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        ) : query.data.items.length === 0 ? (
          <EmptyState
            icon={Handshake}
            title="No settlements yet"
            description="A settlement records an agreed amount, then tracks the payments made against it."
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Settlement</TableHead>
                  <TableHead className="hidden sm:table-cell">Date</TableHead>
                  <TableHead>Between</TableHead>
                  <TableHead className="text-right">Agreed</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Charges</TableHead>
                  <TableHead className="text-right">Settled</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-20 screen-only"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((s) => {
                  const remaining = s.netAmount - s.settledAmount;
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <div className="font-mono text-xs font-medium">{s.settlementNo}</div>
                        <div className="text-2xs text-muted-foreground">{s.kind.toLowerCase()}</div>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground sm:table-cell">
                        {formatDate(s.date)}
                      </TableCell>
                      <TableCell>
                        <div className="truncate text-sm">{s.party?.name ?? s.destinationLabel}</div>
                        {s.sourceLabel !== "—" ? (
                          <div className="truncate text-2xs text-muted-foreground">from {s.sourceLabel}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right"><Money value={s.amount} showIcon={false} /></TableCell>
                      <TableCell className="hidden text-right lg:table-cell">
                        {s.charges ? <Money value={s.charges} showIcon={false} size="sm" className="text-muted-foreground" /> : <Dash />}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={s.settledAmount} direction="in" showIcon={false} />
                      </TableCell>
                      <TableCell className="text-right">
                        {/* The gap, always visible — this is what a status alone would hide. */}
                        {remaining > 0 ? (
                          <Money value={remaining} direction="out" showIcon={false} />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            s.status === "COMPLETED" ? "success"
                            : s.status === "PARTIAL" ? "warning"
                            : s.status === "CANCELLED" ? "danger" : "default"
                          }
                        >
                          {s.status.charAt(0) + s.status.slice(1).toLowerCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="screen-only">
                        <ExecuteSettlementButton settlement={s} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PaginationBar meta={query.data.meta} onPageChange={setPage} label="settlements" />
          </>
        )}
      </Card>
    </div>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;
