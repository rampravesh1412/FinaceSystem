import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Building2, CheckCircle2, TriangleAlert } from "lucide-react";
import type { AccountKind, BranchSummary, TrialBalance } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ExportMenu } from "@/components/export-menu";
import { KIND_LABEL } from "./ledger-book-page";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The Branch Ledger (§3, §34).
 *
 * A branch is NOT a ledger account, which is why this screen is shaped differently from the
 * Cash Book or the Party Ledger. There is no single running balance to show: a branch is a
 * GROUPING of accounts — its drawers, its bank accounts, its parties, its share of the
 * expense heads — and its "ledger" is every one of those accounts side by side.
 *
 * Which makes it, precisely, a trial balance scoped to one branch. So it is built from
 * `trialBalance({ branchId })` rather than a second aggregation that would compute the same
 * figures a slightly different way and eventually disagree.
 *
 * The consequence worth stating: **a branch's books must tie on their own.** Every
 * transaction carries a `branchId` on both sides of its posting, so debits and credits
 * balance within each branch, not merely across the organisation. If this screen ever shows
 * a non-zero difference, that branch has a posting fault — and it would be invisible on the
 * organisation-wide trial balance, where another branch's opposite error could mask it.
 */
export function BranchLedgerPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();

  const branchId = params.get("branch") ?? user?.activeBranchId ?? "";
  const asOf = params.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const kindFilter = params.get("kind") ?? "";

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const branches = useQuery({
    queryKey: ["branches", "for-branch-ledger"],
    queryFn: () => api.list<BranchSummary>(`/branches${qs({ limit: 100 })}`),
  });

  const ledger = useQuery({
    queryKey: ["branch-ledger", { branchId, asOf }],
    queryFn: () => api.get<TrialBalance>(`/ledger/trial-balance${qs({ branchId, asOf })}`),
    enabled: Boolean(branchId),
    placeholderData: (prev) => prev,
  });

  const branch = branches.data?.items.find((b) => b.id === branchId);
  const rows = (ledger.data?.rows ?? []).filter(
    (r) => !kindFilter || r.kind === kindFilter,
  );

  // Kinds actually present in this branch — offering "Equity" when the branch has none
  // is a filter that can only ever empty the table.
  const presentKinds = [...new Set((ledger.data?.rows ?? []).map((r) => r.kind))] as AccountKind[];

  const ties = ledger.data?.difference === 0;
  const filteredDebit = rows.reduce((sum, r) => sum + r.debit, 0);
  const filteredCredit = rows.reduce((sum, r) => sum + r.credit, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Branch Ledger"
        description="Every account belonging to one branch. A branch is a grouping of accounts, not an account — so this is its own trial balance."
        actions={
          branchId ? (
            <ExportMenu path="/export/trial-balance" params={{ branchId, asOf }} />
          ) : null
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="branch">Branch</Label>
          <Select value={branchId} onValueChange={(v) => setParam("branch", v)}>
            <SelectTrigger id="branch" className="w-64">
              <SelectValue placeholder={branches.isPending ? "Loading…" : "Choose a branch"} />
            </SelectTrigger>
            <SelectContent>
              {(branches.data?.items ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="asOf">As at</Label>
          <Input
            id="asOf"
            type="date"
            value={asOf}
            onChange={(e) => setParam("asOf", e.target.value)}
            className="w-auto"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="kind">Account type</Label>
          <Select value={kindFilter || "all"} onValueChange={(v) => setParam("kind", v === "all" ? "" : v)}>
            <SelectTrigger id="kind" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All account types</SelectItem>
              {presentKinds.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {KIND_LABEL[kind] ?? kind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/*
       * The per-branch balance check. Stated whether or not it is zero — see the trial
       * balance screen for why hiding it while it is fine makes the one screen that can
       * report a broken ledger look identical either way.
       */}
      {ledger.data ? (
        <div
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
            ties
              ? "border-success/40 bg-success/5 text-success-foreground"
              : "border-destructive/40 bg-destructive/5 text-destructive",
          )}
        >
          {ties ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span>
            {ties ? (
              <>
                {branch ? `${branch.code} ` : ""}ties on its own — debits equal credits within
                this branch, not merely across the organisation.
              </>
            ) : (
              <>
                This branch is out of balance by{" "}
                <span className="tabular font-semibold">
                  <Money value={Math.abs(ledger.data.difference)} showIcon={false} size="sm" />
                </span>
                . The organisation-wide trial balance can still tie while this does not, if
                another branch carries the opposite error — which is exactly why a branch is
                checked on its own.
              </>
            )}
          </span>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {!branchId ? (
          <EmptyState
            icon={Building2}
            title="Choose a branch"
            description="Pick a branch above to see every account that belongs to it."
          />
        ) : ledger.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : ledger.isError ? (
          <EmptyState
            icon={Building2}
            title="Could not load the branch ledger"
            description={ledger.error instanceof ApiError ? ledger.error.message : "Something went wrong."}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Nothing posted"
            description={
              kindFilter
                ? "No accounts of that type have entries in this branch."
                : "This branch has no ledger entries on or before the chosen date."
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Code</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="hidden sm:table-cell">Type</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.ledgerAccountId}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{row.code}</TableCell>
                  <TableCell>
                    {/*
                     * Drills into the same statement the Cash Book and Party Ledger show —
                     * one screen, reached from wherever the account was noticed.
                     */}
                    <a
                      href={`/ledger?account=${row.ledgerAccountId}`}
                      className="text-sm hover:underline"
                    >
                      {row.name}
                    </a>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="outline" className="text-2xs">
                      {KIND_LABEL[row.kind as AccountKind] ?? row.kind}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {row.debit ? <Money value={row.debit} showIcon={false} /> : <Dash />}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.credit ? <Money value={row.credit} showIcon={false} /> : <Dash />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>

            <TableFooter>
              <TableRow>
                <TableCell colSpan={3} className="text-xs uppercase tracking-wider text-muted-foreground">
                  {kindFilter ? `Subtotal — ${KIND_LABEL[kindFilter as AccountKind] ?? kindFilter}` : "Totals"}
                </TableCell>
                <TableCell className="text-right">
                  <Money value={filteredDebit} showIcon={false} className="font-semibold" />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={filteredCredit} showIcon={false} className="font-semibold" />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </Card>
    </div>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;
