import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Building2, Plus, Search, Users } from "lucide-react";
import { BranchRowActions } from "./branch-edit";
import { createBranchSchema, type BranchSummary, type CreateBranchInput } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth, Can } from "@/features/auth/auth-context";
import { useDebounced } from "@/hooks/use-debounced";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Branches (§6).
 *
 * The list a user sees is whatever the server returns — a branch admin gets their own
 * branches and nothing else, because `requireBranchAccess` narrowed the query. This page
 * applies no client-side filtering for access; it renders what it is given.
 */
export function BranchesPage() {
  const { user } = useAuth();
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const debouncedSearch = useDebounced(search, 300);

  React.useEffect(() => setPage(1), [debouncedSearch]);

  const query = useQuery({
    queryKey: ["branches", { page, q: debouncedSearch }],
    queryFn: () => api.list<BranchSummary>(`/branches${qs({ page, limit: 25, q: debouncedSearch })}`),
    // Keeps the previous page rendered while the next one loads, so the table does not
    // collapse to a spinner on every page change.
    placeholderData: (prev) => prev,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Branches"
        description={
          user?.isSuperAdmin
            ? "Every branch in the organisation."
            : "The branches you are assigned to."
        }
        actions={
          <Can permission="branches.create">
            <Button variant="accent" onClick={() => setCreateOpen(true)}>
              <Plus />
              New branch
            </Button>
          </Can>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, code or city…"
              className="pl-9"
              aria-label="Search branches"
            />
          </div>
        </div>

        {query.isPending ? (
          <TableSkeleton />
        ) : query.isError ? (
          <EmptyState
            icon={Building2}
            title="Could not load branches"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        ) : query.data.items.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={debouncedSearch ? "No branches matched" : "No branches yet"}
            description={
              debouncedSearch
                ? `Nothing matched “${debouncedSearch}”. Try a different name or code.`
                : "Create your first branch to start keeping books against it."
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Code</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="hidden md:table-cell">Location</TableHead>
                  <TableHead className="hidden lg:table-cell">Manager</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">Users</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden xl:table-cell">Created</TableHead>
                  <TableHead className="w-10 screen-only" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((branch) => (
                  <TableRow key={branch.id}>
                    <TableCell className="font-mono text-xs font-semibold">{branch.code}</TableCell>
                    <TableCell className="font-medium">{branch.name}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {[branch.city, branch.state].filter(Boolean).join(", ") || "—"}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {branch.manager?.name ?? "—"}
                    </TableCell>
                    <TableCell className="hidden text-right sm:table-cell">
                      <span className="tabular inline-flex items-center gap-1.5 text-muted-foreground">
                        <Users className="size-3.5" aria-hidden />
                        {branch.userCount}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={branch.status} />
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground xl:table-cell">
                      {formatDate(branch.createdAt)}
                    </TableCell>
                    <TableCell className="screen-only">
                      <BranchRowActions branch={branch} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationBar meta={query.data.meta} onPageChange={setPage} label="branches" />
          </>
        )}
      </Card>

      <CreateBranchDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === "ACTIVE" ? "success" : status === "BLOCKED" ? "danger" : "warning";
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  return <Badge variant={variant}>{label}</Badge>;
}

function TableSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-32 md:block" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function CreateBranchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const form = useForm<CreateBranchInput>({
    resolver: zodResolver(createBranchSchema),
    defaultValues: {
      name: "", code: "", city: "", state: "",
      openingCash: 0, openingBankBalance: 0, status: "ACTIVE",
    },
  });

  const mutation = useMutation({
    mutationFn: (values: CreateBranchInput) => api.post<BranchSummary>("/branches", values),
    onSuccess: async (branch) => {
      toast.success(`Branch ${branch.code} created`, {
        description: "Opening cash and bank balances have been posted to the ledger against equity.",
      });
      await queryClient.invalidateQueries({ queryKey: ["branches"] });
      form.reset();
      onOpenChange(false);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        // Field-level messages from the server land on the matching input, so a duplicate
        // branch code highlights the code field rather than showing a generic toast.
        for (const fe of error.fieldErrors) {
          form.setError(fe.field as keyof CreateBranchInput, { message: fe.message });
        }
        if (error.field) {
          form.setError(error.field as keyof CreateBranchInput, { message: error.message });
        }
        toast.error(error.message);
        return;
      }
      toast.error("Could not create the branch.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>
            The branch code is permanent — it appears on every statement and report issued
            against this branch.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
          className="space-y-4"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-[7rem_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                placeholder="105"
                className="font-mono"
                aria-invalid={Boolean(form.formState.errors.code)}
                {...form.register("code")}
              />
              {form.formState.errors.code ? (
                <p className="text-xs text-destructive">{form.formState.errors.code.message}</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="name">Branch name</Label>
              <Input
                id="name"
                placeholder="Boring Road Branch"
                aria-invalid={Boolean(form.formState.errors.name)}
                {...form.register("name")}
              />
              {form.formState.errors.name ? (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="city">City</Label>
              <Input id="city" placeholder="Patna" {...form.register("city")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="state">State</Label>
              <Input id="state" placeholder="Bihar" {...form.register("state")} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="openingCash">Opening cash</Label>
              <Input
                id="openingCash"
                inputMode="decimal"
                placeholder="0.00"
                className="tabular"
                {...form.register("openingCash")}
              />
              {form.formState.errors.openingCash ? (
                <p className="text-xs text-destructive">{form.formState.errors.openingCash.message}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="openingBankBalance">Opening bank balance</Label>
              <Input
                id="openingBankBalance"
                inputMode="decimal"
                placeholder="0.00"
                className="tabular"
                {...form.register("openingBankBalance")}
              />
              {form.formState.errors.openingBankBalance ? (
                <p className="text-xs text-destructive">
                  {form.formState.errors.openingBankBalance.message}
                </p>
              ) : null}
            </div>
          </div>

          <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
            Opening balances are not stored as a field on the branch. They post as a dated
            opening-balance transaction against equity, so day-zero figures are
            double-entry and auditable like every other movement.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Create branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
