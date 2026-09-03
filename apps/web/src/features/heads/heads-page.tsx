import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Archive, Coins, Info, MoreHorizontal, Pencil, Plus, Receipt, RotateCcw } from "lucide-react";
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
                <TableHead className="screen-only w-12" />
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
                  <TableCell className="screen-only text-right">
                    <Can permission={permission as never}>
                      <HeadActions kind={kind} head={row} parents={rows} />
                    </Can>
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
                <TableCell className="screen-only" />
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

/* ── Retire, reactivate, rename ──────────────────────────────────────────── */

/**
 * A head is never deleted — it is RETIRED.
 *
 * Deleting one would orphan every posting made under it, and the Profit & Loss groups by
 * exactly that account, so the figures would stop tying. Retiring takes it out of the
 * pickers for new entries and leaves the history untouched, which is what "delete" almost
 * always means when somebody asks for it here. The confirmation says so, because the
 * difference matters and is not obvious from the word.
 */
function HeadActions({
  kind,
  head,
  parents,
}: {
  kind: Kind;
  head: AccountHeadRow;
  parents: AccountHeadRow[];
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const retiring = head.status === "ACTIVE";

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<AccountHeadRow>(`${ENDPOINT[kind]}/${head.id}`, body),
    onSuccess: async (updated) => {
      toast.success(
        updated.status === "ACTIVE" ? `${updated.name} is active` : `${updated.name} retired`,
      );
      await queryClient.invalidateQueries({ queryKey: ["heads"] });
      await queryClient.invalidateQueries({ queryKey: ["expense-categories"] });
      await queryClient.invalidateQueries({ queryKey: ["income-heads"] });
      setConfirming(false);
      setEditing(false);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not update the head."),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${head.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            destructive={retiring}
            onSelect={(e) => {
              e.preventDefault();
              // Reactivating is harmless and immediate; retiring gets a confirmation,
              // because it removes the head from every form that posts new entries.
              if (retiring) setConfirming(true);
              else mutation.mutate({ status: "ACTIVE" });
            }}
          >
            {retiring ? <Archive /> : <RotateCcw />}
            {retiring ? "Retire" : "Reactivate"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {head.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from the pickers, so nothing new can be posted against it.
              {head.entryCount > 0 ? (
                <>
                  {" "}
                  The {head.entryCount} entr{head.entryCount === 1 ? "y" : "ies"} already
                  booked under it stay exactly where they are and keep appearing in the
                  Profit &amp; Loss — retiring a head does not remove its history.
                </>
              ) : null}{" "}
              You can reactivate it at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it active</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                mutation.mutate({ status: "INACTIVE" });
              }}
            >
              Retire
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editing ? (
        <RenameHeadDialog
          head={head}
          parents={parents}
          saving={mutation.isPending}
          onSave={(body) => mutation.mutate(body)}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function RenameHeadDialog({
  head,
  parents,
  saving,
  onSave,
  onClose,
}: {
  head: AccountHeadRow;
  parents: AccountHeadRow[];
  saving: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [name, setName] = React.useState(head.name);
  const [description, setDescription] = React.useState(head.description ?? "");
  const [parentId, setParentId] = React.useState(head.parentId ?? "none");

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename {head.code}</DialogTitle>
          <DialogDescription>
            The new name reaches the ledger account too, so the Profit &amp; Loss stops
            printing the old one. The code never changes — reports already quote it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="head-name">Name</Label>
            <Input id="head-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="head-desc">Description</Label>
            <Input
              id="head-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="head-parent">Under</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger id="head-parent">
                <SelectValue placeholder="Top level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Top level</SelectItem>
                {parents
                  .filter((p) => p.status === "ACTIVE" && !p.parentId && p.id !== head.id)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            loading={saving}
            disabled={name.trim().length < 2}
            onClick={() =>
              onSave({
                name: name.trim(),
                description: description.trim() || undefined,
                parentId: parentId === "none" ? "" : parentId,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
