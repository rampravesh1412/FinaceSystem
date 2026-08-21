import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Handshake, Info, Play, Plus, TriangleAlert } from "lucide-react";
import {
  PAYMENT_MODE_LABEL,
  createSettlementSchema,
  formatINR,
  parseAmount,
  type BankAccountSummary,
  type CashAccountSummary,
  type ChargeRuleSummary,
  type CreateSettlementInput,
  type PartySummary,
  type SettlementRow,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Settlements (§24).
 *
 * A settlement is an INTENT — an agreed amount — and the payments made against it are
 * separate postings. That separation is the whole design: it is what lets a ₹5,00,000
 * agreement be paid in three instalments and still show ₹1,20,000 outstanding, rather than
 * a status that flips from "pending" to "done" with nothing in between.
 *
 * So there are two actions here, not one. Creating a settlement moves no money at all.
 * Executing one posts a real payment against it, and only then does anything hit the
 * ledger.
 */

/* ── Create ──────────────────────────────────────────────────────────────── */

export function NewSettlementButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus />
        New settlement
      </Button>
      {open ? <CreateDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function useAccountOptions() {
  const bank = useQuery({
    queryKey: ["bank-accounts", "for-settlement"],
    queryFn: () => api.list<BankAccountSummary>(`/bank-accounts${qs({ limit: 100 })}`),
  });
  const cash = useQuery({
    queryKey: ["cash-accounts", "for-settlement"],
    queryFn: () => api.list<CashAccountSummary>(`/cash-accounts${qs({ limit: 100 })}`),
  });

  return [
    ...(bank.data?.items ?? []).map((a) => ({
      value: a.id,
      label: `${a.bank.shortName ?? a.bank.name} — ${a.accountName}`,
      detail: formatINR(a.balance),
    })),
    ...(cash.data?.items ?? []).map((a) => ({
      value: a.id,
      label: a.name,
      detail: formatINR(a.balance),
    })),
  ];
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [kind, setKind] = React.useState<"PARTY" | "BANK" | "BRANCH">("PARTY");
  const [formError, setFormError] = React.useState<string | null>(null);
  const accountOptions = useAccountOptions();

  const chargeRules = useQuery({
    queryKey: ["charge-rules"],
    queryFn: () => api.get<ChargeRuleSummary[]>("/charges"),
  });

  const form = useForm<CreateSettlementInput>({
    resolver: zodResolver(createSettlementSchema),
    defaultValues: {
      date: new Date().toISOString().slice(0, 10),
      branchId: user?.activeBranchId ?? "",
      kind: "PARTY",
      amount: 0,
      manualCharge: 0,
      narration: "",
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
    queryKey: ["parties", "for-settlement", branchId],
    queryFn: () =>
      api.list<PartySummary>(`/parties${qs({ limit: 200, status: "ACTIVE", branchId })}`),
    enabled: Boolean(branchId),
  });

  const mutation = useMutation({
    mutationFn: (values: CreateSettlementInput) =>
      api.post<SettlementRow>("/settlements", values),
    onSuccess: async (settlement) => {
      toast.success(`${settlement.settlementNo} created`, {
        description: "Nothing has moved yet — execute it to post the payment.",
      });
      await queryClient.invalidateQueries({ queryKey: ["settlements"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not create the settlement.");
    },
  });

  const amountText = form.watch("amount") as unknown as string | number;
  const amount = React.useMemo(() => {
    try {
      return Math.abs(parseAmount(String(amountText ?? 0)));
    } catch {
      return 0;
    }
  }, [amountText]);

  const setKindAndForm = (next: "PARTY" | "BANK" | "BRANCH") => {
    setKind(next);
    form.setValue("kind", next, { shouldValidate: true });
  };

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New settlement</DialogTitle>
          <DialogDescription>
            This records what was agreed. No money moves until it is executed.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit((values) => {
            setFormError(null);
            mutation.mutate({ ...values, kind });
          })}
          className="space-y-4"
          noValidate
        >
          <Tabs value={kind} onValueChange={(v) => setKindAndForm(v as typeof kind)}>
            <TabsList>
              <TabsTrigger value="PARTY">With a party</TabsTrigger>
              <TabsTrigger value="BANK">Between accounts</TabsTrigger>
              <TabsTrigger value="BRANCH">Between branches</TabsTrigger>
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

            <TabsContent value="BANK" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField form={form} name="sourceAccountId" label="From" required options={accountOptions} />
                <SelectField form={form} name="destinationAccountId" label="To" required options={accountOptions} />
              </div>
            </TabsContent>

            <TabsContent value="BRANCH" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField form={form} name="sourceAccountId" label="From" required options={accountOptions} />
                <SelectField form={form} name="destinationAccountId" label="To" required options={accountOptions} />
              </div>
            </TabsContent>
          </Tabs>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="date" label="Date" type="date" required />
            <TextField
              form={form}
              name="amount"
              label="Agreed amount"
              required
              inputMode="decimal"
              className="tabular"
            />
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              form={form}
              name="chargeRuleId"
              label="Charge rule"
              placeholder="No charge"
              hint="Applied to the agreed amount when the settlement is created."
              options={(chargeRules.data ?? [])
                .filter((r) => r.status === "ACTIVE")
                .map((r) => ({ value: r.id, label: r.name, detail: formatINR(r.sampleOn100k) + " on ₹1,00,000" }))}
            />
            <TextField
              form={form}
              name="manualCharge"
              label="Manual charge"
              inputMode="decimal"
              className="tabular"
              hint="A one-off charge, when no rule fits."
            />
          </div>

          <TextField form={form} name="referenceNo" label="Reference" />
          <NotesField form={form} name="narration" label="Narration" rows={2} />

          {amount > 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-info/40 bg-info/5 p-3 text-xs">
              <Info className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
              <span>
                Creating this records an agreement of{" "}
                <span className="font-medium">{formatINR(amount)}</span> and posts nothing. Execute
                it — in whole or in part — to move the money.
              </span>
            </p>
          ) : null}

          {formError ? <InlineError message={formError} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Create settlement
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Execute ─────────────────────────────────────────────────────────────── */

export function ExecuteSettlementButton({ settlement }: { settlement: SettlementRow }) {
  const { can } = useAuth();
  const [open, setOpen] = React.useState(false);

  const remaining = settlement.netAmount - settlement.settledAmount;
  const done = settlement.status === "COMPLETED" || settlement.status === "CANCELLED";

  if (!can("finance.settlement.create") || done || remaining <= 0) return null;

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Play />
        Pay
      </Button>
      {open ? <ExecuteDialog settlement={settlement} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ExecuteDialog({
  settlement, onClose,
}: {
  settlement: SettlementRow;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const accountOptions = useAccountOptions();
  const remaining = settlement.netAmount - settlement.settledAmount;

  const [amountText, setAmountText] = React.useState(() => (remaining / 100).toString());
  const [accountId, setAccountId] = React.useState("");
  const [paymentMode, setPaymentMode] = React.useState("BANK_TRANSFER");
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [referenceNo, setReferenceNo] = React.useState("");

  const amount = React.useMemo(() => {
    try {
      return Math.abs(parseAmount(amountText));
    } catch {
      return 0;
    }
  }, [amountText]);

  const mutation = useMutation({
    mutationFn: () =>
      api.post<SettlementRow>(`/settlements/${settlement.id}/execute`, {
        amount: amountText,
        accountId,
        paymentMode,
        date,
        referenceNo: referenceNo || undefined,
      }),
    onSuccess: async (result) => {
      const stillOwed = result.netAmount - result.settledAmount;
      toast.success(`${settlement.settlementNo} — ${formatINR(amount)} paid`, {
        description:
          stillOwed > 0
            ? `${formatINR(stillOwed)} still outstanding on this settlement.`
            : "Settled in full.",
      });
      await queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not execute the settlement.");
    },
  });

  const overpaying = amount > remaining;

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pay against {settlement.settlementNo}</DialogTitle>
          <DialogDescription>
            {formatINR(settlement.netAmount)} agreed, {formatINR(settlement.settledAmount)} paid so
            far — <span className="font-medium text-foreground">{formatINR(remaining)}</span>{" "}
            outstanding.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="exec-date">Date</Label>
              <Input id="exec-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exec-amount">Amount</Label>
              <Input
                id="exec-amount"
                inputMode="decimal"
                className="tabular"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
              />
              {/* Partial payment is the normal case, not an edge case — the whole reason a
                  settlement tracks `settledAmount` separately from `netAmount`. */}
              <p className="text-xs text-muted-foreground">
                Pay less than the outstanding amount to record a part payment.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="exec-account">Paid from</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="exec-account">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {accountOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    <span className="flex flex-col items-start">
                      <span>{o.label}</span>
                      <span className="text-2xs text-muted-foreground">{o.detail}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="exec-mode">Payment mode</Label>
              <Select value={paymentMode} onValueChange={setPaymentMode}>
                <SelectTrigger id="exec-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PAYMENT_MODE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exec-ref">Reference</Label>
              <Input id="exec-ref" value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
            </div>
          </div>

          {overpaying ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                That is more than the {formatINR(remaining)} outstanding. The server will refuse
                it — a settlement cannot be overpaid, because the excess would belong to nothing.
              </span>
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="accent"
            loading={mutation.isPending}
            disabled={!accountId || amount === 0 || overpaying}
            onClick={() => mutation.mutate()}
          >
            Pay {amount > 0 ? formatINR(amount) : ""}
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

export const SETTLEMENT_ICON = Handshake;
