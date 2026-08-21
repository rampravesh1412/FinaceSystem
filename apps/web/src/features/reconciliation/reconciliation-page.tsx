import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  ArrowLeft, Check, CircleAlert, FileUp, Link2, Link2Off, Scale, TriangleAlert,
} from "lucide-react";
import {
  startReconciliationSchema,
  type BankAccountSummary,
  type ReconciliationLineRow,
  type ReconciliationSummary,
  type StartReconciliationInput,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { Can } from "@/features/auth/auth-context";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { VirtualNotice, VirtualRows, VirtualScroller } from "@/components/virtual-rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Bank reconciliation (§23).
 *
 * The screen is built around one number — `difference` — and the rule that it is never
 * quietly resolved. §62: if the bank says ₹9,80,000 and the ledger says ₹10,00,000, this
 * shows SHORT ₹20,000 and keeps showing it. There is no control anywhere on this page that
 * writes the bank's figure over ours; closing with a difference requires ticking an
 * acknowledgement that is recorded in the audit log with the operator's name on it.
 */
export function ReconciliationPage() {
  const [openId, setOpenId] = React.useState<string | null>(null);

  return openId ? (
    <ReconciliationDetail id={openId} onBack={() => setOpenId(null)} />
  ) : (
    <ReconciliationList onOpen={setOpenId} />
  );
}

/* ── List ────────────────────────────────────────────────────────────────── */

function ReconciliationList({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = React.useState(1);

  const query = useQuery({
    queryKey: ["reconciliations", page],
    queryFn: () => api.list<ReconciliationSummary>(`/reconciliation${qs({ page, limit: 20 })}`),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bank Reconciliation"
        description="Compare the bank's statement against the ledger. Differences are reported, never absorbed."
        actions={
          <Can permission="finance.bank.reconcile">
            <StartReconciliationDialog onStarted={onOpen} />
          </Can>
        }
      />

      <Card className="overflow-hidden">
        {query.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={Scale}
            title="Could not load reconciliations"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          />
        ) : query.data.items.length === 0 ? (
          <EmptyState
            icon={Scale}
            title="No reconciliations yet"
            description="Start one by entering the closing balance printed on a bank statement, then import the statement lines."
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Bank says</TableHead>
                  <TableHead className="text-right">Ledger says</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                  <TableHead className="hidden lg:table-cell">Lines</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((r) => (
                  <TableRow
                    key={r.id}
                    onClick={() => onOpen(r.id)}
                    className="cursor-pointer"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpen(r.id);
                      }
                    }}
                  >
                    <TableCell className="text-sm font-medium">{r.bankAccount.label}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDate(r.from)} → {formatDate(r.to)}
                    </TableCell>
                    <TableCell className="text-right"><Money value={r.statementBalance} showIcon={false} /></TableCell>
                    <TableCell className="text-right"><Money value={r.systemBalance} showIcon={false} /></TableCell>
                    <TableCell className="text-right"><DifferenceBadge value={r.difference} /></TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <LineCounts counts={r.counts} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === "COMPLETED" ? "success" : "warning"}>
                        {r.status === "COMPLETED" ? "Closed" : "In progress"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationBar meta={query.data.meta} onPageChange={setPage} label="reconciliations" />
          </>
        )}
      </Card>
    </div>
  );
}

/* ── Start ───────────────────────────────────────────────────────────────── */

function StartReconciliationDialog({ onStarted }: { onStarted: (id: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();

  const accounts = useQuery({
    queryKey: ["bank-accounts", "all"],
    queryFn: () => api.list<BankAccountSummary>(`/bank-accounts${qs({ limit: 200 })}`),
    enabled: open,
  });

  const form = useForm<StartReconciliationInput>({
    resolver: zodResolver(startReconciliationSchema),
    defaultValues: { bankAccountId: "", from: "", to: "", statementBalance: "" } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: StartReconciliationInput) =>
      api.post<ReconciliationSummary>("/reconciliation", values),
    onSuccess: async (summary) => {
      toast.success("Reconciliation opened", {
        description:
          summary.difference === 0
            ? "The statement and the ledger already agree — import the lines to confirm."
            : `The statement and the ledger differ by ₹${Math.abs(summary.difference / 100).toLocaleString("en-IN")}.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["reconciliations"] });
      form.reset();
      setOpen(false);
      onStarted(summary.id);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        for (const fe of error.fieldErrors) {
          form.setError(fe.field as keyof StartReconciliationInput, { message: fe.message });
        }
        toast.error(error.message);
        return;
      }
      toast.error("Could not start the reconciliation.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent">
          <Scale />
          Start reconciliation
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a reconciliation</DialogTitle>
          <DialogDescription>
            Enter the closing balance exactly as printed on the bank statement. It is compared
            against the ledger, computed from entries rather than any cached figure.
          </DialogDescription>
        </DialogHeader>

        <form
          id="start-recon"
          className="space-y-3"
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
        >
          <div className="space-y-1.5">
            <Label htmlFor="bankAccountId">Bank account</Label>
            <Select
              value={form.watch("bankAccountId")}
              onValueChange={(v) => form.setValue("bankAccountId", v, { shouldValidate: true })}
            >
              <SelectTrigger id="bankAccountId">
                <SelectValue placeholder={accounts.isPending ? "Loading…" : "Choose an account"} />
              </SelectTrigger>
              <SelectContent>
                {(accounts.data?.items ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {/* The number arrives already masked unless the caller holds
                        finance.bank.viewFull — the client never receives the digits. */}
                    {a.bank.shortName ?? a.bank.name} · {a.accountName} ({a.accountNumber})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={form.formState.errors.bankAccountId?.message} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="from">Statement from</Label>
              <Input id="from" type="date" {...form.register("from")} />
              <FieldError message={form.formState.errors.from?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">Statement to</Label>
              <Input id="to" type="date" {...form.register("to")} />
              <FieldError message={form.formState.errors.to?.message} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="statementBalance">Closing balance on the statement</Label>
            <Input id="statementBalance" inputMode="decimal" placeholder="9,80,000.00" {...form.register("statementBalance")} />
            <FieldError message={form.formState.errors.statementBalance?.message} />
          </div>
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="start-recon" variant="accent" loading={mutation.isPending}>
            Open reconciliation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Detail ──────────────────────────────────────────────────────────────── */

function ReconciliationDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const summary = useQuery({
    queryKey: ["reconciliation", id],
    queryFn: () => api.get<ReconciliationSummary>(`/reconciliation/${id}`),
  });

  const lines = useQuery({
    queryKey: ["reconciliation", id, "lines"],
    queryFn: () => api.get<ReconciliationLineRow[]>(`/reconciliation/${id}/lines`),
  });

  if (summary.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (summary.isError) {
    return (
      <EmptyState
        icon={Scale}
        title="Could not load this reconciliation"
        description={summary.error instanceof ApiError ? summary.error.message : "Something went wrong."}
        action={<Button variant="outline" size="sm" onClick={onBack}>Back to the list</Button>}
      />
    );
  }

  const r = summary.data;
  const isOpen = r.status === "IN_PROGRESS";
  const unresolved = r.counts.unmatched + r.counts.needsReview;

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to reconciliations">
              <ArrowLeft />
            </Button>
            {r.bankAccount.label}
          </span>
        }
        description={`${formatDate(r.from)} → ${formatDate(r.to)} · opened ${relativeTime(r.createdAt)}`}
        actions={
          isOpen ? (
            <Can permission="finance.bank.reconcile">
              <ImportStatementDialog reconciliationId={id} />
              <CompleteDialog summary={r} unresolved={unresolved} onCompleted={onBack} />
            </Can>
          ) : (
            <Badge variant="success">
              <Check className="size-3" />
              Closed {r.completedAt ? relativeTime(r.completedAt) : ""}
            </Badge>
          )
        }
      />

      {/* The three figures, side by side. The difference is never presented alone — an
          operator needs both sides to know which one to go and check. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <BalanceTile label="Bank statement says" value={r.statementBalance} />
        <BalanceTile label="Our ledger says" value={r.systemBalance} />
        <div
          className={cn(
            "flex flex-col justify-between gap-3 rounded-lg border p-4 shadow-subtle",
            r.difference === 0 ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5",
          )}
        >
          <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Difference
          </span>
          <div className="space-y-1">
            <Money value={r.difference} direction={r.difference === 0 ? "neutral" : "auto"} size="xl" showIcon={false} />
            <p className="text-xs text-muted-foreground">
              {r.difference === 0
                ? "The statement and the ledger agree."
                : r.difference > 0
                  ? "The bank holds more than the ledger accounts for — a receipt is probably unrecorded."
                  : "The ledger expects more than the bank holds — a payment may have cleared twice, or a receipt never arrived."}
            </p>
          </div>
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <LineCounts counts={r.counts} />
          {unresolved > 0 ? (
            <span className="flex items-center gap-1.5 text-xs text-warning-foreground">
              <CircleAlert className="size-3.5" aria-hidden />
              {unresolved} line{unresolved === 1 ? "" : "s"} still need a decision
            </span>
          ) : null}
        </div>

        {lines.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : lines.isError ? (
          <EmptyState
            icon={Scale}
            title="Could not load the statement lines"
            description={lines.error instanceof ApiError ? lines.error.message : "Something went wrong."}
          />
        ) : lines.data.length === 0 ? (
          <EmptyState
            icon={FileUp}
            title="No statement lines yet"
            description="Import the bank statement to start matching. Lines that match exactly one ledger entry are matched automatically; everything else waits for you."
          />
        ) : (
          <>
            {/* Windowed: an imported statement carries up to two thousand lines, plus every
                unmatched ledger entry in the window. All of them must be reachable — an
                unresolved line that nobody scrolled to is exactly what a reconciliation
                exists to surface. */}
            <VirtualScroller scrollRef={scrollRef}>
              <Table className="table-sticky-head" wrapperClassName="overflow-visible">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Date</TableHead>
                    <TableHead>On the statement</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Matched to</TableHead>
                    <TableHead className="w-64">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <VirtualRows
                    rows={lines.data}
                    scrollRef={scrollRef}
                    columns={5}
                    estimateRowHeight={56}
                  >
                    {(line) => (
                      <LineRow key={line.id} line={line} reconciliationId={id} editable={isOpen} />
                    )}
                  </VirtualRows>
                </TableBody>
              </Table>
            </VirtualScroller>
            <VirtualNotice total={lines.data.length} />
          </>
        )}
      </Card>
    </div>
  );
}

/* ── One statement line ──────────────────────────────────────────────────── */

const STATUS_LABEL: Record<string, string> = {
  MATCHED: "Matched",
  UNMATCHED: "Unmatched",
  MISSING_IN_SYSTEM: "Not in our books",
  MISSING_IN_BANK: "Not on the statement",
  DUPLICATE: "Duplicate",
  NEEDS_REVIEW: "Needs review",
};

function LineRow({
  line,
  reconciliationId,
  editable,
}: {
  line: ReconciliationLineRow;
  reconciliationId: string;
  editable: boolean;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (body: { ledgerEntryId: string | null; status?: string }) =>
      api.post(`/reconciliation/lines/${line.id}/match`, body),
    onSuccess: async () => {
      // Both the lines AND the summary: the counts on the header change with every match.
      await queryClient.invalidateQueries({ queryKey: ["reconciliation", reconciliationId] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not update the line.");
    },
  });

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDate(line.date)}
      </TableCell>
      <TableCell>
        <div className="max-w-md truncate text-sm">{line.description}</div>
        {line.referenceNo ? (
          <div className="font-mono text-2xs text-muted-foreground">{line.referenceNo}</div>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        {/* Signed as the bank prints it: positive is money arriving. */}
        <Money value={line.amount} direction="auto" showIcon={false} />
      </TableCell>
      <TableCell>
        {line.ledgerEntry ? (
          <div className="flex items-center gap-1.5">
            <Link2 className="size-3.5 text-success" aria-hidden />
            <span className="font-mono text-xs">{line.ledgerEntry.txnNo}</span>
          </div>
        ) : line.suggestions.length > 0 && editable ? (
          <Select
            value=""
            onValueChange={(entryId) => mutation.mutate({ ledgerEntryId: entryId })}
            disabled={mutation.isPending}
          >
            <SelectTrigger className="h-8 w-56 text-xs">
              <SelectValue placeholder={`${line.suggestions.length} possible match${line.suggestions.length === 1 ? "" : "es"}`} />
            </SelectTrigger>
            <SelectContent>
              {line.suggestions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{s.txnNo}</span>
                    <span className="text-muted-foreground">{formatDate(s.date)}</span>
                    <Money value={s.amount} showIcon={false} size="sm" />
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              line.status === "MATCHED" ? "success"
              : line.status === "UNMATCHED" || line.status === "NEEDS_REVIEW" ? "warning"
              : "outline"
            }
          >
            {STATUS_LABEL[line.status] ?? line.status}
          </Badge>

          {editable ? (
            line.status === "MATCHED" ? (
              <Button
                variant="ghost"
                size="sm"
                loading={mutation.isPending}
                onClick={() => mutation.mutate({ ledgerEntryId: null, status: "UNMATCHED" })}
              >
                <Link2Off />
                Unmatch
              </Button>
            ) : (
              /* Classifying is not the same as matching. A line marked "not in our books"
                 stays a known gap rather than becoming a tick — §62 again. */
              <Select
                value=""
                onValueChange={(status) => mutation.mutate({ ledgerEntryId: null, status })}
                disabled={mutation.isPending}
              >
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="Classify…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MISSING_IN_SYSTEM">Not in our books</SelectItem>
                  <SelectItem value="MISSING_IN_BANK">Not on the statement</SelectItem>
                  <SelectItem value="DUPLICATE">Duplicate</SelectItem>
                  <SelectItem value="NEEDS_REVIEW">Needs review</SelectItem>
                </SelectContent>
              </Select>
            )
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ── Import statement ────────────────────────────────────────────────────── */

interface ParsedLine {
  date: string;
  description: string;
  referenceNo?: string;
  amount: string;
}

/**
 * Parse pasted statement text.
 *
 * Accepts CSV or tab-separated, which between them cover a copy-paste out of a bank's own
 * download and out of Excel. Rows that cannot be read are REPORTED, not dropped — an
 * importer that silently skips three lines produces a reconciliation that looks finished
 * and is not.
 */
function parseStatement(text: string): { lines: ParsedLine[]; errors: string[] } {
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const lines: ParsedLine[] = [];
  const errors: string[] = [];

  rows.forEach((row, index) => {
    const cells = (row.includes("\t") ? row.split("\t") : row.split(",")).map((c) =>
      c.trim().replace(/^"|"$/g, ""),
    );

    // A header row — skip it rather than reporting it as an error.
    if (index === 0 && !/\d/.test(cells[0] ?? "")) return;

    const [date, description, third, fourth] = cells;
    if (!date || !description) {
      errors.push(`Line ${index + 1}: expected date, description and amount`);
      return;
    }

    const amount = fourth ?? third;
    if (!amount || !/^-?[\d,]+(\.\d{1,2})?$/.test(amount)) {
      errors.push(`Line ${index + 1}: "${amount ?? ""}" is not an amount`);
      return;
    }

    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
      errors.push(`Line ${index + 1}: "${date}" is not a date`);
      return;
    }

    lines.push({
      date: parsedDate.toISOString().slice(0, 10),
      description,
      referenceNo: fourth ? third : undefined,
      amount,
    });
  });

  return { lines, errors };
}

function ImportStatementDialog({ reconciliationId }: { reconciliationId: string }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const queryClient = useQueryClient();

  const parsed = React.useMemo(() => parseStatement(text), [text]);

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ imported: number; autoMatched: number }>(
        `/reconciliation/${reconciliationId}/statement`,
        { lines: parsed.lines },
      ),
    onSuccess: async (result) => {
      toast.success(`${result.imported} lines imported`, {
        description: `${result.autoMatched} matched automatically. The rest are waiting for you.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["reconciliation", reconciliationId] });
      setText("");
      setOpen(false);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not import the statement.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FileUp />
          Import statement
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import statement lines</DialogTitle>
          <DialogDescription>
            Paste the statement as CSV or straight out of a spreadsheet — one row per line, as{" "}
            <code className="text-xs">date, description, [reference], amount</code>. A positive
            amount is money arriving, as the bank prints it.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"2026-08-04, NEFT SHARMA TRADERS, HDFC0001234, 700000.00\n2026-08-05, ATM WITHDRAWAL, , -20000.00"}
          className="font-mono text-xs"
          aria-label="Statement text"
        />

        {text.trim() ? (
          <div className="space-y-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
            <div className="flex items-center gap-4">
              <span>
                <span className="tabular font-semibold text-foreground">{parsed.lines.length}</span>{" "}
                line{parsed.lines.length === 1 ? "" : "s"} ready
              </span>
              {parsed.errors.length > 0 ? (
                <span className="flex items-center gap-1 text-destructive">
                  <TriangleAlert className="size-3.5" aria-hidden />
                  {parsed.errors.length} could not be read
                </span>
              ) : null}
            </div>

            {parsed.errors.length > 0 ? (
              <>
                <Separator />
                <ul className="max-h-28 space-y-0.5 overflow-y-auto text-destructive">
                  {parsed.errors.slice(0, 12).map((e) => <li key={e}>{e}</li>)}
                </ul>
                {/* Nothing is imported until every row reads. Half a statement produces a
                    reconciliation whose difference means nothing. */}
                <p className="text-muted-foreground">
                  Fix these rows before importing — a partial statement cannot reconcile.
                </p>
              </>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="accent"
            loading={mutation.isPending}
            disabled={parsed.lines.length === 0 || parsed.errors.length > 0}
            onClick={() => mutation.mutate()}
          >
            Import {parsed.lines.length || ""} line{parsed.lines.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Complete ────────────────────────────────────────────────────────────── */

function CompleteDialog({
  summary,
  unresolved,
  onCompleted,
}: {
  summary: ReconciliationSummary;
  unresolved: number;
  onCompleted: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  const [acknowledged, setAcknowledged] = React.useState(false);
  const queryClient = useQueryClient();

  const hasDifference = summary.difference !== 0;

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/reconciliation/${summary.id}/complete`, {
        notes: notes.trim() || undefined,
        acknowledgeDifference: acknowledged,
      }),
    onSuccess: async () => {
      toast.success("Reconciliation closed", {
        description: hasDifference
          ? "The unexplained difference stays on the record, with your acknowledgement attached."
          : "The statement and the ledger agree.",
      });
      await queryClient.invalidateQueries({ queryKey: ["reconciliation"] });
      await queryClient.invalidateQueries({ queryKey: ["reconciliations"] });
      setOpen(false);
      onCompleted();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not close the reconciliation.");
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button variant="accent" onClick={() => setOpen(true)} disabled={unresolved > 0}>
        <Check />
        Close reconciliation
      </Button>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close this reconciliation?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {hasDifference ? (
                <>
                  <p>
                    The statement and the ledger differ by{" "}
                    <span className="font-medium text-foreground">
                      <Money value={Math.abs(summary.difference)} showIcon={false} />
                    </span>
                    . Closing does <span className="font-medium text-foreground">not</span> correct
                    it — the difference stays on the record, attributed to you, until someone finds
                    what causes it.
                  </p>
                  <p>
                    If it turns out to be a genuine loss or a bank error, post an explicit
                    adjustment with a reason. Do not close and forget.
                  </p>
                </>
              ) : (
                <p>The statement and the ledger agree exactly. Every line has been accounted for.</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="recon-notes">
              Notes {hasDifference ? "(what you found, and what is still unexplained)" : "(optional)"}
            </Label>
            <Textarea
              id="recon-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                hasDifference
                  ? "e.g. ₹20,000 cheque issued 28 Aug has not cleared; following up with the branch"
                  : ""
              }
            />
          </div>

          {hasDifference ? (
            <label className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
                aria-label="Acknowledge the unexplained difference"
                className="mt-0.5"
              />
              <span>
                I acknowledge an unexplained difference of{" "}
                <span className="font-medium">
                  <Money value={Math.abs(summary.difference)} showIcon={false} />
                </span>{" "}
                and am closing the period with it on the record.
              </span>
            </label>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant={hasDifference ? "destructive" : "accent"}
            loading={mutation.isPending}
            disabled={hasDifference && !acknowledged}
            onClick={() => mutation.mutate()}
          >
            Close reconciliation
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────────── */

function BalanceTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4 shadow-subtle">
      <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <Money value={value} size="xl" showIcon={false} />
    </div>
  );
}

function DifferenceBadge({ value }: { value: number }) {
  if (value === 0) {
    return (
      <Badge variant="success">
        <Check className="size-3" />
        Agrees
      </Badge>
    );
  }
  return <Money value={value} direction="auto" showIcon={false} />;
}

function LineCounts({ counts }: { counts: ReconciliationSummary["counts"] }) {
  const pieces: Array<[string, number]> = [
    ["matched", counts.matched],
    ["unmatched", counts.unmatched],
    ["not in our books", counts.missingInSystem],
    ["not on the statement", counts.missingInBank],
    ["duplicate", counts.duplicate],
    ["needs review", counts.needsReview],
  ];

  const shown = pieces.filter(([, n]) => n > 0);
  if (shown.length === 0) return <span className="text-xs text-muted-foreground">No lines yet</span>;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {shown.map(([label, n]) => (
        <span key={label}>
          <span className="tabular font-medium text-foreground">{n}</span> {label}
        </span>
      ))}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}
