import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Info, Scale, TriangleAlert } from "lucide-react";
import {
  ADJUSTMENT_TYPE,
  createAdjustmentSchema,
  formatINR,
  parseAmount,
  type BankAccountSummary,
  type CashAccountSummary,
  type CreateAdjustmentInput,
  type PartySummary,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Balance adjustment (§25, §62).
 *
 * This is the ONLY sanctioned way to change a balance that is wrong, and it is not a
 * balance edit — it posts a real, signed, double-entry transaction with a reason attached.
 * The original figure stays exactly where it was, and the correction sits beside it. That
 * is the difference between a correction and a cover-up, and it is why no screen anywhere
 * in this application offers a "set balance to" field.
 *
 * §62 also decides what the other side of the entry is. An unexplained difference goes to
 * **suspense** by default: the books stay in balance while the unexplained amount stays
 * conspicuous. Naming a real counter-account is for when you actually know where the money
 * went — a write-off to an expense head, say — and the form asks for that explicitly rather
 * than defaulting to something tidy.
 */
export function NewAdjustmentButton({ partyId }: { partyId?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Scale />
        Adjust balance
      </Button>
      {open ? <AdjustmentDialog partyId={partyId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The adjustment types, in the words an operator would use.
 *
 * The raw enum names (`WRITE_OFF`, `BALANCE_CORRECTION`) are storage identifiers. What the
 * person posting the entry needs to know is what each one means for the books, because the
 * type is what an auditor sees first.
 */
const ADJUSTMENT_TYPE_OPTIONS = [
  {
    value: ADJUSTMENT_TYPE.BALANCE_CORRECTION,
    label: "Balance correction",
    detail: "A figure was recorded wrongly",
  },
  { value: ADJUSTMENT_TYPE.WRITE_OFF, label: "Write-off", detail: "Accepted as a loss" },
  { value: ADJUSTMENT_TYPE.CASH, label: "Cash difference", detail: "The drawer did not tally" },
  { value: ADJUSTMENT_TYPE.BANK, label: "Bank difference", detail: "Found during reconciliation" },
  { value: ADJUSTMENT_TYPE.PARTY, label: "Party balance", detail: "Agreed with the party" },
  { value: ADJUSTMENT_TYPE.EXPENSE, label: "Expense correction", detail: "Booked to the wrong head" },
];

type Target = "PARTY" | "ACCOUNT";
type Direction = "INCREASE" | "DECREASE";

function AdjustmentDialog({ partyId, onClose }: { partyId?: string; onClose: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [target, setTarget] = React.useState<Target>(partyId ? "PARTY" : "PARTY");
  const [direction, setDirection] = React.useState<Direction>("INCREASE");
  const [formError, setFormError] = React.useState<string | null>(null);

  const bankAccounts = useQuery({
    queryKey: ["bank-accounts", "for-adjustment"],
    queryFn: () => api.list<BankAccountSummary>(`/bank-accounts${qs({ limit: 100 })}`),
  });

  const cashAccounts = useQuery({
    queryKey: ["cash-accounts", "for-adjustment"],
    queryFn: () => api.list<CashAccountSummary>(`/cash-accounts${qs({ limit: 100 })}`),
  });

  const form = useForm<CreateAdjustmentInput>({
    resolver: zodResolver(createAdjustmentSchema),
    defaultValues: {
      date: new Date().toISOString().slice(0, 10),
      branchId: user?.activeBranchId ?? "",
      adjustmentType: "BALANCE_CORRECTION",
      partyId: partyId ?? "",
      amount: 0,
      reason: "",
    } as never,
  });

  /**
   * Scoped to the chosen branch.
   *
   * A party belongs to one branch and the server refuses a cross-branch reference outright.
   * Offering every party in the dropdown means an operator picks one, fills the whole form,
   * and is told at submit that it "belongs to a different branch" — with no way to tell
   * which parties would have been acceptable.
   */
  const branchId = form.watch("branchId");
  const parties = useQuery({
    queryKey: ["parties", "for-adjustment", branchId],
    queryFn: () =>
      api.list<PartySummary>(`/parties${qs({ limit: 200, status: "ACTIVE", branchId })}`),
    enabled: Boolean(branchId),
  });

  const mutation = useMutation({
    mutationFn: (values: CreateAdjustmentInput) =>
      api.post<{ txnNo: string }>("/adjustments", values),
    onSuccess: async (txn) => {
      toast.success(`${txn.txnNo} posted`, {
        description: "The original balance is untouched — the correction sits beside it on the ledger.",
      });
      await queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not post the adjustment.");
    },
  });

  const amountText = form.watch("amount") as unknown as string | number;
  const magnitude = React.useMemo(() => {
    try {
      return Math.abs(parseAmount(String(amountText ?? 0)));
    } catch {
      return 0;
    }
  }, [amountText]);

  const selectedParty = parties.data?.items.find((p) => p.id === form.watch("partyId"));
  const counterAccountId = form.watch("counterAccountId");

  const accountOptions = [
    ...(bankAccounts.data?.items ?? []).map((a) => ({
      value: a.id,
      label: `${a.bank.shortName ?? a.bank.name} — ${a.accountName}`,
      detail: formatINR(a.balance),
    })),
    ...(cashAccounts.data?.items ?? []).map((a) => ({
      value: a.id,
      label: a.name,
      detail: formatINR(a.balance),
    })),
  ];

  const submit = (values: CreateAdjustmentInput) => {
    setFormError(null);
    const signed = direction === "DECREASE" ? -Math.abs(values.amount) : Math.abs(values.amount);
    mutation.mutate({
      ...values,
      amount: signed,
      // Exactly one target, per the schema's own refinement.
      partyId: target === "PARTY" ? values.partyId : undefined,
      accountId: target === "ACCOUNT" ? values.accountId : undefined,
    });
  };

  /**
   * `reason` is a REGISTERED field, not React state.
   *
   * The shared schema validates it, so holding it outside the form meant zod ran against
   * the empty default on every submit — and because nothing was registered under that
   * name, React Hook Form had nowhere to render the error. The button was enabled, the
   * click did nothing, and the form failed silently. Watched here only for the character
   * countdown.
   */
  const reason = (form.watch("reason") ?? "") as string;

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Adjust a balance</DialogTitle>
          <DialogDescription>
            This posts a correcting transaction. It does not edit the existing balance — the
            original figure stays on the record with the adjustment beside it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
          <Tabs
            value={target}
            /**
             * Switching target CLEARS the other one.
             *
             * The schema requires exactly one of `partyId` / `accountId`. Leaving both set —
             * pick a party, switch tab, pick an account — fails validation on `partyId`,
             * whose field is now on the hidden tab. The operator sees a form that refuses to
             * submit with no visible reason.
             */
            onValueChange={(v) => {
              const next = v as Target;
              setTarget(next);
              form.setValue(next === "PARTY" ? "accountId" : "partyId", undefined);
            }}
          >
            <TabsList>
              <TabsTrigger value="PARTY">A party</TabsTrigger>
              <TabsTrigger value="ACCOUNT">An account</TabsTrigger>
            </TabsList>

            <TabsContent value="PARTY" className="space-y-4">
              <SelectField
                form={form}
                name="partyId"
                label="Party"
                required
                placeholder={parties.isPending ? "Loading…" : "Choose a party"}
                options={(parties.data?.items ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.name} (${p.code})`,
                  detail: `${formatINR(Math.abs(p.balance))} ${p.direction}`,
                }))}
              />
            </TabsContent>

            <TabsContent value="ACCOUNT" className="space-y-4">
              <SelectField
                form={form}
                name="accountId"
                label="Account"
                required
                placeholder="Choose an account or drawer"
                options={accountOptions}
              />
            </TabsContent>
          </Tabs>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="date" label="Date" type="date" required />
            <SelectField
              form={form}
              name="adjustmentType"
              label="Type"
              required
              options={ADJUSTMENT_TYPE_OPTIONS}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              form={form}
              name="amount"
              label="Amount"
              required
              inputMode="decimal"
              className="tabular"
              placeholder="0.00"
            />

            {/* The sign, asked in words. An adjustment is signed and getting it backwards
                doubles the error instead of fixing it. */}
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Which way?</span>
              <div className="grid grid-cols-2 gap-2">
                <DirectionButton
                  active={direction === "INCREASE"}
                  onClick={() => setDirection("INCREASE")}
                  title="Increase"
                  subtitle={target === "PARTY" ? "They owe us more" : "The account holds more"}
                />
                <DirectionButton
                  active={direction === "DECREASE"}
                  onClick={() => setDirection("DECREASE")}
                  title="Decrease"
                  subtitle={target === "PARTY" ? "They owe us less" : "The account holds less"}
                />
              </div>
            </div>
          </div>

          {magnitude > 0 && target === "PARTY" && selectedParty ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
              <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                {selectedParty.name} is currently{" "}
                <span className="font-medium text-foreground">
                  {formatINR(Math.abs(selectedParty.balance))} {selectedParty.direction}
                </span>
                . After this they will be{" "}
                <span className="font-medium text-foreground">
                  {formatINR(
                    Math.abs(
                      selectedParty.balance + (direction === "DECREASE" ? -magnitude : magnitude),
                    ),
                  )}{" "}
                  {selectedParty.balance + (direction === "DECREASE" ? -magnitude : magnitude) >= 0
                    ? "LENA"
                    : "DENA"}
                </span>
                .
              </span>
            </p>
          ) : null}

          <Separator />

          <SelectField
            form={form}
            name="counterAccountId"
            label="Where does the other side go?"
            placeholder="Suspense (recommended for an unexplained difference)"
            hint="Leave this on suspense unless you know where the money actually went."
            options={accountOptions}
          />

          {!counterAccountId ? (
            <p className="flex items-start gap-2 rounded-md border border-info/40 bg-info/5 p-3 text-xs">
              <Info className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
              <span>
                The other side lands in <span className="font-medium">suspense</span>. That keeps
                the books in balance while leaving the unexplained amount visible on the balance
                sheet until somebody accounts for it — which is the point (§62).
              </span>
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="adjustment-reason">
              Reason<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Textarea
              id="adjustment-reason"
              rows={3}
              placeholder="e.g. Cheque 44821 was recorded twice on 14 August — this reverses the duplicate"
              aria-describedby="adjustment-reason-hint"
              {...form.register("reason")}
            />
            <p id="adjustment-reason-hint" className="text-xs text-muted-foreground">
              At least 10 characters. This is permanent, attributed to you, and is what an
              auditor reads when they ask why a balance moved.{" "}
              {reason.trim().length > 0 && reason.trim().length < 10
                ? `${10 - reason.trim().length} more to go.`
                : null}
            </p>
          </div>

          <NotesField form={form} name="notes" label="Notes" rows={2} />

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
            <Button
              type="submit"
              variant="accent"
              loading={mutation.isPending}
              disabled={reason.trim().length < 10 || magnitude === 0}
            >
              Post adjustment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DirectionButton({
  active, onClick, title, subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-md border px-2.5 py-2 text-left transition-colors " +
        (active
          ? "border-accent bg-accent/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-surface-muted")
      }
    >
      <span className="block text-xs font-medium">{title}</span>
      <span className="block text-2xs">{subtitle}</span>
    </button>
  );
}
