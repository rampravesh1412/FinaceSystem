import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Info, Plus, Trash2, TriangleAlert } from "lucide-react";
import {
  TRANSACTION_TYPE_LABEL,
  createChargeRuleSchema,
  formatINR,
  type ChargeRuleSummary,
  type CreateChargeRuleInput,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Create a charge rule (§18).
 *
 * Rates are integer BASIS POINTS, never a float percent — 1.75% is 175, exactly. The form
 * therefore takes a percent for readability and converts it once, on submit, by a integer
 * multiply. A commission that drifts by a paisa per transaction is a reconciliation
 * nightmare at month end, and floats drift.
 *
 * Tiered rules are where this gets fiddly and where the form earns its keep: the bands must
 * ascend and the last must be open-ended, or an amount above the highest ceiling matches no
 * band and is charged nothing. The form enforces the open end structurally — the last band's
 * ceiling is not editable — so the invalid shape cannot be built in the first place.
 */
export function NewChargeRuleButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus />
        New rule
      </Button>
      {open ? <ChargeRuleDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

interface TierDraft {
  upTo: string | null;
  ratePercent: string;
}

function ChargeRuleDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [ratePercent, setRatePercent] = React.useState("1.75");
  const [tiers, setTiers] = React.useState<TierDraft[]>([
    { upTo: "1,00,000", ratePercent: "1.75" },
    { upTo: null, ratePercent: "1.5" },
  ]);

  const form = useForm<CreateChargeRuleInput>({
    resolver: zodResolver(createChargeRuleSchema),
    defaultValues: {
      name: "", code: "", description: "",
      type: "PERCENTAGE",
      minCharge: 0, maxCharge: 0,
      bearer: "SELF",
      deductFromAmount: true,
      appliesTo: [], partyTypes: [],
      status: "ACTIVE",
    } as never,
  });

  const type = form.watch("type");
  const bearer = form.watch("bearer");
  // `SelectField` yields strings, so the boolean arrives as "true"/"false".
  const deductFromAmount = String(form.watch("deductFromAmount")) !== "false";

  /**
   * The heads this rule may post to.
   *
   * Expense heads for a cost, income heads for a commission — the server refuses the wrong
   * side outright, so offering both here would only produce a rejection the operator
   * cannot interpret.
   */
  const heads = useQuery({
    queryKey: ["charge-heads", bearer],
    queryFn: () =>
      api.get<Array<{ id: string; name: string; code: string }>>(
        bearer === "SELF" ? "/expenses/categories" : "/income/heads",
      ),
  });

  /** The charge on ₹1,00,000, for the worked example below the arrangement. */
  const sample = React.useMemo(() => {
    if (type !== "PERCENTAGE") return 0;
    const pct = Number(ratePercent.replace(/[^\d.]/g, ""));
    return Number.isFinite(pct) ? Math.round((100_000_00 * pct) / 100) : 0;
  }, [type, ratePercent]);

  const mutation = useMutation({
    mutationFn: (values: CreateChargeRuleInput) =>
      api.post<ChargeRuleSummary>("/charges", values),
    onSuccess: async (rule) => {
      toast.success(`${rule.name} added`, {
        description: `On ₹1,00,000 it charges ${formatINR(rule.sampleOn100k)}.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["charge-rules"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not create the rule.");
    },
  });

  /**
   * Percent → basis points, by integer arithmetic.
   *
   * `Math.round(Number(percent) * 100)` is the only float in the path and it is rounded
   * immediately; everything downstream — storage, calculation, display — is the integer.
   */
  const toBps = (percent: string): number => {
    const n = Number(String(percent).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };

  /**
   * Keep the form's own values equal to what will be submitted.
   *
   * The rate is typed as a percent and stored as basis points, and the tiers are edited as
   * drafts. Converting them inside the submit handler — after `handleSubmit` has already
   * validated — means zod checks an object that is not the one sent: it sees `rateBps:
   * undefined`, fails the "a percentage rule needs a rate" refinement, and has nowhere to
   * render the error because no field is registered under that path. The button is enabled,
   * the click does nothing, and the form fails in silence.
   *
   * So the conversion happens on change, into form state, and the submit handler sends
   * exactly what was validated.
   */
  React.useEffect(() => {
    if (type === "PERCENTAGE") {
      form.setValue("rateBps", toBps(ratePercent), { shouldValidate: false });
      form.setValue("tiers", undefined as never);
      form.setValue("fixedAmount", undefined as never);
    } else if (type === "FIXED") {
      form.setValue("rateBps", undefined as never);
      form.setValue("tiers", undefined as never);
    } else {
      form.setValue(
        "tiers",
        tiers.map((t, i) => ({
          // The last band is always open-ended, by construction rather than by hoping the
          // operator leaves it blank.
          upTo: i === tiers.length - 1 ? null : (t.upTo as never),
          rateBps: toBps(t.ratePercent),
        })) as never,
        { shouldValidate: false },
      );
      form.setValue("rateBps", undefined as never);
      form.setValue("fixedAmount", undefined as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, ratePercent, tiers]);

  const submit = (values: CreateChargeRuleInput) => {
    setFormError(null);
    mutation.mutate(values);
  };

  const addTier = () =>
    setTiers((prev) => {
      const next = [...prev];
      // The current last band gains a ceiling; the new one takes the open end.
      next[next.length - 1] = { ...next[next.length - 1]!, upTo: "5,00,000" };
      return [...next, { upTo: null, ratePercent: "1" }];
    });

  const removeTier = (index: number) =>
    setTiers((prev) => {
      if (prev.length <= 2) return prev;
      const next = prev.filter((_, i) => i !== index);
      next[next.length - 1] = { ...next[next.length - 1]!, upTo: null };
      return next;
    });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New charge rule</DialogTitle>
          <DialogDescription>
            A charge never rewrites a transaction's amount — gross, charge and net stay three
            separate figures on the record.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="name" label="Name" required placeholder="Distributor Commission" />
            <TextField form={form} name="code" label="Code" required className="font-mono uppercase" placeholder="DIST_COMM" />
          </div>

          <NotesField form={form} name="description" label="Description" rows={2} />

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              form={form}
              name="type"
              label="How is it calculated?"
              required
              options={[
                { value: "PERCENTAGE", label: "A percentage", detail: "1.75% of the amount" },
                { value: "FIXED", label: "A flat amount", detail: "₹50 per transaction" },
                { value: "TIERED", label: "Tiered bands", detail: "Different rates by size" },
              ]}
            />

            {/**
              * The single most consequential field on this form, and the one most easily
              * got wrong: on a ₹1,00,000 payment out at 1.5% the two options are ₹3,000
              * apart. The labels therefore quote the money rather than describing the
              * accounting — "our expense" and "our income" are true but do not tell an
              * operator which figure leaves the bank.
              */}
            {/**
              * Two fields, because there are THREE arrangements and one binary cannot
              * express them. Who the cost falls on decides expense vs income; whether it
              * comes out of the amount decides who is short of it. On a ₹1,00,000 payout
              * at 1.5% the extremes are ₹3,000 apart, so both are stated rather than
              * inferred, and the panel below spells out the resulting entries.
              */}
            <SelectField
              form={form}
              name="bearer"
              label="Whose cost is it?"
              required
              options={[
                {
                  value: "SELF",
                  label: "Ours — an expense",
                  detail: "A fee a bank or platform took from us",
                },
                {
                  value: "PARTY",
                  label: "Theirs — our income",
                  detail: "A commission we keep out of what we pay or receive",
                },
              ]}
            />
          </div>

          {/* Only meaningful for a cost. A commission we keep is deducted by definition —
              that is what keeping it means — so the choice would be a no-op. */}
          {bearer === "SELF" ? (
            <SelectField
              form={form}
              name="deductFromAmount"
              label="Is it taken out of the amount?"
              options={[
                {
                  value: "true",
                  label: "Yes — it comes out of the amount",
                  detail: "The full amount leaves the account and the party is credited less",
                },
                {
                  value: "false",
                  label: "No — it is charged on top",
                  detail: "The party gets the full amount and the fee leaves separately",
                },
              ]}
            />
          ) : null}

          <ArrangementPreview
            bearer={bearer}
            deductFromAmount={deductFromAmount}
            charge={sample}
          />

          <SelectField
            form={form}
            name="chargeAccountId"
            label={bearer === "SELF" ? "Post the charge to (expense head)" : "Post the charge to (income head)"}
            hint="Leave empty to use the built-in Bank Charges / Commission Income account."
            placeholder="Built-in account"
            options={[
              { value: "", label: "Built-in account" },
              ...(heads.data ?? []).map((h) => ({ value: h.id, label: h.name, detail: h.code })),
            ]}
          />

          {type === "PERCENTAGE" ? (
            <div className="space-y-1.5">
              <Label htmlFor="rate-percent">Rate</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="rate-percent"
                  inputMode="decimal"
                  value={ratePercent}
                  onChange={(e) => setRatePercent(e.target.value)}
                  className="tabular w-32"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Stored as <span className="tabular font-medium text-foreground">{toBps(ratePercent)}</span>{" "}
                basis points — an exact integer, never a float. On ₹1,00,000 that is{" "}
                <span className="font-medium text-foreground">
                  {formatINR(Math.round((100_000_00 * toBps(ratePercent)) / 10_000))}
                </span>
                .
              </p>
            </div>
          ) : null}

          {type === "FIXED" ? (
            <TextField
              form={form}
              name="fixedAmount"
              label="Amount per transaction"
              required
              inputMode="decimal"
              className="tabular"
            />
          ) : null}

          {type === "TIERED" ? (
            <div className="space-y-2">
              <Label>Bands</Label>
              {tiers.map((tier, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface-muted/30 p-3">
                  <div className="space-y-1">
                    <span className="text-2xs text-muted-foreground">Up to</span>
                    {tier.upTo === null ? (
                      <div className="flex h-9 w-36 items-center rounded-md border border-input bg-surface-muted px-3 text-sm text-muted-foreground">
                        and above
                      </div>
                    ) : (
                      <Input
                        inputMode="decimal"
                        className="tabular w-36"
                        value={tier.upTo}
                        onChange={(e) =>
                          setTiers((prev) => prev.map((t, j) => (j === i ? { ...t, upTo: e.target.value } : t)))
                        }
                      />
                    )}
                  </div>

                  <div className="space-y-1">
                    <span className="text-2xs text-muted-foreground">Rate %</span>
                    <Input
                      inputMode="decimal"
                      className="tabular w-24"
                      value={tier.ratePercent}
                      onChange={(e) =>
                        setTiers((prev) => prev.map((t, j) => (j === i ? { ...t, ratePercent: e.target.value } : t)))
                      }
                    />
                  </div>

                  <p className="flex-1 pb-2 text-xs text-muted-foreground">
                    {tier.upTo === null ? "Everything above the band before" : `Up to ${tier.upTo}`} —{" "}
                    <span className="tabular">{toBps(tier.ratePercent)} bps</span>
                  </p>

                  {tiers.length > 2 && tier.upTo !== null ? (
                    <Button variant="ghost" size="icon" onClick={() => removeTier(i)} aria-label={`Remove band ${i + 1}`}>
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              ))}

              <Button variant="outline" size="sm" onClick={addTier} type="button">
                <Plus />
                Add a band
              </Button>

              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                The highest band is always open-ended. If it had a ceiling, an amount above it
                would match no band and be charged nothing.
              </p>
            </div>
          ) : null}

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              form={form}
              name="minCharge"
              label="Minimum charge"
              inputMode="decimal"
              className="tabular"
              hint="0 for no floor."
            />
            <TextField
              form={form}
              name="maxCharge"
              label="Maximum charge"
              inputMode="decimal"
              className="tabular"
              hint="0 for no ceiling."
            />
          </div>

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
              Create rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export const CHARGE_TYPE_LABELS = TRANSACTION_TYPE_LABEL;


/**
 * The arrangement, in entries, on ₹1,00,000.
 *
 * Two dropdowns produce three quite different sets of ledger lines, and no combination of
 * labels makes that legible. Showing the actual debits and credits is the only version an
 * operator can check against what they meant — and it is the screen where the ₹3,000
 * difference between the extremes becomes obvious before anything is posted.
 */
function ArrangementPreview({
  bearer,
  deductFromAmount,
  charge,
}: {
  bearer: string;
  deductFromAmount: boolean;
  charge: number;
}) {
  if (charge <= 0) return null;

  const GROSS = 100_000_00;
  const income = bearer === "PARTY";
  const absorbed = !income && deductFromAmount;

  const account = income ? GROSS - charge : absorbed ? GROSS : GROSS + charge;
  const party = absorbed ? GROSS - charge : GROSS;

  const rows: Array<[string, string, number]> = [
    ["Party", "DR", party],
    ...(income
      ? ([["Commission (income)", "CR", charge]] as Array<[string, string, number]>)
      : ([["Charge head (expense)", "DR", charge]] as Array<[string, string, number]>)),
    ["Bank / cash", "CR", account],
  ];

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-muted/40 p-3">
      <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        On a ₹1,00,000 payment out
      </p>
      <table className="w-full text-2xs tabular">
        <tbody>
          {rows.map(([label, side, value]) => (
            <tr key={label}>
              <td className="py-0.5">{label}</td>
              <td className="py-0.5 pr-2 text-right text-muted-foreground">{side}</td>
              <td className="py-0.5 text-right font-medium">{formatINR(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border pt-2 text-2xs text-muted-foreground">
        {income ? (
          <>
            {formatINR(account)} leaves the account, their full {formatINR(GROSS)} claim is
            discharged, and the {formatINR(charge)} you keep is income.
          </>
        ) : absorbed ? (
          <>
            The whole {formatINR(GROSS)} leaves the account, only {formatINR(party)} reaches
            them, and the {formatINR(charge)} is your expense.
          </>
        ) : (
          <>
            {formatINR(account)} leaves the account, they receive the full {formatINR(GROSS)},
            and the {formatINR(charge)} is your expense.
          </>
        )}
      </p>
    </div>
  );
}
