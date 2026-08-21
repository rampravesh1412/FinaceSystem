import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Coins, Info, Plus, Receipt } from "lucide-react";
import {
  createExpenseCategorySchema,
  type CreateExpenseCategoryInput,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { Can } from "@/features/auth/auth-context";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Expense heads and income heads (§16, §17).
 *
 * These are not labels. Per §4.1 an expense head **is a ledger account** — creating one
 * adds a row to the chart of accounts, and every rupee posted against it lands in the
 * Profit & Loss under that name. That is why this screen shows the balance next to each
 * head rather than just its name: the only question anybody asks of this list is where the
 * money went.
 *
 * Until now there was no way to add one at all. A business whose expenses did not happen to
 * match the seeded heads had to file everything under whichever seeded head was closest,
 * which quietly corrupts every P&L that follows.
 */

interface AccountHeadRow {
  id: string;
  name: string;
  code: string;
  description?: string;
  parentId: string | null;
  parentName?: string;
  ledgerAccountId: string;
  balance: number;
  entryCount: number;
  status: string;
}

type Kind = "EXPENSE" | "INCOME";

const ENDPOINT: Record<Kind, string> = {
  EXPENSE: "/expenses/categories",
  INCOME: "/income/heads",
};

export function HeadsPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Expense & Income Heads"
        description="Each head is a ledger account. Everything posted against it appears under this name in the Profit & Loss."
      />

      <Tabs defaultValue="EXPENSE">
        <TabsList>
          <TabsTrigger value="EXPENSE">
            <Receipt className="mr-1.5 size-3.5" />
            Expense heads
          </TabsTrigger>
          <TabsTrigger value="INCOME">
            <Coins className="mr-1.5 size-3.5" />
            Income heads
          </TabsTrigger>
        </TabsList>

        <TabsContent value="EXPENSE">
          <HeadsTable kind="EXPENSE" />
        </TabsContent>
        <TabsContent value="INCOME">
          <HeadsTable kind="INCOME" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function HeadsTable({ kind }: { kind: Kind }) {
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const query = useQuery({
    queryKey: ["heads", kind, includeInactive],
    queryFn: () => api.get<AccountHeadRow[]>(`${ENDPOINT[kind]}${qs({ includeInactive })}`),
  });

  const rows = query.data ?? [];
  const total = rows.reduce((sum, r) => sum + r.balance, 0);
  const permission = kind === "EXPENSE" ? "finance.expense.manageCategories" : "finance.income.manageHeads";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={includeInactive} onCheckedChange={setIncludeInactive} />
          Show retired heads
        </label>

        <Can permission={permission as never}>
          <Button variant="accent" onClick={() => setCreating(true)}>
            <Plus />
            New {kind === "EXPENSE" ? "expense" : "income"} head
          </Button>
        </Can>
      </div>

      <Card className="overflow-hidden">
        {query.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={kind === "EXPENSE" ? Receipt : Coins}
            title="Could not load the heads"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={kind === "EXPENSE" ? Receipt : Coins}
            title={`No ${kind.toLowerCase()} heads yet`}
            description="Add one before recording anything — a transaction has to be posted against a head, and the head is what the Profit & Loss groups by."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Code</TableHead>
                <TableHead>Head</TableHead>
                <TableHead className="hidden lg:table-cell">Under</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Entries</TableHead>
                <TableHead className="text-right">
                  {kind === "EXPENSE" ? "Spent" : "Earned"}
                </TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{row.code}</TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{row.name}</div>
                    {row.description ? (
                      <div className="truncate text-2xs text-muted-foreground">{row.description}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {row.parentName ?? "—"}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">
                    {row.entryCount}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.balance ? (
                      <Money value={row.balance} showIcon={false} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.status === "ACTIVE" ? "success" : "outline"}>
                      {row.status === "ACTIVE" ? "Active" : "Retired"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} className="text-xs uppercase tracking-wider text-muted-foreground">
                  Total across {rows.length} head{rows.length === 1 ? "" : "s"}
                </TableCell>
                <TableCell className="text-right">
                  <Money value={total} showIcon={false} className="font-semibold" />
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </Card>

      {creating ? (
        <HeadDialog kind={kind} parents={rows} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}

/* ── Create ──────────────────────────────────────────────────────────────── */

function HeadDialog({
  kind, parents, onClose,
}: {
  kind: Kind;
  parents: AccountHeadRow[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<CreateExpenseCategoryInput>({
    resolver: zodResolver(createExpenseCategorySchema),
    defaultValues: { name: "", code: "", description: "", status: "ACTIVE" } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreateExpenseCategoryInput) =>
      api.post<{ name: string; code: string }>(ENDPOINT[kind], values),
    onSuccess: async (head) => {
      toast.success(`${head.name} added`, {
        description: "A ledger account has been created for it — it will appear on the P&L.",
      });
      await queryClient.invalidateQueries({ queryKey: ["heads"] });
      // The transaction forms read the same lists for their dropdowns.
      await queryClient.invalidateQueries({ queryKey: ["expense-categories"] });
      await queryClient.invalidateQueries({ queryKey: ["income-heads"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not add the head.");
    },
  });

  const label = kind === "EXPENSE" ? "expense" : "income";

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New {label} head</DialogTitle>
          <DialogDescription>
            This creates a ledger account. Everything posted against it is grouped under this
            name in the Profit & Loss, so name it the way you want it to read on the report.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit((values) => {
            setFormError(null);
            mutation.mutate(values);
          })}
          className="space-y-4"
          noValidate
        >
          <TextField
            form={form}
            name="name"
            label="Name"
            required
            placeholder={kind === "EXPENSE" ? "Panel Expense" : "Commission Income"}
          />

          <TextField
            form={form}
            name="code"
            label="Code"
            hint={`Left blank, one is generated as ${kind === "EXPENSE" ? "EXP-001" : "INC-001"}.`}
            className="font-mono uppercase"
          />

          <SelectField
            form={form}
            name="parentId"
            label="Under"
            hint="Optional. A sub-head groups beneath a broader one on the report."
            placeholder="Top level"
            options={parents
              .filter((p) => p.status === "ACTIVE" && !p.parentId)
              .map((p) => ({ value: p.id, label: p.name, detail: p.code }))}
          />

          <NotesField form={form} name="description" label="Description" rows={2} />

          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              Heads are organisation-wide, not per branch — "Salary" means the same thing
              everywhere, so the P&L can group across branches without merging duplicates.
            </span>
          </p>

          {formError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              {formError}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Create head
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
