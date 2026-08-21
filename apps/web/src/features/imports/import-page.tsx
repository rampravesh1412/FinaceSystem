import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2, CircleAlert, Copy, Download, FileUp, TriangleAlert, Upload, Users,
} from "lucide-react";
import type { BranchSummary, ImportPreview, ImportResult } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The import wizard (§52).
 *
 * Three steps, and the middle one is the point: PASTE → PREVIEW → COMMIT. The preview
 * endpoint writes nothing; it reports what every row would do, including which ones are
 * duplicates of parties that already exist. Only after the operator has seen that does the
 * commit button do anything.
 *
 * Two things this screen deliberately refuses to do:
 *   - Import a file with unreadable rows. A half-imported party master is worse than a
 *     rejected one, because nobody can tell what landed without checking record by record.
 *   - Overwrite an existing party. A repeated code might be a genuine re-import or a
 *     data-entry slip; only the operator knows which, so duplicates are reported and left.
 */
export function ImportPage() {
  const { user } = useAuth();
  const [branchId, setBranchId] = React.useState(user?.activeBranchId ?? "");
  const [text, setText] = React.useState("");
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const queryClient = useQueryClient();

  const branches = useQuery({
    queryKey: ["branches", "for-import"],
    queryFn: () => api.list<BranchSummary>(`/branches${qs({ limit: 100, status: "ACTIVE" })}`),
  });

  const parsed = React.useMemo(() => parseSheet(text), [text]);

  // Editing the pasted text invalidates whatever was previewed — a commit must never run
  // against rows the operator has not seen validated.
  React.useEffect(() => {
    setPreview(null);
    setResult(null);
  }, [text, branchId]);

  const previewMutation = useMutation({
    mutationFn: () =>
      api.post<ImportPreview>("/import/parties/preview", { branchId, rows: parsed.rows }),
    onSuccess: (data) => {
      setPreview(data);
      if (data.valid === 0) {
        toast.error("Nothing in this file can be imported", {
          description: "Every row was either invalid or already exists.",
        });
      }
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not check the file.");
    },
  });

  const commitMutation = useMutation({
    mutationFn: () =>
      api.post<ImportResult>("/import/parties/commit", { branchId, rows: parsed.rows }),
    onSuccess: async (data) => {
      setResult(data);
      toast.success(`${data.imported} parties imported`, {
        description:
          data.skipped > 0
            ? `${data.skipped} rows were skipped — they are listed below.`
            : "Each one has a ledger account and its opening balance posted.",
      });
      await queryClient.invalidateQueries({ queryKey: ["parties"] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "The import failed.");
    },
  });

  const template = useMutation({
    mutationFn: () => api.get<Array<Record<string, string>>>("/import/parties/template"),
    onSuccess: (rows) => {
      const headers = Object.keys(rows[0] ?? {});
      const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => r[h] ?? "").join(","))].join("\n");
      setText(csv);
      toast.success("Template loaded", { description: "Replace the example row with your own data." });
    },
    onError: () => toast.error("Could not load the template."),
  });

  const busy = previewMutation.isPending || commitMutation.isPending;
  const canPreview = Boolean(branchId) && parsed.rows.length > 0 && parsed.errors.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Import Parties"
        description="Check first, import second. Nothing is written until you have seen exactly what will land."
        actions={
          <Button variant="outline" onClick={() => template.mutate()} loading={template.isPending}>
            <Download />
            Load template
          </Button>
        }
      />

      {/* ── Step 1: what and where ─────────────────────────────────────── */}
      <Card className="space-y-4 p-4">
        <StepHeading n={1} title="Paste the file" done={parsed.rows.length > 0 && parsed.errors.length === 0} />

        <div className="space-y-1.5">
          <Label htmlFor="import-branch">Import into</Label>
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger id="import-branch" className="w-full max-w-sm">
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
          <p className="text-xs text-muted-foreground">
            Parties belong to one branch. Importing into the wrong one is not something the
            wizard can undo for you.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="import-text">Rows</Label>
          <Textarea
            id="import-text"
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Name,Code,Type,Mobile,City,Opening Balance,Credit Limit,Credit Days\nSharma Traders,,CUSTOMER,9812345670,Patna,1,25,101.00,2,00,000.00,30"}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            CSV, or pasted straight from a spreadsheet. Header names are matched loosely —
            "Party Name", "party_name" and "PARTY NAME" all work.
          </p>
        </div>

        {text.trim() ? (
          <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
            <span>
              <span className="tabular font-semibold text-foreground">{parsed.rows.length}</span> row
              {parsed.rows.length === 1 ? "" : "s"} read
            </span>
            {parsed.errors.length > 0 ? (
              <span className="flex items-center gap-1 text-destructive">
                <TriangleAlert className="size-3.5" aria-hidden />
                {parsed.errors.length} could not be parsed — fix them before continuing
              </span>
            ) : null}
          </div>
        ) : null}

        {parsed.errors.length > 0 ? (
          <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-destructive">
            {parsed.errors.slice(0, 15).map((e) => <li key={e}>{e}</li>)}
          </ul>
        ) : null}

        <Button
          variant="accent"
          disabled={!canPreview || busy}
          loading={previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          <FileUp />
          Check {parsed.rows.length || ""} row{parsed.rows.length === 1 ? "" : "s"}
        </Button>
      </Card>

      {/* ── Step 2: what would happen ──────────────────────────────────── */}
      {preview ? (
        <Card className="space-y-4 p-4">
          <StepHeading n={2} title="What this would do" done={Boolean(result)} />

          <div className="grid gap-3 sm:grid-cols-4">
            <CountTile label="Will be created" value={preview.valid} tone="good" />
            <CountTile label="Already exist" value={preview.duplicates} tone="warn" />
            <CountTile label="Invalid" value={preview.invalid} tone="bad" />
            <CountTile label="Rows in file" value={preview.totalRows} />
          </div>

          {preview.sample.length > 0 ? (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  The first {preview.sample.length} of them, as they would be created:
                </p>
                <div className="overflow-x-auto rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">Row</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Opening</TableHead>
                        <TableHead className="text-right">Credit limit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.sample.map((row) => (
                        <TableRow key={String(row.row)}>
                          <TableCell className="tabular text-xs text-muted-foreground">{String(row.row)}</TableCell>
                          <TableCell className="text-sm">{String(row.name)}</TableCell>
                          <TableCell className="font-mono text-xs">{String(row.code)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-2xs">
                              {String(row.type).toLowerCase()}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Money value={Number(row.openingBalance)} showIcon={false} size="sm" />
                          </TableCell>
                          <TableCell className="text-right">
                            <Money value={Number(row.creditLimit)} showIcon={false} size="sm" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          ) : null}

          {preview.issues.length > 0 ? <IssueList issues={preview.issues} /> : null}

          {!result ? (
            <>
              <Separator />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="accent"
                  disabled={preview.valid === 0 || busy}
                  loading={commitMutation.isPending}
                  onClick={() => commitMutation.mutate()}
                >
                  <Upload />
                  Import {preview.valid} part{preview.valid === 1 ? "y" : "ies"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Each one gets a ledger account and, where an opening balance is given, a
                  posted opening entry. Duplicates are left untouched.
                </p>
              </div>
            </>
          ) : null}
        </Card>
      ) : null}

      {/* ── Step 3: what actually happened ─────────────────────────────── */}
      {result ? (
        <Card className="space-y-4 p-4">
          <StepHeading n={3} title="What happened" done />

          <div className="grid gap-3 sm:grid-cols-3">
            <CountTile label="Imported" value={result.imported} tone="good" />
            <CountTile label="Skipped" value={result.skipped} tone={result.skipped > 0 ? "warn" : undefined} />
            <CountTile label="Rows in file" value={result.totalRows} />
          </div>

          {/* The truth, whatever it is: a partial import says so rather than reporting
              success and leaving the operator to discover the gap later. */}
          {result.imported < result.valid ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <span>
                {result.valid - result.imported} row
                {result.valid - result.imported === 1 ? "" : "s"} that passed the check still
                failed to import. They are listed below — the parties that did land are already
                on the books.
              </span>
            </p>
          ) : null}

          {result.issues.length > 0 ? <IssueList issues={result.issues} /> : null}

          <Button variant="outline" onClick={() => { setText(""); setPreview(null); setResult(null); }}>
            Import another file
          </Button>
        </Card>
      ) : null}

      {!text.trim() && !preview ? (
        <EmptyState
          icon={Users}
          title="Nothing pasted yet"
          description="Load the template to see the columns the importer understands, or paste a CSV straight in."
        />
      ) : null}
    </div>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function StepHeading({ n, title, done }: { n: number; title: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          done ? "bg-success text-success-foreground" : "bg-surface-muted text-muted-foreground",
        )}
      >
        {done ? <CheckCircle2 className="size-3.5" aria-hidden /> : n}
      </span>
      <h2 className="text-sm font-semibold">{title}</h2>
    </div>
  );
}

function CountTile({
  label, value, tone,
}: { label: string; value: number; tone?: "good" | "warn" | "bad" }) {
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        tone === "good" && value > 0 ? "border-success/40 bg-success/5"
        : tone === "warn" && value > 0 ? "border-warning/40 bg-warning/5"
        : tone === "bad" && value > 0 ? "border-destructive/40 bg-destructive/5"
        : "border-border bg-surface-muted/40",
      )}
    >
      <div className="tabular text-xl font-semibold">{value}</div>
      <div className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}

function IssueList({ issues }: { issues: ImportPreview["issues"] }) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return (
    <div className="space-y-2">
      <Separator />
      <p className="text-xs font-medium text-muted-foreground">
        {errors.length} error{errors.length === 1 ? "" : "s"}, {warnings.length} warning
        {warnings.length === 1 ? "" : "s"}
      </p>
      <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
        {[...errors, ...warnings].map((issue, i) => (
          <li key={`${issue.row}-${issue.field ?? ""}-${i}`} className="flex items-start gap-2">
            {issue.severity === "error" ? (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
            ) : (
              <Copy className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            )}
            <span>
              <span className="tabular font-medium text-foreground">Row {issue.row}</span>
              {issue.field ? <span className="text-muted-foreground"> · {issue.field}</span> : null}
              {" — "}
              {issue.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Parsing ─────────────────────────────────────────────────────────────── */

/**
 * Turn pasted CSV or spreadsheet text into row objects.
 *
 * Header mapping happens SERVER-SIDE — this only splits the text and keeps the header
 * names intact. Normalising here as well would mean two implementations of the same
 * mapping, and the one that matters is the one the importer actually uses.
 *
 * Quoted fields containing commas are handled, because Indian amounts are routinely
 * written "1,25,101.00" and a naive split would shred them into three columns.
 */
function parseSheet(text: string): { rows: Array<Record<string, string>>; errors: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return { rows: [], errors: lines.length === 1 ? ["Only a header row — add at least one party"] : [] };
  }

  const delimiter = lines[0]!.includes("\t") ? "\t" : ",";
  const headers = splitRow(lines[0]!, delimiter).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  const errors: string[] = [];

  lines.slice(1).forEach((line, index) => {
    const cells = splitRow(line, delimiter);
    if (cells.length !== headers.length) {
      errors.push(
        `Row ${index + 2}: ${cells.length} value${cells.length === 1 ? "" : "s"} for ${headers.length} columns` +
          (delimiter === "," ? " — an unquoted comma inside an amount is the usual cause" : ""),
      );
      return;
    }

    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header] = (cells[i] ?? "").trim();
    });
    rows.push(row);
  });

  return { rows, errors };
}

/** Split one delimited line, respecting double quotes and their "" escape. */
function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}
