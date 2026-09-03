import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFieldArray, useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { AlertCircle, Plus, Trash2 } from "lucide-react";
import {
  PAYMENT_MODE_LABEL,
  createBankTransferSchema,
  createExpenseSchema,
  createIncomeSchema,
  createPaymentInSchema,
  createPaymentOutSchema,
  formatINR,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  useAccounts, useChargePreview, useChargeRules, useExpenseCategories,
  useIncomeHeads, useParties,
} from "./use-reference-data";

/**
 * Transaction entry (§14, §15, §8, §16).
 *
 * One dialog, four modes, because the four forms differ only in which accounts they name.
 * What they all share is the part that matters: a live GROSS / CHARGE / NET breakdown
 * computed by the server before anything is posted (§18), and an explicit confirmation
 * summary for a high-value amount (§65).
 */

export type TransactionMode = "PAYMENT_IN" | "PAYMENT_OUT" | "BANK_TRANSFER" | "EXPENSE" | "INCOME";

const MODE_CONFIG = {
  PAYMENT_IN: {
    title: "Record Payment In",
    description: "Money received from a party. Debits the account, reduces what they owe.",
    endpoint: "/payment-in",
    schema: createPaymentInSchema,
    action: "Record receipt",
  },
  PAYMENT_OUT: {
    title: "Record Payment Out",
    description: "Money paid to a party. Credits the account, settles what we owe.",
    endpoint: "/payment-out",
    schema: createPaymentOutSchema,
    action: "Record payment",
  },
  BANK_TRANSFER: {
    title: "New Bank Transfer",
    description: "Move money between your own accounts. The destination receives the full gross.",
    endpoint: "/bank-transfers",
    schema: createBankTransferSchema,
    action: "Transfer",
  },
  EXPENSE: {
    title: "Record Expense",
    description: "A cost booked against an expense head, paid from an account or left as a payable.",
    endpoint: "/expenses",
    schema: createExpenseSchema,
    action: "Record expense",
  },
  INCOME: {
    title: "Record Income",
    /**
     * §17. The distinction from a Payment In is the whole reason this is a separate mode:
     * a receipt settles what a party already owed and moves no needle on profit, whereas
     * income is money EARNED and lands in the P&L. Recording commission as a Payment In
     * would leave the party with a phantom credit and understate profit by the same amount.
     */
    description: "Money earned — commission, interest, service income. Credits an income head, so it appears in the Profit & Loss.",
    endpoint: "/income",
    schema: createIncomeSchema,
    action: "Record income",
  },
} as const;

/** Above this, the confirmation step spells the transfer out in words (§65). */
const HIGH_VALUE_THRESHOLD = 100_000_00; // ₹1,00,000

export function TransactionFormDialog({
  mode,
  open,
  onOpenChange,
}: {
  mode: TransactionMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const config = MODE_CONFIG[mode];
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);

  const form = useForm<Record<string, unknown>>({
    resolver: zodResolver(config.schema as never),
    defaultValues: {
      date: new Date().toISOString().slice(0, 10),
      // Seeded from the branch in context, but the operator can change it below. Empty
      // under the all-branches view, which makes the field the thing that asks.
      branchId: user?.activeBranchId ?? "",
      amount: "",
      paymentMode: mode === "BANK_TRANSFER" ? "NEFT" : "CASH",
      attachments: [],
      items: [],
      taxAmount: "0",
    },
  });

  /**
   * The posting branch is now a field, not the ambient context.
   *
   * Reading it back from the form rather than from the session is what lets a super admin
   * work from the all-branches view: they choose where this entry belongs as part of
   * filling it in, instead of leaving the dialog to switch context and starting over.
   */
  const branchId = (form.watch("branchId") as string) ?? "";

  const { options: allAccounts, isPending: accountsPending } = useAccounts();

  /**
   * Every account, whichever branch is posting.
   *
   * Accounts are organisation-wide: one bank account is one real account that every
   * counter pays into and draws on. Both legs of the posting are still stamped with the
   * branch chosen above, so each branch's own books continue to balance — what has gone
   * is the pretence that a branch owns a share of the company's bank balance.
   */
  const accounts = allAccounts;
  const parties = useParties();
  const categories = useExpenseCategories();
  const incomeHeads = useIncomeHeads();
  const chargeRules = useChargeRules();

  /**
   * Changing the branch drops any account already chosen.
   *
   * The account fields are filtered by branch, so a selection made under the previous one
   * would otherwise survive as an id the operator can no longer see in the list — and be
   * submitted, and be refused by the server for a reason nothing on screen explains.
   * Party and amount are left alone: those are still valid wherever this is posted.
   */
  const previousBranch = React.useRef(branchId);
  React.useEffect(() => {
    if (previousBranch.current === branchId) return;
    previousBranch.current = branchId;
    for (const field of ["accountId", "sourceAccountId", "destinationAccountId"]) {
      if (form.getValues(field) !== undefined) form.setValue(field, "");
    }
  }, [branchId, form]);

  const amount = String(form.watch("amount") ?? "");
  const chargeRuleId = form.watch("chargeRuleId") as string | undefined;
  const preview = useChargePreview(chargeRuleId, amount);

  const applicableRules = (chargeRules.data ?? []).filter(
    (r) => r.appliesTo.length === 0 || r.appliesTo.includes(mode),
  );

  const mutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.post<{ txnNo: string }>(config.endpoint, values),
    onSuccess: async (txn) => {
      toast.success(`${txn.txnNo} posted`, {
        description: "The ledger entries are on the books and can be seen in the DayBook.",
      });
      await queryClient.invalidateQueries();
      form.reset();
      setConfirming(false);
      onOpenChange(false);
    },
    onError: (error) => {
      setConfirming(false);
      if (error instanceof ApiError) {
        for (const fe of error.fieldErrors) form.setError(fe.field, { message: fe.message });
        if (error.field) form.setError(error.field, { message: error.message });
        toast.error(error.message);
        return;
      }
      toast.error("Could not post the transaction.");
    },
  });

  const parsedAmount = Number(amount.replace(/[^\d.-]/g, "")) * 100;
  const isHighValue = parsedAmount >= HIGH_VALUE_THRESHOLD;

  const submit = form.handleSubmit((values) => {
    // A large amount gets a second, explicit look before it is posted (§65).
    if (isHighValue && !confirming) {
      setConfirming(true);
      return;
    }
    mutation.mutate(values);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConfirming(false);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Branch" error={err(form, "branchId")}>
            {({ id, describedBy }) => (
              <SelectField
                id={id}
                describedBy={describedBy}
                value={branchId}
                onChange={(v) => form.setValue("branchId", v, { shouldValidate: true })}
                placeholder="Choose a branch"
                options={(user?.branches ?? []).map((b) => ({
                  value: b.id,
                  label: `${b.code} — ${b.name}`,
                }))}
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" error={err(form, "date")}>
              <Input type="date" {...form.register("date")} />
            </Field>

            <Field label="Amount" error={err(form, "amount")}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="tabular"
                  {...form.register("amount")}
                />
              )}
            </Field>
          </div>

          {mode === "PAYMENT_IN" || mode === "PAYMENT_OUT" ? (
            <>
              <Field label="Party" error={err(form, "partyId")}>
                {({ id, describedBy }) => (
                  <SelectField
                    id={id}
                    describedBy={describedBy}
                    value={form.watch("partyId") as string}
                    onChange={(v) => form.setValue("partyId", v, { shouldValidate: true })}
                    placeholder="Choose a party"
                    /**
                     * The whole party master. Parties are organisation-wide, so there is
                     * no longer a "belongs to another branch" case to warn about — a
                     * customer settles at whichever office is nearest and it is the same
                     * account either way.
                     */
                    options={(parties.data?.items ?? []).map((p) => ({
                      value: p.id,
                      label: `${p.name} (${p.code})`,
                      hint: p.balance !== 0 ? formatINR(Math.abs(p.balance)) : undefined,
                    }))}
                  />
                )}
              </Field>

              <Field
                label={mode === "PAYMENT_IN" ? "Received into" : "Paid from"}
                error={err(form, "accountId")}
              >
                {({ id, describedBy }) => (
                  <AccountSelect
                    id={id}
                    describedBy={describedBy}
                    accounts={accounts}
                    loading={accountsPending}
                    value={form.watch("accountId") as string}
                    onChange={(v) => form.setValue("accountId", v, { shouldValidate: true })}
                  />
                )}
              </Field>
            </>
          ) : null}

          {mode === "BANK_TRANSFER" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From" error={err(form, "sourceAccountId")}>
                {({ id, describedBy }) => (
                  <AccountSelect
                    id={id}
                    describedBy={describedBy}
                    accounts={accounts}
                    loading={accountsPending}
                    value={form.watch("sourceAccountId") as string}
                    onChange={(v) => form.setValue("sourceAccountId", v, { shouldValidate: true })}
                  />
                )}
              </Field>
              <Field label="To" error={err(form, "destinationAccountId")}>
                {({ id, describedBy }) => (
                  <AccountSelect
                    id={id}
                    describedBy={describedBy}
                    accounts={accounts}
                    loading={accountsPending}
                    value={form.watch("destinationAccountId") as string}
                    onChange={(v) => form.setValue("destinationAccountId", v, { shouldValidate: true })}
                    exclude={form.watch("sourceAccountId") as string}
                  />
                )}
              </Field>
            </div>
          ) : null}

          {mode === "EXPENSE" ? (
            <>
              <Field label="Expense head" error={err(form, "categoryId")}>
                {({ id, describedBy }) => (
                  <SelectField
                    id={id}
                    describedBy={describedBy}
                    value={form.watch("categoryId") as string}
                    onChange={(v) => form.setValue("categoryId", v, { shouldValidate: true })}
                    placeholder="Choose a head"
                    options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
                  />
                )}
              </Field>

              <Field
                label="Paid from"
                hint="Leave empty to book this as a payable against the vendor."
                error={err(form, "accountId")}
              >
                {({ id, describedBy }) => (
                  <AccountSelect
                    id={id}
                    describedBy={describedBy}
                    accounts={accounts}
                    loading={accountsPending}
                    value={form.watch("accountId") as string}
                    onChange={(v) => form.setValue("accountId", v, { shouldValidate: true })}
                  />
                )}
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Vendor (optional)" error={err(form, "partyId")}>
                  {({ id, describedBy }) => (
                    <SelectField
                      id={id}
                      describedBy={describedBy}
                      value={form.watch("partyId") as string}
                      onChange={(v) => form.setValue("partyId", v)}
                      placeholder="Choose a vendor"
                      options={(parties.data?.items ?? []).map((p) => ({
                        value: p.id,
                        label: `${p.name} (${p.code})`,
                      }))}
                    />
                  )}
                </Field>
                <Field label="Invoice no" error={err(form, "invoiceNo")}>
                  <Input placeholder="INV-4471" {...form.register("invoiceNo")} />
                </Field>
              </div>

              <ExpenseItems form={form} />
            </>
          ) : null}

          {mode === "INCOME" ? (
            <>
              <Field label="Income head" error={err(form, "headId")}>
                {({ id, describedBy }) => (
                  <SelectField
                    id={id}
                    describedBy={describedBy}
                    value={form.watch("headId") as string}
                    onChange={(v) => form.setValue("headId", v, { shouldValidate: true })}
                    placeholder="Choose a head"
                    options={(incomeHeads.data ?? []).map((h) => ({ value: h.id, label: h.name }))}
                  />
                )}
              </Field>

              <Field label="Received into" error={err(form, "accountId")}>
                {({ id, describedBy }) => (
                  <AccountSelect
                    id={id}
                    describedBy={describedBy}
                    accounts={accounts}
                    loading={accountsPending}
                    value={form.watch("accountId") as string}
                    onChange={(v) => form.setValue("accountId", v, { shouldValidate: true })}
                  />
                )}
              </Field>

              <Field
                label="Party (optional)"
                hint="Who it came from, for the record. Their balance is NOT affected — income is earned, not collected."
                error={err(form, "partyId")}
              >
                {({ id, describedBy }) => (
                  <SelectField
                    id={id}
                    describedBy={describedBy}
                    value={form.watch("partyId") as string}
                    onChange={(v) => form.setValue("partyId", v)}
                    placeholder="No party"
                    options={(parties.data?.items ?? []).map((p) => ({
                      value: p.id,
                      label: `${p.name} (${p.code})`,
                    }))}
                  />
                )}
              </Field>
            </>
          ) : null}

          {mode !== "BANK_TRANSFER" ? (
            <Field label="Payment mode" error={err(form, "paymentMode")}>
              {({ id, describedBy }) => (
                <SelectField
                  id={id}
                  describedBy={describedBy}
                  value={form.watch("paymentMode") as string}
                  onChange={(v) => form.setValue("paymentMode", v, { shouldValidate: true })}
                  placeholder="Choose a mode"
                  options={Object.entries(PAYMENT_MODE_LABEL).map(([value, label]) => ({ value, label }))}
                />
              )}
            </Field>
          ) : null}

          {mode !== "EXPENSE" && applicableRules.length > 0 ? (
            <Field label="Charge / commission (optional)" error={err(form, "chargeRuleId")}>
              {({ id, describedBy }) => (
                <SelectField
                  id={id}
                  describedBy={describedBy}
                  value={chargeRuleId ?? ""}
                  onChange={(v) => form.setValue("chargeRuleId", v === "none" ? undefined : v)}
                  placeholder="No charge"
                  options={[
                    { value: "none", label: "No charge" },
                    ...applicableRules.map((r) => ({ value: r.id, label: r.name })),
                  ]}
                />
              )}
            </Field>
          ) : null}

          {/* §18: gross, charge and net — all three, before anything is committed. */}
          {preview.data ? (
            <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-surface-muted/50 p-3">
              <Figure label="Gross" value={preview.data.gross} />
              <Figure label="Charge" value={preview.data.charge} />
              <Figure label="Net" value={preview.data.net} emphasis />
              <p className="col-span-3 text-2xs text-muted-foreground">
                {preview.data.basis}
                {preview.data.bearer === "PARTY" ? " — borne by the party" : " — borne by us"}
              </p>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reference no" error={err(form, "referenceNo")}>
              <Input placeholder="NEFT2026081901" {...form.register("referenceNo")} />
            </Field>
            <Field label="Narration" error={err(form, "narration")}>
              <Input placeholder="Optional description" {...form.register("narration")} />
            </Field>
          </div>

          <Field label="Notes" error={err(form, "notes")}>
            <Textarea rows={2} placeholder="Anything worth recording alongside this entry" {...form.register("notes")} />
          </Field>

          {confirming ? (
            <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2.5 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  You are about to post{" "}
                  <span className="tabular">{formatINR(parsedAmount)}</span>.
                </p>
                <p className="text-muted-foreground">
                  Once posted this cannot be edited — only reversed, which leaves both entries
                  on the record. Press {config.action} again to confirm.
                </p>
              </div>
            </div>
          ) : null}

          <Separator />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={confirming ? "destructive" : "accent"}
              loading={mutation.isPending}
            >
              {confirming ? `Confirm — ${config.action}` : config.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Itemised expense lines (§16) ────────────────────────────────────────── */

function ExpenseItems({ form }: { form: UseFormReturn<Record<string, unknown>> }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "items" as never });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Items (optional)</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => append({ description: "", quantity: 1, unitPrice: "", amount: "" } as never)}
        >
          <Plus />
          Add item
        </Button>
      </div>

      {fields.length > 0 ? (
        <>
          <div className="space-y-2">
            {fields.map((field, i) => (
              <div key={field.id} className="grid grid-cols-[1fr_4rem_6rem_6rem_2rem] items-center gap-2">
                <Input placeholder="Description" {...form.register(`items.${i}.description` as never)} />
                <Input type="number" step="any" placeholder="Qty" className="tabular" {...form.register(`items.${i}.quantity` as never)} />
                <Input placeholder="Rate" className="tabular" {...form.register(`items.${i}.unitPrice` as never)} />
                <Input placeholder="Amount" className="tabular" {...form.register(`items.${i}.amount` as never)} />
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => remove(i)} aria-label="Remove item">
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          <p className="text-2xs text-muted-foreground">
            The items must total the expense amount exactly — the server rejects a mismatch
            rather than silently trusting one of the two figures.
          </p>
        </>
      ) : null}
    </div>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────────── */

/**
 * A labelled field.
 *
 * The label is bound to its control by a generated id, and the id is handed down through a
 * render prop rather than assumed. An unbound `<Label>` looks correct on screen and is
 * invisible to a screen reader — the label announces nothing and the input announces
 * "edit text, blank", which on the form that moves every rupee is not a cosmetic problem.
 *
 * `children` may be a node (bound via the wrapping `<label>`) or a function receiving the
 * id, for controls like Radix Select that need it on a specific element.
 */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode | ((ids: { id: string; describedBy?: string }) => React.ReactNode);
}) {
  const id = React.useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {typeof children === "function" ? children({ id, describedBy }) : children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-2xs text-muted-foreground">{hint}</p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

function SelectField({
  value,
  onChange,
  placeholder,
  options,
  id,
  describedBy,
}: {
  value?: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  /** Supplied by `Field` so the trigger carries the label's association. */
  id?: string;
  describedBy?: string;
}) {
  return (
    <Select value={value ?? ""} onValueChange={onChange}>
      <SelectTrigger id={id} aria-describedby={describedBy}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="flex w-full items-center gap-2">
              <span className="truncate">{o.label}</span>
              {o.hint ? <span className="ml-auto tabular text-2xs text-muted-foreground">{o.hint}</span> : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AccountSelect({
  accounts,
  loading,
  value,
  onChange,
  exclude,
  id,
  describedBy,
}: {
  accounts: Array<{ id: string; label: string; balance: number }>;
  loading: boolean;
  value?: string;
  onChange: (v: string) => void;
  exclude?: string;
  /** Threaded from `Field`, so "Received into" actually names this control. */
  id?: string;
  describedBy?: string;
}) {
  return (
    <SelectField
      id={id}
      describedBy={describedBy}
      value={value}
      onChange={onChange}
      placeholder={loading ? "Loading…" : "Choose an account"}
      // The current balance sits beside each option, so an operator sees whether the
      // payment is affordable before submitting rather than after being refused.
      options={accounts
        .filter((a) => a.id !== exclude)
        .map((a) => ({ value: a.id, label: a.label, hint: formatINR(a.balance) }))}
    />
  );
}

function Figure({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className="space-y-0.5">
      <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <Money value={value} showIcon={false} size={emphasis ? "lg" : "md"} />
    </div>
  );
}

function err(form: UseFormReturn<Record<string, unknown>>, name: string): string | undefined {
  const error = form.formState.errors[name];
  return typeof error?.message === "string" ? error.message : undefined;
}

/** Trigger button plus its dialog, for pages that just want a "New …" action. */
export function NewTransactionButton({
  mode,
  label,
  variant = "accent",
}: {
  mode: TransactionMode;
  label: string;
  variant?: "accent" | "outline";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <Plus />
        {label}
      </Button>
      <TransactionFormDialog mode={mode} open={open} onOpenChange={setOpen} />
    </>
  );
}
