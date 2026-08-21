import * as React from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Form primitives.
 *
 * Five create forms landed at once — party, bank, bank account, cash account, user — and
 * each field is the same four things: a label, a control, a server-or-client error, and a
 * hint. Written out longhand that is forty near-identical blocks, and the failure mode is
 * predictable: one of them forgets `aria-invalid`, or shows the client error but not the
 * server's, and nobody notices because the happy path looks fine.
 *
 * So it is one component, wired to React Hook Form's error state, and every field gets the
 * accessibility wiring whether or not the author remembered it: `aria-invalid` on the
 * control, `aria-describedby` pointing at the message, and the message in a live region so
 * a screen reader announces a validation failure rather than leaving the user re-submitting
 * a form that silently refuses.
 */

interface BaseFieldProps<T extends FieldValues> {
  form: UseFormReturn<T>;
  name: Path<T>;
  label: string;
  hint?: string;
  required?: boolean;
  className?: string;
}

function useFieldState<T extends FieldValues>(form: UseFormReturn<T>, name: Path<T>) {
  // Nested paths ("tiers.0.from") need walking rather than a direct index.
  const error = name
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], form.formState.errors);

  const message = (error as { message?: string } | undefined)?.message;
  const id = `field-${String(name).replace(/\./g, "-")}`;
  return { message, id, describedBy: message ? `${id}-error` : undefined };
}

function FieldShell({
  id, label, required, hint, message, className, children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  message?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-hidden>
            *
          </span>
        ) : null}
      </Label>

      {children}

      {message ? (
        /* Announced, not just coloured — §43 applies to errors as much as to amounts. */
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {message}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/* ── Text ────────────────────────────────────────────────────────────────── */

export function TextField<T extends FieldValues>({
  form, name, label, hint, required, className, registerOptions, ...input
}: BaseFieldProps<T> &
  Omit<React.ComponentProps<typeof Input>, "form" | "name"> & {
    /**
     * Passed through to `register`, for the rare field that needs it — `valueAsNumber` on
     * an integer input, for instance. Spreading a second `register()` call over the input
     * instead would set `name` twice and the later one silently wins.
     */
    registerOptions?: Parameters<UseFormReturn<T>["register"]>[1];
  }) {
  const { message, id, describedBy } = useFieldState(form, name);
  return (
    <FieldShell id={id} label={label} required={required} hint={hint} message={message} className={className}>
      <Input
        id={id}
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        {...input}
        {...form.register(name, registerOptions)}
      />
    </FieldShell>
  );
}

/**
 * An amount field.
 *
 * Registers with `valueAsNumber: false` and lets the shared Zod `money` schema do the
 * parsing, so "1,25,101.00" is accepted exactly as the API accepts it. Parsing in the
 * browser as well would be a second implementation of Indian digit grouping, and the two
 * would disagree on some input eventually.
 */
export function AmountField<T extends FieldValues>({
  form, name, label, hint, required, className, ...input
}: BaseFieldProps<T> & Omit<React.ComponentProps<typeof Input>, "form" | "name">) {
  const { message, id, describedBy } = useFieldState(form, name);
  return (
    <FieldShell id={id} label={label} required={required} hint={hint} message={message} className={className}>
      <Input
        id={id}
        inputMode="decimal"
        placeholder="0.00"
        className="tabular"
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        {...input}
        {...form.register(name)}
      />
    </FieldShell>
  );
}

/* ── Select ──────────────────────────────────────────────────────────────── */

export interface SelectOption {
  value: string;
  label: string;
  /** Second line in the dropdown — a branch's city, a role's description. */
  detail?: string;
}

export function SelectField<T extends FieldValues>({
  form, name, label, hint, required, className, options, placeholder, disabled,
}: BaseFieldProps<T> & {
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const { message, id, describedBy } = useFieldState(form, name);
  const value = form.watch(name) as string | undefined;

  return (
    <FieldShell id={id} label={label} required={required} hint={hint} message={message} className={className}>
      <Select
        value={value ?? ""}
        disabled={disabled}
        onValueChange={(v) =>
          form.setValue(name, v as never, { shouldValidate: true, shouldDirty: true })
        }
      >
        <SelectTrigger id={id} aria-invalid={Boolean(message)} aria-describedby={describedBy}>
          <SelectValue placeholder={placeholder ?? "Choose…"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="flex flex-col items-start">
                <span>{option.label}</span>
                {option.detail ? (
                  <span className="text-2xs text-muted-foreground">{option.detail}</span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}

/* ── Textarea ────────────────────────────────────────────────────────────── */

export function NotesField<T extends FieldValues>({
  form, name, label, hint, className, rows = 3,
}: BaseFieldProps<T> & { rows?: number }) {
  const { message, id, describedBy } = useFieldState(form, name);
  return (
    <FieldShell id={id} label={label} hint={hint} message={message} className={className}>
      <Textarea
        id={id}
        rows={rows}
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        {...form.register(name)}
      />
    </FieldShell>
  );
}

/* ── Server errors ───────────────────────────────────────────────────────── */

/**
 * Push an `ApiError` onto the form.
 *
 * The server is the authority on uniqueness, branch scope and business rules, so its
 * field-level messages have to land on the matching input rather than in a toast that
 * disappears — a duplicate party code should highlight the code field, next to the value
 * that caused it.
 *
 * Returns the messages that could NOT be attributed to a field, so the caller can surface
 * them somewhere visible instead of dropping them.
 */
export function applyServerErrors<T extends FieldValues>(
  form: UseFormReturn<T>,
  error: unknown,
): string | null {
  const api = error as {
    fieldErrors?: Array<{ field: string; message: string }>;
    field?: string;
    message?: string;
  };

  let attributed = false;

  for (const fe of api.fieldErrors ?? []) {
    form.setError(fe.field as Path<T>, { message: fe.message });
    attributed = true;
  }

  if (api.field) {
    form.setError(api.field as Path<T>, { message: api.message ?? "This value was refused" });
    attributed = true;
  }

  return attributed ? null : (api.message ?? "The server refused this. Please try again.");
}
