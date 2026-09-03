import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Lock, LogOut, MoreHorizontal, Pencil, Plus, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import {
  ACTION_LABEL,
  ACTION_ORDER,
  ALL_PERMISSIONS,
  createRoleSchema,
  groupModules,
  type CreateRoleInput,
  type ModuleDefinition,
  type Permission,
  type PermissionAction,
  type RoleSummary,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { NotesField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Role management (§5).
 *
 * A role is a row of permission strings, not a branch in the code — so editing one changes
 * what every guard in the API allows, immediately and with no deploy. That power is why
 * this screen is deliberate about three things:
 *
 * 1. **Saving signs every holder out.** The server revokes their sessions so nobody keeps
 *    working against a permission set that no longer exists. The dialog says so before the
 *    save, with the number of people affected, because an administrator tightening a role
 *    at 4pm should know they are ejecting six people mid-voucher.
 *
 * 2. **The super-admin role cannot be defanged.** Removing `roles.manage` from it would
 *    leave nobody able to grant it back — recoverable only by direct database surgery. The
 *    server refuses; the form does not present the option at all.
 *
 * 3. **Unscoped is not a checkbox like the others.** It grants every branch, present and
 *    future, so only an existing super admin may set it.
 */

/* ── Create ──────────────────────────────────────────────────────────────── */

export function NewRoleButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus />
        New role
      </Button>
      {open ? <RoleDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function RoleRowActions({ role }: { role: RoleSummary }) {
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  if (!can("roles.edit")) return null;

  // The super admin role is immutable in both directions — see the note above.
  const locked = role.isSystem && role.isSuperAdmin;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${role.label}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {locked ? (
            <div className="px-2 py-1.5 text-2xs text-muted-foreground">
              The super admin role cannot be edited or deleted — removing its own
              permissions would leave nobody able to grant them back.
            </div>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil />
                Edit permissions
              </DropdownMenuItem>

              {role.isSystem ? (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1.5 text-2xs text-muted-foreground">
                    A system role's permissions are editable, but it cannot be deleted.
                  </div>
                </>
              ) : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
                    <Trash2 />
                    Delete role
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? <RoleDialog role={role} onClose={() => setEditing(false)} /> : null}
      {deleting ? <DeleteDialog role={role} onClose={() => setDeleting(false)} /> : null}
    </>
  );
}

/* ── The editor ──────────────────────────────────────────────────────────── */

function RoleDialog({ role, onClose }: { role?: RoleSummary; onClose: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const editing = Boolean(role);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [permissions, setPermissions] = React.useState<Permission[]>(
    (role?.permissions ?? []) as Permission[],
  );
  const [isSuperAdmin, setIsUnscoped] = React.useState(role?.isSuperAdmin ?? false);

  const groups = React.useMemo(() => groupModules({ includeHidden: true }), []);

  /**
   * Only the actions that actually occur in this group get a column.
   *
   * Rendering all thirteen everywhere would give the Reports group ten empty cells and
   * bury the two that matter. The column set is computed per group from the modules in it.
   */
  const columnsFor = React.useCallback(
    (modules: ModuleDefinition[]): PermissionAction[] =>
      ACTION_ORDER.filter((a) => modules.some((m) => m.actions.includes(a))),
    [],
  );

  const form = useForm<CreateRoleInput>({
    resolver: zodResolver(createRoleSchema),
    defaultValues: {
      name: role?.name ?? "",
      label: role?.label ?? "",
      description: role?.description ?? "",
      permissions: (role?.permissions ?? []) as never,
      isSuperAdmin: role?.isSuperAdmin ?? false,
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreateRoleInput) =>
      editing
        ? api.patch<RoleSummary>(`/roles/${role!.id}`, {
            label: values.label,
            description: values.description,
            permissions,
            ...(user?.isSuperAdmin ? { isSuperAdmin } : {}),
          })
        : api.post<RoleSummary>("/roles", { ...values, permissions, isSuperAdmin }),
    onSuccess: async () => {
      toast.success(editing ? `${role!.label} updated` : "Role created", {
        description:
          editing && (role?.userCount ?? 0) > 0
            ? `${role!.userCount} user${role!.userCount === 1 ? " has" : "s have"} been signed out — they will pick up the new permissions on their next sign-in.`
            : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not save the role.");
    },
  });

  const toggle = (permission: Permission) =>
    setPermissions((prev) =>
      prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission],
    );

  /** Toggle a whole set at once — a group header, or one module's row. */
  const toggleMany = (keys: Permission[]) =>
    setPermissions((prev) => {
      const allOn = keys.every((p) => prev.includes(p));
      return allOn
        ? prev.filter((p) => !keys.includes(p))
        : [...new Set([...prev, ...keys])];
    });

  const permissionsOf = (modules: ModuleDefinition[]): Permission[] =>
    modules.flatMap((m) => m.actions.map((a) => `${m.key}.${a}` as Permission));

  const holders = role?.userCount ?? 0;

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${role!.label}` : "New role"}</DialogTitle>
          <DialogDescription>
            Permissions take effect immediately, across every guard in the API.
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
            <TextField
              form={form}
              name="name"
              label="Identifier"
              required
              disabled={editing}
              className="font-mono uppercase"
              placeholder="BRANCH_CASHIER"
              hint={
                editing
                  ? "Permanent — it is what user records point at."
                  : "Uppercase, permanent once created."
              }
            />
            <TextField form={form} name="label" label="Display name" required placeholder="Branch Cashier" />
          </div>

          <NotesField form={form} name="description" label="Description" rows={2} />

          <Separator />

          {/* Unscoped is a different kind of grant from everything below, so it sits apart
              rather than as one checkbox among ninety. */}
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div className="space-y-1">
              <Label htmlFor="unscoped" className="flex items-center gap-1.5">
                <ShieldAlert className="size-3.5 text-warning" aria-hidden />
                Sees every branch
              </Label>
              <p className="text-xs text-muted-foreground">
                Overrides branch assignment entirely — including branches created in future.
                {!user?.isSuperAdmin ? " Only a super admin can change this." : null}
              </p>
            </div>
            <Switch
              id="unscoped"
              checked={isSuperAdmin}
              onCheckedChange={setIsUnscoped}
              disabled={!user?.isSuperAdmin}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Permissions</Label>
              <Badge variant="outline">
                {permissions.length} of {ALL_PERMISSIONS.length} selected
              </Badge>
            </div>

            {/**
             * A matrix: one row per sidebar entry, one column per action it supports.
             *
             * The old flat checklist could not express "Payment In but not Payment Out",
             * because those two screens shared a permission — and it showed keys that no
             * route checked, so ticking them changed nothing. Every row here is a menu
             * entry and every cell is a guard that runs.
             */}
            {groups.map((group) => {
              const groupPerms = permissionsOf(group.modules);
              const allOn = groupPerms.every((p) => permissions.includes(p));
              const someOn = groupPerms.some((p) => permissions.includes(p));
              const columns = columnsFor(group.modules);

              return (
                <div key={group.group} className="overflow-hidden rounded-md border border-border">
                  <button
                    type="button"
                    onClick={() => toggleMany(groupPerms)}
                    className="flex w-full items-center justify-between gap-2 border-b border-border bg-surface-muted/40 px-3 py-2 text-left hover:bg-surface-muted"
                  >
                    <span className="text-xs font-semibold">{group.group}</span>
                    <span className="text-2xs text-muted-foreground">
                      {allOn ? "All on — click to clear" : someOn ? "Some on" : "Click to select all"}
                    </span>
                  </button>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="px-3 py-1.5 text-left font-medium">Screen</th>
                          {columns.map((a) => (
                            <th key={a} className="px-2 py-1.5 text-center font-medium">
                              {ACTION_LABEL[a]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {group.modules.map((m) => {
                          const rowPerms = m.actions.map((a) => `${m.key}.${a}` as Permission);
                          return (
                            <tr key={m.key} className="border-b border-border/60 last:border-0">
                              <td className="px-3 py-1.5">
                                <button
                                  type="button"
                                  onClick={() => toggleMany(rowPerms)}
                                  className="text-left hover:underline"
                                  title={m.description}
                                >
                                  {m.label}
                                  {m.hideInMenu ? (
                                    <span className="ml-1.5 text-2xs text-muted-foreground">
                                      (no menu entry)
                                    </span>
                                  ) : null}
                                </button>
                              </td>
                              {columns.map((a) => {
                                const key = `${m.key}.${a}` as Permission;
                                // A blank cell means the action does not exist for this
                                // screen — a Balance Sheet cannot be approved. Showing an
                                // unchecked box there would imply it could be turned on.
                                if (!m.actions.includes(a)) {
                                  return <td key={a} className="px-2 py-1.5 text-center text-muted-foreground/30">–</td>;
                                }
                                return (
                                  <td key={a} className="px-2 py-1.5 text-center">
                                    <Checkbox
                                      aria-label={`${ACTION_LABEL[a]} ${m.label}`}
                                      checked={permissions.includes(key)}
                                      onCheckedChange={() => toggle(key)}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>

          {/* The consequence, stated before the button rather than discovered after it. */}
          {editing && holders > 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
              <LogOut className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                Saving signs out{" "}
                <span className="font-medium">
                  {holders} user{holders === 1 ? "" : "s"}
                </span>{" "}
                who hold this role. Anything they are part-way through entering will be lost —
                it is how the system guarantees nobody keeps working with permissions that have
                been withdrawn.
              </span>
            </p>
          ) : null}

          {permissions.length === 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">
                With no permissions, a holder can sign in and reach nothing at all.
              </span>
            </p>
          ) : null}

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
              {editing ? "Save permissions" : "Create role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Delete ──────────────────────────────────────────────────────────────── */

function DeleteDialog({ role, onClose }: { role: RoleSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const inUse = role.userCount > 0;

  const mutation = useMutation({
    mutationFn: () => api.del(`/roles/${role.id}`),
    onSuccess: async () => {
      toast.success(`${role.label} deleted`);
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not delete the role.");
    },
  });

  return (
    <AlertDialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {role.label}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {inUse ? (
                <p>
                  <span className="font-medium text-foreground">
                    {role.userCount} user{role.userCount === 1 ? "" : "s"} still hold this role.
                  </span>{" "}
                  The server will refuse — move them to another role first, so nobody is left
                  with a role that no longer exists.
                </p>
              ) : (
                <p>
                  Nobody holds this role, so nothing loses access. Audit entries recording past
                  permission changes to it stay on the record.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            loading={mutation.isPending}
            disabled={inUse}
            onClick={() => mutation.mutate()}
          >
            Delete role
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
