import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ArrowLeftRight, Info, TriangleAlert } from "lucide-react";
import {
  createPartyTransferSchema,
  formatINR,
  parseAmount,
  type CreatePartyTransferInput,
  type PartySummary,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { AmountField, NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useParties } from "@/features/transactions/use-reference-data";

/**
 * Party to party transfer.
 *
 * Moves an amount from one party's khata to another's — "A paid B on our behalf", or a
 * debt handed from one party to another. No bank or cash account moves. The FROM party's
 * balance falls as if they had paid us; the TO party's rises as if we had paid them.
 */
export function PartyTransferButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <ArrowLeftRight />
        Party to Party Transfer
      </Button>
      {open ? <PartyTransferDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}

/** "Lena hai ₹500" / "Dena hai ₹500" / "Clear" — the Khata's own reading of a balance. */
function readBalance(balance: number): string {
  if (balance > 0) return `Lena hai ${formatINR(balance)}`;
  if (balance < 0) return `Dena hai ${formatINR(-balance)}`;
  return "Clear";
}

function PartyTransferDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const parties = useParties();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<CreatePartyTransferInput>({
    resolver: zodResolver(createPartyTransferSchema),
    defaultValues: {
      date: new Date().toISOString().slice(0, 10),
      fromPartyId: "", toPartyId: "", amount: 0, notes: "", attachments: [],
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreatePartyTransferInput) => api.post<{ txnNo: string }>("/party-transfers", values),
    onSuccess: async (txn) => {
      toast.success(`${txn.txnNo} posted`, { description: "Both khatas have been updated." });
      await queryClient.invalidateQueries({ queryKey: ["parties"] });
      await queryClient.invalidateQueries({ queryKey: ["khata"] });
      await queryClient.invalidateQueries({ queryKey: ["transactions"] });
      onOpenChange(false);
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      if (error instanceof ApiError) toast.error(error.message);
      else toast.error("Could not post the transfer.");
    },
  });

  const items: PartySummary[] = parties.data?.items ?? [];
  const byId = new Map(items.map((p) => [p.id, p]));
  const options = items.map((p) => ({
    value: p.id,
    label: `${p.name} (${p.code})`,
    detail: readBalance(p.balance),
  }));

  const from = byId.get(form.watch("fromPartyId") as string);
  const to = byId.get(form.watch("toPartyId") as string);
  const amountText = form.watch("amount") as unknown as string | number;
  const amount = React.useMemo(() => {
    try {
      return Math.abs(parseAmount(String(amountText ?? 0)));
    } catch {
      return 0;
    }
  }, [amountText]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Party to Party Transfer</DialogTitle>
          <DialogDescription>
            Move an amount from one party's khata to another's. No bank or cash account is touched.
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
            <SelectField
              form={form}
              name="fromPartyId"
              label="From party"
              required
              placeholder={parties.isPending ? "Loading…" : "Choose a party"}
              options={options}
            />
            <SelectField
              form={form}
              name="toPartyId"
              label="To party"
              required
              placeholder={parties.isPending ? "Loading…" : "Choose a party"}
              options={options.filter((o) => o.value !== form.watch("fromPartyId"))}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <AmountField form={form} name="amount" label="Amount" required />
            <TextField form={form} name="date" label="Date" type="date" required />
          </div>

          <TextField form={form} name="referenceNo" label="Reference" placeholder="Optional" />

          {from && to && amount > 0 ? (
            <div className="space-y-1.5 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
              <p className="flex items-start gap-2">
                <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  Moves <span className="font-medium text-foreground">{formatINR(amount)}</span> from{" "}
                  <span className="font-medium text-foreground">{from.name}</span> to{" "}
                  <span className="font-medium text-foreground">{to.name}</span>.
                </span>
              </p>
              <p className="pl-5">
                {from.name}: {readBalance(from.balance)} →{" "}
                <span className="font-medium text-foreground">{readBalance(from.balance - amount)}</span>
              </p>
              <p className="pl-5">
                {to.name}: {readBalance(to.balance)} →{" "}
                <span className="font-medium text-foreground">{readBalance(to.balance + amount)}</span>
              </p>
            </div>
          ) : null}

          <NotesField form={form} name="notes" label="Notes" />

          {formError ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <span>{formError}</span>
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Transfer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
