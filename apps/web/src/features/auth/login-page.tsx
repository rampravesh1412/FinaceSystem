import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import { m } from "@/components/motion";
import { AlertCircle, Eye, EyeOff, Landmark, ShieldCheck } from "lucide-react";
import { loginSchema, type LoginInput } from "@amiri/shared";
import { ApiError } from "@/lib/api";
import { useAuth } from "./auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InstallAppCard } from "@/components/install-prompt";

export function LoginPage() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showPassword, setShowPassword] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    // The SAME schema the API validates with, so the client cannot be more permissive.
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  if (status === "authenticated") {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values.email, values.password);
      const from = (location.state as { from?: string } | null)?.from ?? "/";
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        for (const fe of err.fieldErrors) {
          setError(fe.field as keyof LoginInput, { message: fe.message });
        }
        // The server deliberately does not say which of email/password was wrong, so the
        // message is shown at form level rather than pinned to a field.
        setFormError(err.message);
        return;
      }
      setFormError("Could not reach the server. Check your connection and try again.");
    }
  });

  return (
    <div className="grid min-h-dvh px-safe lg:grid-cols-2">
      {/* Brand panel — hidden on small screens where the form should own the viewport. */}
      <div className="relative hidden overflow-hidden bg-sidebar lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 20%, hsl(var(--sidebar-accent)) 0, transparent 45%), radial-gradient(circle at 80% 70%, hsl(var(--sidebar-accent)) 0, transparent 40%)",
          }}
          aria-hidden
        />

        <div className="relative flex items-center gap-2.5 text-sidebar-foreground">
          <div className="flex size-9 items-center justify-center rounded-lg bg-sidebar-accent/15 ring-1 ring-sidebar-accent/25">
            <Landmark className="size-5 text-sidebar-accent" aria-hidden />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">AMIRI Finance</div>
            <div className="text-2xs uppercase tracking-widest text-sidebar-muted">
              Financial Operating System
            </div>
          </div>
        </div>

        <m.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="relative max-w-md space-y-5"
        >
          <h2 className="text-2xl font-semibold leading-snug tracking-tight text-sidebar-foreground">
            Every rupee traced. Every balance explained. Every change audited.
          </h2>
          <p className="text-sm leading-relaxed text-sidebar-muted">
            Double-entry ledger, branch-isolated books, approval workflows and immutable
            audit trails — built for people who have to reconcile at the end of the day.
          </p>
        </m.div>

        <div className="relative flex items-center gap-2 text-2xs text-sidebar-muted">
          <ShieldCheck className="size-3.5" aria-hidden />
          <span>Sessions are recorded. Failed sign-in attempts are logged and rate limited.</span>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center px-5 pb-[max(2.5rem,var(--safe-b))] pt-[max(2.5rem,var(--safe-t))] sm:px-8">
        <m.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-sm"
        >
          <div className="mb-7 lg:hidden">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-b from-accent to-accent/70 shadow-subtle">
                <Landmark className="size-6 text-accent-foreground" aria-hidden />
              </div>
              <div className="leading-tight">
                <div className="text-base font-semibold tracking-tight">AMIRI Finance</div>
                <div className="text-2xs uppercase tracking-widest text-muted-foreground">
                  Financial Operating System
                </div>
              </div>
            </div>
          </div>

          <div className="mb-6 space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted-foreground">
              Use the account issued to you by your administrator.
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {formError ? (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{formError}</span>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                placeholder="you@company.co"
                // A phone keyboard should not capitalise or autocorrect an address.
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                enterKeyHint="next"
                className="h-11 sm:h-9"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? "email-error" : undefined}
                {...register("email")}
              />
              {errors.email ? (
                <p id="email-error" className="text-xs text-destructive">
                  {errors.email.message}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  enterKeyHint="go"
                  className="h-11 pr-12 sm:h-9 sm:pr-10"
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? "password-error" : undefined}
                  {...register("password")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-0 top-0 flex h-11 w-12 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-10"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {errors.password ? (
                <p id="password-error" className="text-xs text-destructive">
                  {errors.password.message}
                </p>
              ) : null}
            </div>

            <Button
              type="submit"
              variant="accent"
              className="h-11 w-full text-[0.9375rem] sm:h-9 sm:text-sm"
              loading={isSubmitting}
            >
              Sign in
            </Button>
          </form>

          {/*
            Below the form, not above it.

            Somebody arriving at this screen came to sign in; an install card in front of
            the password field is an obstacle. Placed underneath, it is found by everyone
            who is going to care about it and ignored by everyone else — and it hides
            itself entirely once the app is installed or on a browser that cannot.
          */}
          <InstallAppCard className="mt-7" />

          <p className="mt-6 text-2xs leading-relaxed text-muted-foreground">
            Forgotten your password? An administrator must reset it — for audit reasons
            there is no self-service reset on a financial account.
          </p>
        </m.div>
      </div>
    </div>
  );
}
