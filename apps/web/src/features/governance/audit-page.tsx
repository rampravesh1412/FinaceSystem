import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ChevronRight, History, Search, ShieldAlert } from "lucide-react";
import { AUDIT_ACTION, type AuditRow } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useDebounced } from "@/hooks/use-debounced";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ExportMenu } from "@/components/export-menu";
import { PaginationBar } from "@/components/pagination-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Audit log viewer (§26).
 *
 * Read-only, and visibly so: there is no edit control anywhere on this page because there
 * is no endpoint behind one. The log is append-only at the model layer.
 *
 * Failed actions are surfaced rather than buried — repeated sign-in failures against one
 * account are the signal somebody is trying to get in, and they are useless if they are
 * mixed in with ten thousand successful reads.
 */
export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const action = params.get("action") ?? "";
  const failuresOnly = params.get("failuresOnly") === "true";

  const [search, setSearch] = React.useState(params.get("q") ?? "");
  const debounced = useDebounced(search, 300);
  const [selected, setSelected] = React.useState<AuditRow | null>(null);

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
    queryKey: ["audit", { page, action, failuresOnly, q: debounced }],
    queryFn: () =>
      api.list<AuditRow>(
        `/audit-logs${qs({ page, limit: 50, action, failuresOnly: failuresOnly || undefined, q: debounced })}`,
      ),
    placeholderData: (prev) => prev,
  });

  const meta = query.data?.meta as { failures?: number } | undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit Log"
        description="Every change, who made it and why. Append-only — nothing here can be edited or deleted."
        actions={
          /* The filters carry into the export, so what downloads is what is on screen —
             an export that quietly ignored the active filter would be a different report
             wearing the same name. */
          <ExportMenu
            path="/export/audit"
            params={{ action, failuresOnly: failuresOnly ? "true" : undefined, q: debounced }}
          />
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search user, record or reason…"
              className="pl-9"
              aria-label="Search the audit log"
            />
          </div>

          <Select value={action || "all"} onValueChange={(v) => setParam("action", v === "all" ? "" : v)}>
            <SelectTrigger className="w-52"><SelectValue placeholder="All actions" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {Object.values(AUDIT_ACTION).map((a) => (
                <SelectItem key={a} value={a}>{formatAction(a)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant={failuresOnly ? "destructive" : "outline"}
            size="sm"
            onClick={() => setParam("failuresOnly", failuresOnly ? "" : "true")}
          >
            <ShieldAlert />
            Failures only
            {meta?.failures ? ` (${meta.failures})` : ""}
          </Button>
        </div>

        {query.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={History}
            title="Could not load the audit log"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          />
        ) : query.data.items.length === 0 ? (
          <EmptyState icon={History} title="Nothing matched" description="Try clearing the filters." />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="hidden sm:table-cell">When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead className="hidden lg:table-cell">By</TableHead>
                  <TableHead className="hidden text-right xl:table-cell">Amount</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((row) => (
                  <TableRow
                    key={row.id}
                    onClick={() => setSelected(row)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(row);
                      }
                    }}
                    className={cn(
                      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      !row.success && "bg-destructive/5",
                    )}
                  >
                    <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground sm:table-cell">
                      {relativeTime(row.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={actionVariant(row.action, row.success)}>{formatAction(row.action)}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="truncate text-sm">{row.entityLabel ?? row.entity}</div>
                      <div className="text-2xs text-muted-foreground">
                        {row.entity}
                        {row.changedFields?.length ? ` · ${row.changedFields.length} field(s) changed` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div className="truncate text-sm">{row.userName}</div>
                      {row.roleName ? (
                        <div className="text-2xs text-muted-foreground">
                          {row.roleName.replace(/_/g, " ").toLowerCase()}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden text-right xl:table-cell">
                      {row.amount ? <Money value={row.amount} direction="auto" showIcon={false} size="sm" /> : "—"}
                    </TableCell>
                    <TableCell><ChevronRight className="size-4 text-muted-foreground" aria-hidden /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationBar meta={query.data.meta} onPageChange={(p) => setParam("page", String(p))} label="entries" />
          </>
        )}
      </Card>

      <AuditDetail row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function AuditDetail({ row, onClose }: { row: AuditRow | null; onClose: () => void }) {
  return (
    <Sheet open={Boolean(row)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-lg">
        {row ? (
          <>
            <SheetHeader>
              <SheetTitle>{formatAction(row.action)}</SheetTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={actionVariant(row.action, row.success)}>
                  {row.success ? "Succeeded" : "Failed"}
                </Badge>
                {row.errorCode ? <Badge variant="danger">{row.errorCode}</Badge> : null}
              </div>
            </SheetHeader>

            <div className="space-y-5 p-5">
              <dl className="space-y-2 text-sm">
                <Field label="Record">{row.entityLabel ?? row.entity}</Field>
                <Field label="Type">{row.entity}</Field>
                <Field label="By">
                  {row.userName}
                  {row.roleName ? ` (${row.roleName.replace(/_/g, " ").toLowerCase()})` : ""}
                </Field>
                {row.userEmail ? <Field label="Email">{row.userEmail}</Field> : null}
                <Field label="When">{formatDateTime(row.createdAt)}</Field>
                {row.amount ? (
                  <Field label="Amount"><Money value={row.amount} direction="auto" showIcon={false} size="sm" /></Field>
                ) : null}
                {row.ip ? <Field label="IP">{row.ip}</Field> : null}
                {row.requestId ? <Field label="Request">{row.requestId}</Field> : null}
              </dl>

              {row.reason ? (
                <div className="space-y-1">
                  <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Reason</div>
                  <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">{row.reason}</p>
                </div>
              ) : null}

              {row.changedFields?.length ? (
                <div className="space-y-1">
                  <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Fields changed
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {row.changedFields.map((f) => <Badge key={f} variant="outline">{f}</Badge>)}
                  </div>
                </div>
              ) : null}

              {/* Before/after, shown raw. An audit viewer that prettifies values can
                  misrepresent what was actually stored. */}
              {row.oldValue || row.newValue ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {row.oldValue ? <Snapshot label="Before" value={row.oldValue} /> : null}
                  {row.newValue ? <Snapshot label="After" value={row.newValue} /> : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Snapshot({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <pre className="max-h-56 overflow-auto rounded-md border border-border bg-surface-muted p-2 text-2xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium">{children}</dd>
    </div>
  );
}

function formatAction(action: string): string {
  return action.charAt(0) + action.slice(1).toLowerCase().replace(/_/g, " ");
}

function actionVariant(action: string, success: boolean): "success" | "danger" | "warning" | "info" | "default" {
  if (!success) return "danger";
  if (action.includes("REVERSE") || action.includes("DELETE") || action.includes("REJECT")) return "warning";
  if (action.includes("APPROVE") || action === "POST" || action === "CREATE") return "success";
  if (action.includes("PERMISSION") || action.includes("ROLE") || action.includes("PERIOD")) return "info";
  return "default";
}
