import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Plus, TriangleAlert } from "lucide-react";
import {
  createUserSchema,
  type CreateUserInput,
  type RoleSummary,
  type UserSummary,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { SelectField, TextField, applyServerErrors } from "@/components/form";
import { generatePassword } from "./password";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Invite a user (§5, §40).
 *
 * Two things this form takes seriously.
 *
 * **Branch assignment is the security boundary, not a preference.** Every query the user
 * ever makes is filtered by `{ branchId: { $in: branchIds } }`, so an empty list means
 * they can see nothing — which is the correct fail-closed default, and the form says so
 * rather than letting an administrator create an account that mysteriously shows no data.
 *
 * **The temporary password is shown exactly once.** It is generated in the browser from
 * `crypto.getRandomValues`, submitted, and then displayed for the administrator to hand
 * over — after which it is gone, because the server stores only an argon2id hash and has
 * nothing to show. `mustChangePassword` is set, so it survives one sign-in.
 */
export function NewUserButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus />
        Invite user
      </Button>
      <UserDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function UserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<{ user: UserSummary; password: string } | null>(null);

  const roles = useQuery({
    queryKey: ["roles", "for-user-form"],
    queryFn: () => api.list<RoleSummary>(`/roles${qs({ limit: 50 })}`),
    enabled: open,
  });

  const form = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      name: "", email: "", phone: "", password: "",
      roleId: "", designation: "",
      status: "ACTIVE", mustChangePassword: true,
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreateUserInput) => api.post<UserSummary>("/users", values),
    onSuccess: async (user, values) => {
      // Held in component state, never re-fetched: the server keeps only the hash.
      setCreated({ user, password: values.password });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not create the user.");
    },
  });

  const close = () => {
    form.reset();
    setCreated(null);
    setFormError(null);
    onOpenChange(false);
  };

  if (created) {
    return (
      <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : close())}>
        <DialogContent className="sm:max-w-lg">
          <CredentialHandover user={created.user} password={created.password} onDone={close} />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Invite a user</DialogTitle>
          <DialogDescription>
            They sign in with a temporary password you hand over, and must change it
            immediately.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit((values) => {
            setFormError(null);
            mutation.mutate({ ...values, password: values.password || generatePassword() });
          })}
          className="space-y-4"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="name" label="Name" required placeholder="Ram Pravesh" />
            <TextField form={form} name="email" label="Email" required type="email" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="phone" label="Phone" inputMode="numeric" />
            <TextField form={form} name="designation" label="Designation" placeholder="Branch Accountant" />
          </div>

          <SelectField
            form={form}
            name="roleId"
            label="Role"
            required
            placeholder={roles.isPending ? "Loading…" : "Choose a role"}
            options={(roles.data?.items ?? []).map((r) => ({
              value: r.id,
              label: r.label,
              detail: `${r.permissions.length} permissions`,
            }))}
          />

          <Separator />

          <TemporaryPasswordField form={form} />

          {formError ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <span>{formError}</span>
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TemporaryPasswordField({ form }: { form: ReturnType<typeof useForm<CreateUserInput>> }) {
  const value = form.watch("password");

  React.useEffect(() => {
    if (!value) form.setValue("password", generatePassword());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <TextField
          form={form}
          name="password"
          label="Temporary password"
          required
          className="flex-1 font-mono"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => form.setValue("password", generatePassword(), { shouldValidate: true })}
        >
          <KeyRound />
          Regenerate
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Generated in your browser and shown once after the account is created. The server
        keeps only a hash, so it cannot be retrieved later — reset it instead.
      </p>
    </div>
  );
}

/* ── Handover ────────────────────────────────────────────────────────────── */

function CredentialHandover({
  user, password, onDone,
}: {
  user: UserSummary;
  password: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

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
    <>
      <DialogHeader>
        <DialogTitle>{user.name} can now sign in</DialogTitle>
        <DialogDescription>
          This is the only time these credentials are shown. Hand them over now.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <div className="space-y-2 rounded-md border border-border bg-surface-muted/40 p-3">
          <Row label="Email" value={user.email} />
          <Row label="Temporary password" value={password} mono />
        </div>

        <Button variant="outline" onClick={() => void copy()} className="w-full">
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy both"}
        </Button>

        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            The server stores only a hash of this password — closing this dialog puts it beyond
            recovery. If it is lost, reset it rather than recreating the account, so their
            audit history stays attached to them.
          </span>
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{user.role.label}</Badge>
          <span>They will be asked to set a new password on first sign-in.</span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="accent" onClick={onDone}>
          I have handed these over
        </Button>
      </DialogFooter>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`select-all text-sm ${mono ? "font-mono font-medium" : ""}`}>{value}</span>
    </div>
  );
}
