import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Landmark, Lock, Search, TriangleAlert, Wallet } from "lucide-react";
import type { BankAccountSummary, CashAccountSummary } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { Can, useAuth } from "@/features/auth/auth-context";
import { NewAccountButton } from "./account-form";
import { BankAccountRowActions, CashAccountRowActions } from "./banking-edit";
import { useDebounced } from "@/hooks/use-debounced";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Bank and cash accounts (§7).
 *
 * Every balance shown here is derived from ledger entries — nothing on this screen reads
 * a stored balance field, because there isn't one. The account number arrives already
 * masked unless the caller holds `finance.bank.viewFull`; the client never receives the
 * digits and hides them.
 */
export function BankAccountsPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Accounts"
        description="Bank accounts and cash drawers. Balances are computed from the ledger, not stored."
        actions={
          <Can permission="bank_accounts.create">
            <NewAccountButton />
          </Can>
        }
      />

      <Tabs defaultValue="bank">
        <TabsList>
          <TabsTrigger value="bank">
            <Landmark className="mr-1.5 size-3.5" />
            Bank
          </TabsTrigger>
          <TabsTrigger value="cash">
            <Wallet className="mr-1.5 size-3.5" />
            Cash
          </TabsTrigger>
        </TabsList>

        <TabsContent value="bank">
          <BankAccountsTable />
        </TabsContent>
        <TabsContent value="cash">
          <CashAccountsTable />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BankAccountsTable() {
  const { can } = useAuth();
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const debounced = useDebounced(search, 300);

  React.useEffect(() => setPage(1), [debounced]);

  const query = useQuery({
    queryKey: ["bank-accounts", { page, q: debounced }],
    queryFn: () =>
      api.list<BankAccountSummary>(`/bank-accounts${qs({ page, limit: 25, q: debounced })}`),
    placeholderData: (prev) => prev,
  });

  const totalBalance = (query.data?.meta as { totalBalance?: number } | undefined)?.totalBalance ?? 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search account, number or IFSC…"
            className="pl-9"
            aria-label="Search bank accounts"
          />
        </div>

        {!can("bank_accounts.viewFull") ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="w-fit">
                <Lock className="size-3" />
                Account numbers masked
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              Your role does not include <code>finance.bank.viewFull</code>. The full digits are
              never sent to your browser.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {query.isPending ? (
        <RowsSkeleton />
      ) : query.isError ? (
        <EmptyState
          icon={Landmark}
          title="Could not load accounts"
          description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
        />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title={debounced ? "No accounts matched" : "No bank accounts yet"}
          description={
            debounced
              ? `Nothing matched “${debounced}”.`
              : "Add a bank account to start recording transfers and payments against it."
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="hidden md:table-cell">Number</TableHead>
                <TableHead className="hidden lg:table-cell">IFSC</TableHead>
                <TableHead className="hidden xl:table-cell">Type</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Available</TableHead>
                <TableHead className="w-12 screen-only"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {query.data.items.map((account) => (
                <TableRow key={account.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent/10">
                        <Landmark className="size-4 text-accent" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{account.accountName}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {account.bank.shortName ?? account.bank.name}
                        </div>
                      </div>
                      {account.isLowBalance ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <TriangleAlert className="size-4 shrink-0 text-warning" aria-label="Low balance" />
                          </TooltipTrigger>
                          <TooltipContent>Below the low-balance threshold</TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>
                  </TableCell>

                  <TableCell className="hidden font-mono text-xs md:table-cell">
                    <span className="inline-flex items-center gap-1.5">
                      {account.accountNumber}
                      {account.accountNumberMasked ? (
                        <Lock className="size-3 text-muted-foreground" aria-label="masked" />
                      ) : null}
                    </span>
                  </TableCell>

                  <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                    {account.ifsc}
                  </TableCell>

                  <TableCell className="hidden xl:table-cell">
                    <Badge variant={account.accountType === "OD" ? "warning" : "default"}>
                      {account.accountType}
                    </Badge>
                  </TableCell>

                  <TableCell className="text-right">
                    {/* "auto" so an overdrawn account reads as negative, with a glyph as
                        well as colour. */}
                    <Money value={account.balance} direction="auto" showIcon={false} />
                  </TableCell>

                  <TableCell className="hidden text-right text-muted-foreground lg:table-cell">
                    <Money value={account.availableBalance} showIcon={false} />
                  </TableCell>

                  <TableCell className="screen-only">
                    <BankAccountRowActions account={account} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>

            {/* The total covers the whole filtered set, not just this page — a footer that
                silently summed 25 of 60 rows would be worse than no footer. */}
            <TableFooter>
              <TableRow>
                <TableCell colSpan={5} className="hidden text-xs uppercase tracking-wider text-muted-foreground sm:table-cell">
                  Total across {query.data.meta.total} account{query.data.meta.total === 1 ? "" : "s"}
                </TableCell>
                <TableCell className="sm:hidden text-xs uppercase text-muted-foreground">Total</TableCell>
                <TableCell className="text-right">
                  <Money value={totalBalance} direction="auto" size="md" showIcon={false} className="font-semibold" />
                </TableCell>
                <TableCell className="hidden lg:table-cell" />
                <TableCell className="screen-only" />
              </TableRow>
            </TableFooter>
          </Table>

          <PaginationBar meta={query.data.meta} onPageChange={setPage} label="accounts" />
        </>
      )}
    </Card>
  );
}

function CashAccountsTable() {
  const query = useQuery({
    queryKey: ["cash-accounts"],
    queryFn: () => api.list<CashAccountSummary>(`/cash-accounts${qs({ limit: 50 })}`),
  });

  return (
    <Card className="overflow-hidden">
      {query.isPending ? (
        <RowsSkeleton />
      ) : query.isError ? (
        <EmptyState
          icon={Wallet}
          title="Could not load cash accounts"
          description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
        />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No cash drawers yet"
          description="Each branch needs a cash drawer before cash payments can be recorded against it."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Drawer</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="w-12 screen-only"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.items.map((account) => (
              <TableRow key={account.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-success/10">
                      <Wallet className="size-4 text-success" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{account.name}</div>
                      {account.code ? (
                        <div className="truncate font-mono text-xs text-muted-foreground">{account.code}</div>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Money value={account.balance} showIcon={false} />
                </TableCell>
                <TableCell className="screen-only">
                  <CashAccountRowActions account={account} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={2} className="text-xs uppercase tracking-wider text-muted-foreground">
                Total cash in hand
              </TableCell>
              <TableCell className="text-right">
                <Money
                  value={(query.data.meta as { totalBalance?: number }).totalBalance ?? 0}
                  showIcon={false}
                  className="font-semibold"
                />
              </TableCell>
              <TableCell className="screen-only" />
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </Card>
  );
}

function RowsSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-28 md:block" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}
