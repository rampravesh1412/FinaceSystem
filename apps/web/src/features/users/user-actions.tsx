import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  Ban, Check, Copy, KeyRound, MoreHorizontal, Pencil, TriangleAlert, UserCheck,
} from "lucide-react";
import {
  updateUserSchema,
  type RoleSummary,
  type UpdateUserInput,
  type UserSummary,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { SelectField, TextField, applyServerErrors } from "@/components/form";
import { generatePassword } from "./password";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Managing an existing user (§5, §40).
 *
 * Until now an account could be created and never touched again: no way to correct a role,
 * revoke access when somebody leaves, or reset a forgotten password. Every endpoint
 * existed; none of them was reachable.
 *
 * Three separate actions with three separate permissions, deliberately not merged into one
 * "edit user" form. `users.edit` is held by far more people than `users.disable` or
 * `users.resetPassword`, and folding a password field into a general PATCH is a well-worn
 * route to privilege escalation.
 */
export function UserRowActions({ user }: { user: UserSummary }) {
  const { user: me, can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [changingStatus, setChangingStatus] = React.useState<"ACTIVE" | "BLOCKED" | null>(null);

  const isSelf = me?.id === user.id;
  const canEdit = can("users.edit");
  const canDisable = can("users.delete");
  const canReset = can("users.resetPassword");

  if (!canEdit && !canDisable && !canReset) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${user.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {canEdit ? (
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil />
              Edit details
            </DropdownMenuItem>
          ) : null}

          {canReset ? (
            <DropdownMenuItem onSelect={() => setResetting(true)}>
              <KeyRound />
              Reset password
            </DropdownMenuItem>
          ) : null}

          {canDisable && !isSelf ? (
            <>
              <DropdownMenuSeparator />
              {user.status === "ACTIVE" ? (
                <DropdownMenuItem destructive onSelect={() => setChangingStatus("BLOCKED")}>
                  <Ban />
                  Revoke access
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => setChangingStatus("ACTIVE")}>
                  <UserCheck />
                  Restore access
                </DropdownMenuItem>
              )}
            </>
          ) : null}

          {/* Shown rather than hidden: an administrator should understand why the option
              is absent instead of assuming the UI is broken. */}
          {canDisable && isSelf ? (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-2xs text-muted-foreground">
                You cannot revoke your own access — that is how an organisation locks itself
                out of its own books.
              </div>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? <EditUserDialog user={user} onClose={() => setEditing(false)} /> : null}
      {resetting ? <ResetPasswordDialog user={user} onClose={() => setResetting(false)} /> : null}
      {changingStatus ? (
        <StatusDialog user={user} next={changingStatus} onClose={() => setChangingStatus(null)} />
      ) : null}
    </>
  );
}

/* ── Edit ────────────────────────────────────────────────────────────────── */

function EditUserDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const roles = useQuery({
    queryKey: ["roles", "for-user-edit"],
    queryFn: () => api.list<RoleSummary>(`/roles${qs({ limit: 50 })}`),
  });

  const form = useForm<UpdateUserInput>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: {
      name: user.name,
      email: user.email,
      phone: user.phone ?? "",
      roleId: user.role.id,
      designation: user.designation ?? "",
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: UpdateUserInput) => api.patch<UserSummary>(`/users/${user.id}`, values),
    onSuccess: async () => {
      toast.success(`${user.name} updated`);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not update the user.");
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {user.name}</DialogTitle>
          <DialogDescription>
            Role changes take effect on their next request — they do not need to
            sign in again.
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
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="name" label="Name" required />
            <TextField form={form} name="email" label="Email" required type="email" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="phone" label="Phone" inputMode="numeric" />
            <TextField form={form} name="designation" label="Designation" />
          </div>

          <SelectField
            form={form}
            name="roleId"
            label="Role"
            options={(roles.data?.items ?? []).map((r) => ({
              value: r.id,
              label: r.label,
              detail: `${r.permissions.length} permissions`,
            }))}
          />


          {formError ? <InlineError message={formError} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Reset password ──────────────────────────────────────────────────────── */

function ResetPasswordDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = React.useState(() => generatePassword());
  const [mustChange, setMustChange] = React.useState(true);
  const [done, setDone] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/users/${user.id}/reset-password`, { newPassword: password, mustChange }),
    onSuccess: async () => {
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not reset the password.");
    },
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${user.email}\n${password}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy — select the text and copy it manually.");
    }
  };

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{done ? "Password reset" : `Reset ${user.name}'s password`}</DialogTitle>
          <DialogDescription>
            {done
              ? "This is the only time it is shown. Hand it over now."
              : "Every one of their sessions is signed out immediately, on every device."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New temporary password</Label>
            <div className="flex gap-2">
              <input
                id="new-password"
                readOnly={done}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="tabular flex h-9 flex-1 select-all rounded-md border border-input bg-surface px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {!done ? (
                <Button type="button" variant="outline" onClick={() => setPassword(generatePassword())}>
                  <KeyRound />
                  New
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => void copy()}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
            </div>
          </div>

          {!done ? (
            <>
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox
                  checked={mustChange}
                  onCheckedChange={(v) => setMustChange(v === true)}
                  className="mt-0.5"
                />
                <span>
                  Require them to choose a new password on their next sign-in.
                  <span className="block text-xs text-muted-foreground">
                    Leave this on unless you have a specific reason — otherwise the password you
                    just read out stays valid indefinitely.
                  </span>
                </span>
              </label>

              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                <span>
                  This signs {user.name} out everywhere and is recorded in the audit log against
                  your name. If they are mid-way through entering vouchers, they will lose the
                  form they are on.
                </span>
              </p>
            </>
          ) : (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs text-muted-foreground">
              The server stores only a hash — closing this puts the password beyond recovery.
              Reset it again if it is lost.
            </p>
          )}
        </div>

        <DialogFooter>
          {done ? (
            <Button variant="accent" onClick={onClose}>
              I have handed it over
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                Reset and sign them out
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Status ──────────────────────────────────────────────────────────────── */

function StatusDialog({
  user, next, onClose,
}: {
  user: UserSummary;
  next: "ACTIVE" | "BLOCKED";
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState("");
  const revoking = next === "BLOCKED";

  const mutation = useMutation({
    mutationFn: () => api.post(`/users/${user.id}/status`, { status: next, reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(revoking ? `${user.name}'s access revoked` : `${user.name} restored`, {
        description: revoking
          ? "They are signed out everywhere. Everything they posted stays on the books."
          : "They can sign in again with their existing password.",
      });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not change their status.");
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{revoking ? `Revoke ${user.name}'s access?` : `Restore ${user.name}?`}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              {revoking ? (
                <>
                  <p>
                    They are signed out immediately and cannot sign in again until restored.
                  </p>
                  {/* §28: the account is disabled, never deleted. Deleting it would orphan
                      every transaction they posted. */}
                  <p>
                    Their account is <span className="font-medium text-foreground">not deleted</span>
                    . Every transaction they posted stays on the books with their name on it —
                    that is what makes the audit trail worth having.
                  </p>
                </>
              ) : (
                <p>They will be able to sign in again with their existing password.</p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="status-reason">Reason (recorded in the audit log)</Label>
          <Textarea
            id="status-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={revoking ? "e.g. Left the company on 22 August" : "e.g. Returned from leave"}
            aria-describedby="status-reason-hint"
          />
          <p id="status-reason-hint" className="text-xs text-muted-foreground">
            At least 10 characters — this is what somebody reads in the audit log a year from
            now.{" "}
            {reason.trim().length > 0 && reason.trim().length < 10
              ? `${10 - reason.trim().length} more to go.`
              : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{user.role.label}</Badge>
          <Badge variant="outline">
          </Badge>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant={revoking ? "destructive" : "accent"}
            loading={mutation.isPending}
            disabled={reason.trim().length < 10}
            onClick={() => mutation.mutate()}
          >
            {revoking ? "Revoke access" : "Restore access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
      <span>{message}</span>
    </p>
  );
}
