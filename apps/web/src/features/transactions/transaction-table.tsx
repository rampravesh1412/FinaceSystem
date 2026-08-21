import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Notebook, Search, Undo2 } from "lucide-react";
import type { BadgeProps } from "@/components/ui/badge";
import type { TransactionRow } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useDebounced } from "@/hooks/use-debounced";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TransactionDrawer } from "./transaction-drawer";
import { cn } from "@/lib/utils";

export function statusVariant(status: string): BadgeProps["variant"] {
  switch (status) {
    case "COMPLETED": return "success";
    case "PENDING": return "warning";
    case "REVERSED": return "danger";
    case "DRAFT": return "outline";
    case "REJECTED":
    case "FAILED": return "danger";
    default: return "default";
  }
}

export interface TransactionTableProps {
  /** REST path to read from: /transactions, /payment-in, /expenses… */
  endpoint: string;
  /** Cache key segment, so each screen keeps its own page state. */
  cacheKey: string;
  searchPlaceholder?: string;
  /** Hide the type column on a screen that only shows one type. */
  showType?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}

/**
 * The transaction table (§45), shared by the DayBook and every per-type screen.
 *
 * One implementation rather than five that drift apart. Filters live in the URL so a view
 * is shareable and survives a refresh (§64), and paging is server-side — a DayBook that
 * fetched a year of transactions into the browser would be unusable by March (§69).
 */
export function TransactionTable({
  endpoint,
  cacheKey,
  searchPlaceholder = "Search voucher no, reference or narration…",
  showType = true,
  emptyTitle = "No transactions yet",
  emptyDescription = "Nothing has been posted for this view.",
}: TransactionTableProps) {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  const [search, setSearch] = React.useState(params.get("q") ?? "");
  const debounced = useDebounced(search, 300);
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced) next.set("q", debounced);
    else next.delete("q");
    if (next.get("q") !== params.get("q")) {
      next.set("page", "1");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.set("page", "1");
    setParams(next);
  };

  const query = useQuery({
    queryKey: [cacheKey, { page, q: debounced, from, to }],
    queryFn: () =>
      api.list<TransactionRow>(`${endpoint}${qs({ page, limit: 25, q: debounced, from, to })}`),
    placeholderData: (prev) => prev,
  });

  const meta = query.data?.meta as
    | { moneyIn?: number; moneyOut?: number; charges?: number; net?: number }
    | undefined;

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-9"
              aria-label="Search transactions"
            />
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={from}
              onChange={(e) => setParam("from", e.target.value)}
              className="w-auto"
              aria-label="From date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => setParam("to", e.target.value)}
              className="w-auto"
              aria-label="To date"
            />
            {(from || to) ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("from");
                  next.delete("to");
                  setParams(next);
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        {/* Totals across the whole filtered set, not just the visible page. */}
        {meta && (meta.moneyIn || meta.moneyOut) ? (
          <div className="grid gap-4 border-b border-border bg-surface-muted/40 px-4 py-3 sm:grid-cols-4">
            <Total label="Money In" value={meta.moneyIn ?? 0} direction="in" />
            <Total label="Money Out" value={meta.moneyOut ?? 0} direction="out" />
            <Total label="Charges" value={meta.charges ?? 0} direction="neutral" />
            <Total label="Net" value={meta.net ?? 0} direction="auto" />
          </div>
        ) : null}

        {query.isPending ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={Notebook}
            title="Could not load transactions"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        ) : query.data.items.length === 0 ? (
          <EmptyState
            icon={Notebook}
            title={debounced || from || to ? "Nothing matched" : emptyTitle}
            description={debounced || from || to ? "Try widening the date range or clearing the search." : emptyDescription}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Voucher</TableHead>
                  <TableHead className="hidden sm:table-cell">Date</TableHead>
                  {showType ? <TableHead className="hidden lg:table-cell">Type</TableHead> : null}
                  <TableHead>Name / Account</TableHead>
                  <TableHead className="hidden xl:table-cell">Mode</TableHead>
                  <TableHead className="text-right">Money In</TableHead>
                  <TableHead className="text-right">Money Out</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Charges</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {query.data.items.map((txn) => (
                  <TableRow
                    key={txn.id}
                    onClick={() => setOpenId(txn.id)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenId(txn.id);
                      }
                    }}
                    className={cn(
                      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      txn.status === "REVERSED" && "opacity-60",
                    )}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs font-medium">{txn.txnNo}</span>
                        {txn.isReversal ? (
                          <Undo2 className="size-3 text-warning" aria-label="reversal" />
                        ) : null}
                      </div>
                      <div className="text-2xs text-muted-foreground sm:hidden">{formatDate(txn.date)}</div>
                    </TableCell>

                    <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground sm:table-cell">
                      {formatDate(txn.date)}
                    </TableCell>

                    {showType ? (
                      <TableCell className="hidden lg:table-cell">
                        <Badge variant="outline">{txn.typeLabel}</Badge>
                      </TableCell>
                    ) : null}

                    <TableCell>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {txn.party?.name ?? txn.accountLabel}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {txn.party ? txn.accountLabel : (txn.narration ?? "—")}
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className="hidden xl:table-cell">
                      {txn.paymentMode ? (
                        <span className="text-xs text-muted-foreground">
                          {txn.paymentMode.replace(/_/g, " ")}
                        </span>
                      ) : <Dash />}
                    </TableCell>

                    <TableCell className="text-right">
                      {txn.moneyIn ? <Money value={txn.moneyIn} direction="in" /> : <Dash />}
                    </TableCell>
                    <TableCell className="text-right">
                      {txn.moneyOut ? <Money value={txn.moneyOut} direction="out" /> : <Dash />}
                    </TableCell>
                    <TableCell className="hidden text-right lg:table-cell">
                      {txn.chargeAmount ? (
                        <Money value={txn.chargeAmount} showIcon={false} size="sm" className="text-muted-foreground" />
                      ) : <Dash />}
                    </TableCell>

                    <TableCell>
                      <Badge variant={statusVariant(txn.status)}>
                        {txn.status.charAt(0) + txn.status.slice(1).toLowerCase()}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <PaginationBar meta={query.data.meta} onPageChange={(p) => setParam("page", String(p))} label="transactions" />
          </>
        )}
      </Card>

      <TransactionDrawer transactionId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function Total({ label, value, direction }: { label: string; value: number; direction: "in" | "out" | "auto" | "neutral" }) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <Money value={value} direction={direction} showIcon={false} className="font-semibold" />
    </div>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;
