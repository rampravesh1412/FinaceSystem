import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { BookOpen, Coins, Layers, PiggyBank, Receipt, Search, Wallet, Users } from "lucide-react";
import { formatINR, type AccountKind, type ContraLine } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useDebounced } from "@/hooks/use-debounced";
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
  contraLines?: ContraLine[];
  reconciledAt: string | null;
}

/**
 * Every ledger book (§34, §4.1).
 *
 * The Cash Book, the Bank Book, the Party Ledger and the General Ledger are the SAME
 * statement over a different account kind. §4.1 is what makes that true: every
 * balance-bearing thing in the system — a bank account, a drawer, a party, an expense head,
 * a savings account, equity, suspense — is a row in one `LedgerAccount` collection. The
 * ledger does not distinguish between them, so neither does this screen.
 *
 * One implementation, several presets. Separate copies per kind would drift, and the
 * running-balance arithmetic is the last thing that should exist in five versions.
 */

/** The kinds, in the words an operator uses, for the general-ledger picker. */
export const KIND_LABEL: Record<AccountKind, string> = {
  BANK: "Bank accounts",
  CASH: "Cash drawers",
  PARTY: "Parties",
  EXPENSE: "Expense heads",
  INCOME: "Income heads",
  SAVINGS: "Bachat Khata",
  CHARGE: "Charges & commission",
  EQUITY: "Equity",
  SUSPENSE: "Suspense",
};

const ALL_KINDS = Object.keys(KIND_LABEL) as AccountKind[];

/** The server's own page cap. Asking for more is refused with a 422, not truncated. */
const PAGE = 200;
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
  const debouncedSearch = useDebounced(search, 300);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.set("page", "1");
    setParams(next);
  };

  const accounts = useQuery({
    queryKey: ["ledger-accounts", kinds, debouncedSearch],
    queryFn: async () => {
      /**
       * Searched on the SERVER, and capped at the server's own page size.
       *
       * The chart of accounts has one row per party, per drawer, per head — thousands in a
       * real deployment. Fetching a page and filtering it in the browser would offer the
       * first 200 and report "no matches" for an account that exists.
       *
       * `PAGE` is `MAX_PAGE_SIZE`, not a larger number of our choosing: asking for 500 is
       * refused outright with a 422, which would leave the picker permanently empty.
       */
      if (kinds.length === ALL_KINDS.length) {
        // One request — the endpoint returns every kind when `kind` is omitted, so nine
        // parallel round trips would reassemble what a single call already gives.
        const all = await api.list<LedgerAccountOption>(
          `/ledger/accounts${qs({ limit: PAGE, q: debouncedSearch })}`,
        );
        return { items: all.items, total: all.meta.total };
      }

      const results = await Promise.all(
        kinds.map((kind) =>
          api.list<LedgerAccountOption>(`/ledger/accounts${qs({ kind, limit: PAGE, q: debouncedSearch })}`),
        ),
      );
      return {
        items: results.flatMap((r) => r.items),
        total: results.reduce((sum, r) => sum + r.meta.total, 0),
      };
    },
  });

  React.useEffect(() => {
    if (!accountId && filtered.length) setParam("account", filtered[0]!.id);
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

  // No local filtering: the server already applied the search. Filtering again on the
  // partially-loaded page would hide matches that are on the server's next page.
  const filtered = accounts.data?.items ?? [];
  const totalAccounts = accounts.data?.total ?? 0;
  const truncated = totalAccounts > filtered.length;

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
              placeholder="Search accounts…"
              className="pl-9"
              aria-label="Search accounts"
            />
          </div>

          <Select value={accountId} onValueChange={(v) => setParam("account", v)}>
            <SelectTrigger className="w-full lg:w-96">
              <SelectValue placeholder={accounts.isPending ? "Loading…" : "Choose an account"} />
            </SelectTrigger>
            <SelectContent>
              {/*
               * Grouped by kind once more than one is in play. A flat list of every account
               * in the chart — banks, parties, expense heads, equity — is not a list anyone
               * can navigate; the grouping is what makes the general ledger usable.
               */}
              {kinds.length === 1
                ? filtered.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="truncate">{a.name}</span>
                    </SelectItem>
                  ))
                : ALL_KINDS.filter((kind) => filtered.some((a) => a.kind === kind)).map((kind) => (
                    <React.Fragment key={kind}>
                      <div className="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {KIND_LABEL[kind]}
                      </div>
                      {filtered
                        .filter((a) => a.kind === kind)
                        .map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            <span className="flex w-full items-center gap-2">
                              <span className="truncate">{a.name}</span>
                              <span className="ml-auto font-mono text-2xs text-muted-foreground">
                                {a.code}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                    </React.Fragment>
                  ))}

              {truncated ? (
                <div className="border-t border-border px-2 py-1.5 text-2xs text-muted-foreground">
                  Showing {filtered.length} of {totalAccounts.toLocaleString("en-IN")} accounts —
                  type to search the rest.
                </div>
              ) : null}
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
                      {/**
                       * The other side WITH its figures.
                       *
                       * The amount column shows what moved on this account, which on a
                       * charged payment does not add up on its own — ₹1,00,000 out of the
                       * bank is ₹98,500 to the party plus ₹1,500 of cost. Naming the
                       * accounts without the split left the operator to do that
                       * subtraction, and it is exactly the subtraction people get wrong.
                       */}
                      {row.contraLines?.length ? (
                        <div className="text-2xs text-muted-foreground">
                          To:{" "}
                          {row.contraLines.map((c, i) => (
                            <span key={`${c.name}-${i}`}>
                              {i > 0 ? " · " : ""}
                              {c.name}{" "}
                              <span className="tabular text-foreground">
                                {formatINR(c.amount)}
                              </span>
                            </span>
                          ))}
                        </div>
                      ) : row.contra.length > 0 ? (
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

/**
 * The General Ledger — any account in the chart of accounts.
 *
 * Including the ones with no book of their own: expense and income heads, savings, charges,
 * equity and suspense. Suspense in particular is worth being able to open directly, because
 * §62 sends every unexplained difference there and somebody has to go and look at it.
 */
export function GeneralLedgerPage() {
  return (
    <LedgerBookPage
      kinds={ALL_KINDS}
      title="General Ledger"
      description="Every account in the chart of accounts, with its entries and running balance."
      icon={Layers}
    />
  );
}

export function ExpenseLedgerPage() {
  return (
    <LedgerBookPage
      kinds={["EXPENSE", "CHARGE"]}
      title="Expense Ledger"
      description="What has been posted against each expense head, and against charges and commission."
      icon={Receipt}
    />
  );
}

export function IncomeLedgerPage() {
  return (
    <LedgerBookPage
      kinds={["INCOME"]}
      title="Income Ledger"
      description="What has been earned under each income head."
      icon={Coins}
    />
  );
}

export function SavingsLedgerPage() {
  return (
    <LedgerBookPage
      kinds={["SAVINGS"]}
      title="Savings Ledger"
      description="Every member account, in ledger terms. A credit balance is money held on their behalf."
      icon={PiggyBank}
    />
  );
}
