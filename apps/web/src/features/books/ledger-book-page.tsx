import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { BookOpen, Search, Wallet, Users } from "lucide-react";
import type { AccountKind } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { ExportMenu } from "@/components/export-menu";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface LedgerAccountOption {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  balance: number;
}

interface LedgerRow {
  id: string;
  txnNo: string;
  transactionType: string;
  date: string;
  debit: number;
  credit: number;
  runningBalance: number;
  narration?: string;
  contra: string[];
  reconciledAt: string | null;
}

/**
 * The Cash Book, Bank Book and Party Ledger (§34).
 *
 * All three are the same statement over a different account KIND — the ledger does not
 * distinguish between them, so neither does this screen. Three sidebar entries, one
 * implementation, because three copies would drift.
 */
export function LedgerBookPage({
  kinds,
  title,
  description,
  icon,
}: {
  kinds: AccountKind[];
  title: string;
  description: string;
  icon: typeof BookOpen;
}) {
  const [params, setParams] = useSearchParams();
  const accountId = params.get("account") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const page = Number(params.get("page") ?? 1);
  const [search, setSearch] = React.useState("");

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.set("page", "1");
    setParams(next);
  };

  const accounts = useQuery({
    queryKey: ["ledger-accounts", kinds],
    queryFn: async () => {
      const results = await Promise.all(
        kinds.map((kind) => api.list<LedgerAccountOption>(`/ledger/accounts${qs({ kind, limit: 200 })}`)),
      );
      return results.flatMap((r) => r.items);
    },
  });

  React.useEffect(() => {
    if (!accountId && accounts.data?.length) setParam("account", accounts.data[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.data]);

  const statement = useQuery({
    queryKey: ["ledger-entries", { accountId, from, to, page }],
    queryFn: () =>
      api.list<LedgerRow>(`/ledger/accounts/${accountId}/entries${qs({ from, to, page, limit: 50 })}`),
    enabled: Boolean(accountId),
    placeholderData: (prev) => prev,
  });

  const meta = statement.data?.meta as
    | { account?: { name: string; code: string; balance: number }; openingBalance?: number }
    | undefined;

  const filtered = (accounts.data ?? []).filter(
    (a) =>
      !search.trim() ||
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.code.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        description={description}
        actions={
          accountId ? (
            <ExportMenu
              path={`/export/ledger/${accountId}`}
              params={{ from, to }}
              label="Export statement"
            />
          ) : null
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter accounts…"
              className="pl-9"
              aria-label="Filter accounts"
            />
          </div>

          <Select value={accountId} onValueChange={(v) => setParam("account", v)}>
            <SelectTrigger className="w-full lg:w-96">
              <SelectValue placeholder={accounts.isPending ? "Loading…" : "Choose an account"} />
            </SelectTrigger>
            <SelectContent>
              {filtered.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span className="flex w-full items-center gap-2">
                    <span className="truncate">{a.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Input type="date" value={from} onChange={(e) => setParam("from", e.target.value)} className="w-auto" aria-label="From" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={to} onChange={(e) => setParam("to", e.target.value)} className="w-auto" aria-label="To" />
          </div>
        </div>

        {!accountId ? (
          <EmptyState icon={icon} title="Choose an account" description="Pick an account above to see its statement." />
        ) : statement.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : statement.isError ? (
          <EmptyState
            icon={icon}
            title="Could not load the statement"
            description={statement.error instanceof ApiError ? statement.error.message : "Something went wrong."}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Date</TableHead>
                  <TableHead>Voucher</TableHead>
                  <TableHead>Particulars</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {/* Brought forward, so the running balance starts where it should. */}
                <TableRow className="bg-surface-muted/40">
                  <TableCell colSpan={3} className="text-sm font-medium">
                    Balance brought forward
                  </TableCell>
                  <TableCell /><TableCell />
                  <TableCell className="text-right">
                    <Money value={meta?.openingBalance ?? 0} direction="auto" showIcon={false} />
                  </TableCell>
                </TableRow>

                {statement.data.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDate(row.date)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">{row.txnNo}</span>
                        {row.reconciledAt ? (
                          <Badge variant="success" className="text-[9px]">R</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{row.narration ?? "—"}</div>
                      {row.contra.length > 0 ? (
                        <div className="truncate text-2xs text-muted-foreground">
                          To: {row.contra.join(", ")}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.debit ? <Money value={row.debit} showIcon={false} /> : <Dash />}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.credit ? <Money value={row.credit} showIcon={false} /> : <Dash />}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={row.runningBalance} direction="auto" showIcon={false} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>

              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5} className="text-xs uppercase tracking-wider text-muted-foreground">
                    Closing balance — {meta?.account?.name}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={meta?.account?.balance ?? 0} direction="auto" showIcon={false} className="font-semibold" />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>

            <PaginationBar meta={statement.data.meta} onPageChange={(p) => setParam("page", String(p))} label="entries" />
          </>
        )}
      </Card>
    </div>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;

export function CashBookPage() {
  return (
    <LedgerBookPage
      kinds={["CASH"]}
      title="Cash Book"
      description="Every movement through the cash drawers, with a running balance."
      icon={Wallet}
    />
  );
}

export function BankBookPage() {
  return (
    <LedgerBookPage
      kinds={["BANK"]}
      title="Bank Book"
      description="Every movement through the bank accounts. An R marks a reconciled entry."
      icon={BookOpen}
    />
  );
}

export function PartyLedgerPage() {
  return (
    <LedgerBookPage
      kinds={["PARTY"]}
      title="Party Ledger"
      description="The formal ledger view of a party account — the Digital Khata shows the same entries in Lena/Dena terms."
      icon={Users}
    />
  );
}
