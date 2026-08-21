import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Ban, Building2, Lock, MoreHorizontal, Pencil, TriangleAlert } from "lucide-react";
import {
  updateBranchSchema,
  type BranchSummary,
  type UpdateBranchInput,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { NotesField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Editing a branch (§3).
 *
 * The branch CODE is immutable and the form says so. It appears on every voucher number,
 * statement and export issued against the branch — changing it would leave months of
 * documents referring to a code that no longer exists, with nothing linking them.
 *
 * Closing a branch does not touch its books. Its entries stay on the trial balance, because
 * they happened.
 */
export function BranchRowActions({ branch }: { branch: BranchSummary }) {
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [changingStatus, setChangingStatus] = React.useState<"ACTIVE" | "INACTIVE" | null>(null);

  const canEdit = can("branches.edit");
  if (!canEdit) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${branch.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Edit details
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {branch.status === "ACTIVE" ? (
            <DropdownMenuItem destructive onSelect={() => setChangingStatus("INACTIVE")}>
              <Ban />
              Close branch
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setChangingStatus("ACTIVE")}>
              <Building2 />
              Reopen branch
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? <EditBranchDialog branch={branch} onClose={() => setEditing(false)} /> : null}
      {changingStatus ? (
        <StatusDialog branch={branch} next={changingStatus} onClose={() => setChangingStatus(null)} />
      ) : null}
    </>
  );
}

/** The full record. The list summary carries only what the table renders. */
interface BranchDetail extends BranchSummary {
  address?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

function EditBranchDialog({ branch, onClose }: { branch: BranchSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  /**
   * Read the full branch rather than editing from the list row.
   *
   * `BranchSummary` carries what the table needs — name, city, status, counts — not the
   * address, phone or notes. Prefilling from it would show those fields empty and, on
   * save, blank out values the operator never saw.
   */
  const detail = useQuery({
    queryKey: ["branches", branch.id],
    queryFn: () => api.get<BranchDetail>(`/branches/${branch.id}`),
  });

  const form = useForm<UpdateBranchInput>({
    resolver: zodResolver(updateBranchSchema),
    values: detail.data
      ? ({
          name: detail.data.name,
          city: detail.data.city ?? "",
          state: detail.data.state ?? "",
          address: detail.data.address ?? "",
          phone: detail.data.phone ?? "",
          email: detail.data.email ?? "",
          notes: detail.data.notes ?? "",
        } as never)
      : undefined,
  });

  const mutation = useMutation({
    mutationFn: (values: UpdateBranchInput) =>
      api.patch<BranchSummary>(`/branches/${branch.id}`, values),
    onSuccess: async () => {
      toast.success(`${branch.code} updated`);
      await queryClient.invalidateQueries({ queryKey: ["branches"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not update the branch.");
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {branch.name}</DialogTitle>
          <DialogDescription>
            Balances and entries are unaffected — this changes how the branch is described,
            not what it holds.
          </DialogDescription>
        </DialogHeader>

        {detail.isPending ? (
          <div className="space-y-3 py-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : (
        <form
          onSubmit={form.handleSubmit((values) => {
            setFormError(null);
            mutation.mutate(values);
          })}
          className="space-y-4"
          noValidate
        >
          <TextField form={form} name="name" label="Branch name" required />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="city" label="City" />
            <TextField form={form} name="state" label="State" />
          </div>

          <TextField form={form} name="address" label="Address" />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="phone" label="Phone" inputMode="numeric" />
            <TextField form={form} name="email" label="Email" type="email" />
          </div>

          <NotesField form={form} name="notes" label="Notes" />

          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              The code <span className="font-mono font-medium text-foreground">{branch.code}</span> is
              permanent. It appears on every voucher number, statement and export issued against
              this branch — changing it would leave those documents pointing at a code that no
              longer exists.
            </span>
          </p>

          {formError ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <span>{formError}</span>
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusDialog({
  branch, next, onClose,
}: {
  branch: BranchSummary;
  next: "ACTIVE" | "INACTIVE";
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState("");
  const closing = next === "INACTIVE";

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/branches/${branch.id}/status`, { status: next, reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(closing ? `${branch.code} closed` : `${branch.code} reopened`);
      await queryClient.invalidateQueries({ queryKey: ["branches"] });
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not change the status.");
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {closing ? `Close ${branch.name}?` : `Reopen ${branch.name}?`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              {closing ? (
                <>
                  <p>No new transactions can be posted against this branch.</p>
                  {/* §28 again: the record is never removed, only stopped. */}
                  <p>
                    Its books are <span className="font-medium text-foreground">untouched</span>.
                    Every entry stays on the trial balance and in every report covering the
                    period — they happened, and closing the branch does not unhappen them.
                  </p>
                </>
              ) : (
                <p>Transactions can be posted against this branch again.</p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="branch-status-reason">Reason (recorded in the audit log)</Label>
          <Textarea
            id="branch-status-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={closing ? "e.g. Consolidated into the Boring Road branch" : "e.g. Reopened after refurbishment"}
            aria-describedby="branch-reason-hint"
          />
          <p id="branch-reason-hint" className="text-xs text-muted-foreground">
            At least 10 characters — this is what somebody reads in the audit log a year from
            now.{" "}
            {reason.trim().length > 0 && reason.trim().length < 10
              ? `${10 - reason.trim().length} more to go.`
              : null}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant={closing ? "destructive" : "accent"}
            loading={mutation.isPending}
            disabled={reason.trim().length < 10}
            onClick={() => mutation.mutate()}
          >
            {closing ? "Close branch" : "Reopen branch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
