import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Phone, Search, Users } from "lucide-react";
import { KHATA_LABEL, type PartySummary } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { Can } from "@/features/auth/auth-context";
import { NewPartyButton } from "./party-form";
import { PartyRowActions } from "./party-edit";
import { useDebounced } from "@/hooks/use-debounced";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { Money } from "@/components/money";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Parties (§10) — the master behind the Digital Khata.
 *
 * The balance filter lives in the URL, so "show me everyone who owes us" is a shareable
 * link and survives a refresh (§64). Filtering happens on the SERVER, in an aggregation
 * over the ledger — the browser never receives the parties it is not showing.
 */

type BalanceFilter = "all" | "lena" | "dena" | "clear";

const FILTERS: Array<{ key: BalanceFilter; label: string; hint: string }> = [
  { key: "all", label: "All", hint: "Every party" },
  { key: "lena", label: "Lena Hai", hint: "They owe us — receivable" },
  { key: "dena", label: "Dena Hai", hint: "We owe them — payable" },
  { key: "clear", label: "Clear", hint: "Settled" },
];

export function PartiesPage() {
  const [params, setParams] = useSearchParams();
  const balance = (params.get("balance") as BalanceFilter | null) ?? "all";
  const page = Number(params.get("page") ?? 1);

  const [search, setSearch] = React.useState(params.get("q") ?? "");
  const debounced = useDebounced(search, 300);

  // Keep the URL authoritative so the view is shareable and back/forward behave.
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

  const setFilter = (key: BalanceFilter) => {
    const next = new URLSearchParams(params);
    if (key === "all") next.delete("balance");
    else next.set("balance", key);
    next.set("page", "1");
    setParams(next);
  };

  const setPage = (value: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(value));
    setParams(next);
  };

  const query = useQuery({
    queryKey: ["parties", { page, balance, q: debounced }],
    queryFn: () =>
      api.list<PartySummary>(`/parties${qs({ page, limit: 25, balance, q: debounced })}`),
    placeholderData: (prev) => prev,
  });

  const meta = query.data?.meta as
    | { totalReceivable?: number; totalPayable?: number }
    | undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Parties"
        description="Customers, vendors, distributors and agents — one ledger account each."
        actions={
          <Can permission="finance.party.create">
            <NewPartyButton />
          </Can>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total receivable — Lena Hai"
          value={meta?.totalReceivable}
          direction="in"
          loading={query.isPending}
          to="/parties?balance=lena"
        />
        <StatCard
          label="Total payable — Dena Hai"
          value={meta?.totalPayable}
          direction="out"
          loading={query.isPending}
          to="/parties?balance=dena"
        />
        <StatCard
          label="Net position"
          value={
            meta ? (meta.totalReceivable ?? 0) - (meta.totalPayable ?? 0) : undefined
          }
          direction="auto"
          loading={query.isPending}
        />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, code, mobile or GSTIN…"
              className="pl-9"
              aria-label="Search parties"
            />
          </div>

          <div className="flex flex-wrap gap-1 rounded-lg bg-surface-muted p-1" role="group" aria-label="Balance filter">
            {FILTERS.map((f) => (
              <Tooltip key={f.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setFilter(f.key)}
                    aria-pressed={balance === f.key}
                    className={cn(
                      "rounded-md px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      balance === f.key
                        ? "bg-surface text-foreground shadow-subtle"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{f.hint}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>

        {query.isPending ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={Users}
            title="Could not load parties"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        ) : query.data.items.length === 0 ? (
          <EmptyState
            icon={Users}
            title={debounced || balance !== "all" ? "No parties matched" : "No parties yet"}
            description={
              debounced
                ? `Nothing matched “${debounced}”.`
                : balance !== "all"
                  ? "No party currently sits in this position."
                  : "Add a party to start keeping a khata against them."
            }
            action={
              balance !== "all" ? (
                <Button variant="outline" size="sm" onClick={() => setFilter("all")}>
                  Clear filter
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Party</TableHead>
                  <TableHead className="hidden lg:table-cell">Type</TableHead>
                  <TableHead className="hidden md:table-cell">Contact</TableHead>
                  <TableHead className="hidden sm:table-cell">Branch</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden text-right xl:table-cell">Credit left</TableHead>
                  <TableHead className="w-12 screen-only"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {query.data.items.map((party) => (
                  <TableRow key={party.id}>
                    <TableCell>
                      <Link
                        to={`/parties/${party.id}`}
                        className="block min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="truncate text-sm font-medium hover:text-accent">{party.name}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">{party.code}</div>
                      </Link>
                    </TableCell>

                    <TableCell className="hidden lg:table-cell">
                      <Badge variant="outline">
                        {party.type.charAt(0) + party.type.slice(1).toLowerCase()}
                      </Badge>
                    </TableCell>

                    <TableCell className="hidden md:table-cell">
                      {party.mobile ? (
                        <a
                          href={`tel:${party.mobile}`}
                          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Phone className="size-3" aria-hidden />
                          {party.mobile}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="outline" className="font-mono">{party.branch.code}</Badge>
                    </TableCell>

                    <TableCell className="text-right">
                      {/* Amount shown unsigned; the LENA/DENA chip beside it carries the
                          direction, which is how the khata is actually read. */}
                      <Money
                        value={Math.abs(party.balance)}
                        direction={party.direction === "LENA" ? "in" : party.direction === "DENA" ? "out" : "neutral"}
                        showIcon={false}
                      />
                    </TableCell>

                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant={
                            party.direction === "LENA" ? "success" : party.direction === "DENA" ? "danger" : "default"
                          }
                        >
                          {KHATA_LABEL[party.direction]}
                        </Badge>
                        {party.isOverLimit ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertTriangle className="size-4 text-warning" aria-label="Over credit limit" />
                            </TooltipTrigger>
                            <TooltipContent>Past their credit limit</TooltipContent>
                          </Tooltip>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell className="hidden text-right xl:table-cell">
                      {party.creditLimit > 0 ? (
                        <Money value={party.availableCredit} showIcon={false} className="text-muted-foreground" />
                      ) : (
                        <span className="text-xs text-muted-foreground">No limit</span>
                      )}
                    </TableCell>

                    <TableCell className="screen-only">
                      <PartyRowActions party={party} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <PaginationBar meta={query.data.meta} onPageChange={setPage} label="parties" />
          </>
        )}
      </Card>
    </div>
  );
}
