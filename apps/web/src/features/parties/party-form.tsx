import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Info, Plus, TriangleAlert } from "lucide-react";
import {
  createPartySchema,
  formatINR,
  parseAmount,
  type BranchSummary,
  type CreatePartyInput,
  type PartySummary,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { AmountField, NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Create a party (§8).
 *
 * The opening balance is the part that matters. It is not a number written into a field —
 * submitting this form posts a real OPENING_BALANCE transaction against equity, which is
 * why the party appears in the trial balance the moment it is created and why the books
 * still tie afterwards.
 *
 * It is also SIGNED, in the Khata's own convention, and getting that backwards is the
 * easiest mistake on this screen: positive means they owe us. So the form asks the
 * question in words — "they owe us" / "we owe them" — and shows the resulting Lena/Dena
 * reading back before submission, rather than expecting an operator to type a minus sign
 * and hope.
 */
export function NewPartyButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus />
        New party
      </Button>
      <PartyDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

type Direction = "OWES_US" | "WE_OWE";

function PartyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [direction, setDirection] = React.useState<Direction>("OWES_US");
  const [formError, setFormError] = React.useState<string | null>(null);

  const branches = useQuery({
    queryKey: ["branches", "for-party-form"],
    queryFn: () => api.list<BranchSummary>(`/branches${qs({ limit: 100, status: "ACTIVE" })}`),
    enabled: open,
  });

  const form = useForm<CreatePartyInput>({
    resolver: zodResolver(createPartySchema),
    defaultValues: {
      name: "", code: "", type: "CUSTOMER",
      branchId: user?.activeBranchId ?? "",
      mobile: "", email: "", address: "", city: "", state: "", pincode: "",
      gstin: "", pan: "",
      openingBalance: 0, creditLimit: 0, creditDays: 0,
      status: "ACTIVE", notes: "",
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreatePartyInput) => api.post<PartySummary>("/parties", values),
    onSuccess: async (party) => {
      toast.success(`${party.name} added`, {
        description:
          party.balance === 0
            ? "A ledger account has been opened for them."
            : `Opening balance of ${formatINR(Math.abs(party.balance))} posted — it is on the trial balance now.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["parties"] });
      await queryClient.invalidateQueries({ queryKey: ["khata"] });
      form.reset();
      setDirection("OWES_US");
      onOpenChange(false);
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      if (error instanceof ApiError) toast.error(error.message);
      else toast.error("Could not create the party.");
    },
  });

  /**
   * Apply the direction to the magnitude at the last moment.
   *
   * The field holds an unsigned amount — asking an operator to type "-125101" for a
   * supplier they owe money to is how opening balances end up inverted, and an inverted
   * opening balance still ties in the trial balance, so nothing catches it later.
   */
  const submit = (values: CreatePartyInput) => {
    setFormError(null);
    const magnitude = Math.abs(values.openingBalance);
    mutation.mutate({
      ...values,
      openingBalance: direction === "WE_OWE" ? -magnitude : magnitude,
    });
  };

  const openingText = form.watch("openingBalance") as unknown as string | number;
  const openingPaise = React.useMemo(() => {
    try {
      return Math.abs(parseAmount(String(openingText ?? 0)));
    } catch {
      return 0;
    }
  }, [openingText]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New party</DialogTitle>
          <DialogDescription>
            A ledger account is opened for them immediately. Any opening balance is posted as
            a real transaction against equity, not stored as a field.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
          <Tabs defaultValue="identity">
            <TabsList>
              <TabsTrigger value="identity">Identity</TabsTrigger>
              <TabsTrigger value="contact">Contact</TabsTrigger>
              <TabsTrigger value="terms">Opening & credit</TabsTrigger>
            </TabsList>

            <TabsContent value="identity" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  form={form}
                  name="name"
                  label="Party name"
                  required
                  placeholder="Sharma Traders"
                />
                <TextField
                  form={form}
                  name="code"
                  label="Code"
                  hint="Left blank, one is generated as PTY-000123."
                  placeholder="Optional"
                  className="font-mono"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  form={form}
                  name="type"
                  label="Type"
                  required
                  options={[
                    { value: "CUSTOMER", label: "Customer", detail: "Usually owes us" },
                    { value: "VENDOR", label: "Vendor", detail: "Usually we owe them" },
                    { value: "DISTRIBUTOR", label: "Distributor" },
                    { value: "AGENT", label: "Agent" },
                    { value: "EMPLOYEE", label: "Employee" },
                    { value: "OTHER", label: "Other" },
                  ]}
                />
                <SelectField
                  form={form}
                  name="branchId"
                  label="Branch"
                  required
                  placeholder={branches.isPending ? "Loading…" : "Choose a branch"}
                  hint="Permanent. A party cannot be moved later without breaking that branch's trial balance."
                  options={(branches.data?.items ?? []).map((b) => ({
                    value: b.id,
                    label: `${b.code} — ${b.name}`,
                    detail: b.city,
                  }))}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <TextField form={form} name="gstin" label="GSTIN" placeholder="10ABCDE1234F1Z5" className="uppercase" />
                <TextField form={form} name="pan" label="PAN" placeholder="ABCDE1234F" className="uppercase" />
              </div>
            </TabsContent>

            <TabsContent value="contact" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField form={form} name="mobile" label="Mobile" inputMode="numeric" placeholder="9812345670" />
                <TextField form={form} name="email" label="Email" type="email" />
              </div>
              <TextField form={form} name="address" label="Address" />
              <div className="grid gap-4 sm:grid-cols-3">
                <TextField form={form} name="city" label="City" placeholder="Patna" />
                <TextField form={form} name="state" label="State" placeholder="Bihar" />
                <TextField form={form} name="pincode" label="PIN code" inputMode="numeric" maxLength={6} />
              </div>
            </TabsContent>

            <TabsContent value="terms" className="space-y-4">
              <div className="space-y-3 rounded-md border border-border bg-surface-muted/40 p-3">
                <p className="text-xs font-medium">Opening balance</p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <AmountField
                    form={form}
                    name="openingBalance"
                    label="Amount"
                    hint="Leave at 0 for a new party with no history."
                  />

                  {/* The sign, asked as a question. Typing a minus is where this goes
                      wrong, and an inverted opening balance still ties — so nothing
                      downstream would ever catch it. */}
                  <div className="space-y-1.5">
                    <span className="text-sm font-medium">Which way?</span>
                    <div className="grid grid-cols-2 gap-2">
                      <DirectionButton
                        active={direction === "OWES_US"}
                        onClick={() => setDirection("OWES_US")}
                        title="They owe us"
                        subtitle="Lena hai"
                      />
                      <DirectionButton
                        active={direction === "WE_OWE"}
                        onClick={() => setDirection("WE_OWE")}
                        title="We owe them"
                        subtitle="Dena hai"
                      />
                    </div>
                  </div>
                </div>

                {openingPaise > 0 ? (
                  <p className="flex items-start gap-2 text-xs">
                    <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span>
                      This will post{" "}
                      <span className="font-medium text-foreground">{formatINR(openingPaise)}</span>{" "}
                      as{" "}
                      <span className="font-medium text-foreground">
                        {direction === "OWES_US" ? "LENA HAI — they owe us" : "DENA HAI — we owe them"}
                      </span>
                      , against equity, dated today.
                    </span>
                  </p>
                ) : null}
              </div>

              <Separator />

              <div className="grid gap-4 sm:grid-cols-2">
                <AmountField
                  form={form}
                  name="creditLimit"
                  label="Credit limit"
                  hint="0 means no limit. A payment that would push their balance past this is refused."
                />
                <TextField
                  form={form}
                  name="creditDays"
                  label="Credit days"
                  inputMode="numeric"
                  hint="Sets the due date, and therefore the aging bucket."
                  registerOptions={{ valueAsNumber: true }}
                />
              </div>

              <NotesField form={form} name="notes" label="Notes" />
            </TabsContent>
          </Tabs>

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
              Create party
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
