import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { changePasswordSchema, type ChangePasswordInput } from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "./auth-context";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const mutation = useMutation({
    mutationFn: (values: ChangePasswordInput) => api.post("/auth/change-password", values),
    onSuccess: async () => {
      toast.success("Password updated", {
        description: "You have been signed out on every device. Please sign in again.",
      });
      // Changing a password revokes every session, including this one, so the only
      // correct next state is the login screen.
      await logout();
      navigate("/login", { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        for (const fe of error.fieldErrors) {
          form.setError(fe.field as keyof ChangePasswordInput, { message: fe.message });
        }
        if (error.code === "INVALID_CREDENTIALS") {
          form.setError("currentPassword", { message: "That is not your current password" });
          return;
        }
        toast.error(error.message);
        return;
      }
      toast.error("Could not change your password.");
    },
  });

  if (!user) return null;

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="Profile" description="Your account and access." />

      <Card>
        <CardHeader><CardTitle className="text-base">Account</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Name" value={user.name} />
          <Row label="Email" value={user.email} />
          <Row label="Role" value={<Badge variant="accent">{user.role.label}</Badge>} />
          <Row label="Last sign-in" value={formatDateTime(user.lastLoginAt)} />
          <Row
            label="Permissions"
            value={user.permissions.includes("*") ? "All" : String(user.permissions.length)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Change password</CardTitle>
          <p className="text-sm text-muted-foreground">
            Changing your password signs you out everywhere — including here.
          </p>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            className="space-y-4"
            noValidate
          >
            <Field
              id="currentPassword"
              label="Current password"
              error={form.formState.errors.currentPassword?.message}
              register={form.register("currentPassword")}
              autoComplete="current-password"
            />
            <Field
              id="newPassword"
              label="New password"
              hint="At least 10 characters, with an uppercase letter and a number."
              error={form.formState.errors.newPassword?.message}
              register={form.register("newPassword")}
              autoComplete="new-password"
            />
            <Field
              id="confirmPassword"
              label="Confirm new password"
              error={form.formState.errors.confirmPassword?.message}
              register={form.register("confirmPassword")}
              autoComplete="new-password"
            />
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Update password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-3 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function Field({
  id, label, hint, error, register, autoComplete,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  register: ReturnType<ReturnType<typeof useForm<ChangePasswordInput>>["register"]>;
  autoComplete: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="password" autoComplete={autoComplete} aria-invalid={Boolean(error)} {...register} />
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
