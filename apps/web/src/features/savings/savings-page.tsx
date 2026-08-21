import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { PiggyBank, Search } from "lucide-react";
import type { SavingsAccountSummary } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useDebounced } from "@/hooks/use-debounced";
import { formatDate, relativeTime } from "@/lib/utils";
import { Money } from "@/components/money";
import { Can } from "@/features/auth/auth-context";
import { NewSavingsAccountButton, SavingsTransactionButtons } from "./savings-actions";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SavingsPassbook } from "./savings-passbook";

/**
 * Bachat Khata (§13).
 *
 * A member's balance is a LIABILITY of ours — the money is theirs and we are holding it.
 * The totals here are therefore "what we hold on behalf of members", not our own assets,
 * which is why they are labelled that way rather than as a balance we own.
 */
export function SavingsPage() {
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const debounced = useDebounced(search, 300);

  React.useEffect(() => setPage(1), [debounced]);

  const query = useQuery({
    queryKey: ["savings", { page, q: debounced }],
    queryFn: () => api.list<SavingsAccountSummary>(`/savings${qs({ page, limit: 25, q: debounced })}`),
    placeholderData: (prev) => prev,
  });

  const meta = query.data?.meta as
    | { totalSavings?: number; todayCollection?: number; todayWithdrawal?: number; memberCount?: number }
    | undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bachat Khata"
        description="Member savings. Every balance here is money we hold on their behalf, not our own."
        actions={
          <Can permission="finance.savings.manage">
            <NewSavingsAccountButton />
          </Can>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Held for members" value={meta?.totalSavings} loading={query.isPending} />
        <StatCard label="Today's collection" value={meta?.todayCollection} direction="in" loading={query.isPending} />
        <StatCard label="Today's withdrawal" value={meta?.todayWithdrawal} direction="out" loading={query.isPending} />
        <StatCard label="Members" value={meta?.memberCount} asCount icon={PiggyBank} loading={query.isPending} />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border p-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search member, account no or mobile…"
              className="pl-9"
              aria-label="Search savings accounts"
            />
          </div>
        </div>

        {query.isPending ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={PiggyBank}
            title="Could not load savings accounts"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        ) : query.data.items.length === 0 ? (
          <EmptyState
            icon={PiggyBank}
            title={debounced ? "No member matched" : "No savings accounts yet"}
            description={debounced ? `Nothing matched “${debounced}”.` : "Open an account to start recording deposits."}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead className="hidden md:table-cell">Account no</TableHead>
                  <TableHead className="hidden xl:table-cell">Branch</TableHead>
                  <TableHead className="hidden lg:table-cell text-right">Rate</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="hidden sm:table-cell">Last activity</TableHead>
                  <TableHead className="w-44 screen-only"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((account) => (
                  <TableRow
                    key={account.id}
                    onClick={() => setOpenId(account.id)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenId(account.id);
                      }
                    }}
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <TableCell>
                      <div className="text-sm font-medium">{account.memberName}</div>
                      {account.mobile ? (
                        <div className="text-xs text-muted-foreground">{account.mobile}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">{account.accountNo}</TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <Badge variant="outline" className="font-mono">{account.branch.code}</Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell tabular text-right text-xs text-muted-foreground">
                      {account.interestRateBps > 0 ? `${account.interestRateBps / 100}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={account.balance} showIcon={false} />
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                      {account.lastTransactionAt ? relativeTime(account.lastTransactionAt) : `Opened ${formatDate(account.openedAt)}`}
                    </TableCell>
                    <TableCell
                      className="screen-only"
                      /* The row opens the passbook; the buttons must not trigger that too. */
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SavingsTransactionButtons account={account} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationBar meta={query.data.meta} onPageChange={setPage} label="members" />
          </>
        )}
      </Card>

      <SavingsPassbook savingsAccountId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
