import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Info, Landmark, Lock, Plus, Wallet } from "lucide-react";
import {
  createBankAccountSchema,
  createCashAccountSchema,
  formatINR,
  parseAmount,
  type BankSummary,
  type CreateBankAccountInput,
  type CreateCashAccountInput,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { AmountField, NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { FormError } from "./bank-form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Open a bank account or a cash drawer (§7).
 *
 * Both post their opening balance as a real OPENING_BALANCE transaction against equity —
 * it is never stored as a mutable field, which is why the trial balance still ties the
 * moment an account is opened.
 *
 * The two differ in one way that matters and is stated on the form: a bank account may
 * have an overdraft facility and can legitimately go negative up to it; a cash drawer
 * cannot go below zero at all, because you cannot pay out money that is not in the drawer.
 */
export function NewAccountButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus />
        New account
      </Button>
      <AccountDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function AccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
          <DialogDescription>
            The opening balance is posted against equity as a real transaction, so the books
            tie from the moment the account exists.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="bank">
          <TabsList>
            <TabsTrigger value="bank">
              <Landmark className="mr-1.5 size-3.5" />
              Bank account
            </TabsTrigger>
            <TabsTrigger value="cash">
              <Wallet className="mr-1.5 size-3.5" />
              Cash drawer
            </TabsTrigger>
          </TabsList>

          <TabsContent value="bank">
            <BankAccountForm onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="cash">
            <CashAccountForm onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/* ── Bank account ────────────────────────────────────────────────────────── */

function BankAccountForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const banks = useQuery({
    queryKey: ["banks", "for-account-form"],
    queryFn: () => api.list<BankSummary>(`/banks${qs({ limit: 100 })}`),
  });

  const form = useForm<CreateBankAccountInput>({
    resolver: zodResolver(createBankAccountSchema),
    defaultValues: {
      bankId: "",
      accountName: "", accountNumber: "", ifsc: "", bankBranchName: "",
      accountType: "CURRENT",
      openingBalance: 0, overdraftLimit: 0, lowBalanceThreshold: 0,
      status: "ACTIVE", notes: "",
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreateBankAccountInput) => api.post<{ id: string; accountName: string }>("/bank-accounts", values),
    onSuccess: async (account) => {
      toast.success(`${account.accountName} opened`, {
        description: "Its opening balance is posted and on the trial balance.",
      });
      await queryClient.invalidateQueries({ queryKey: ["bank-accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
      form.reset();
      onDone();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not open the account.");
    },
  });

  const opening = useParsedAmount(form.watch("openingBalance") as never);
  const overdraft = useParsedAmount(form.watch("overdraftLimit") as never);

  return (
    <form
      onSubmit={form.handleSubmit((values) => {
        setFormError(null);
        mutation.mutate(values);
      })}
      className="space-y-4"
      noValidate
    >
      <SelectField
        form={form}
        name="bankId"
        label="Bank"
        required
        placeholder={banks.isPending ? "Loading…" : "Choose a bank"}
        options={(banks.data?.items ?? []).map((b) => ({
          value: b.id,
          label: b.name,
          detail: b.shortName,
        }))}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="accountName" label="Account name" required placeholder="HDFC Current" />
        <SelectField
          form={form}
          name="accountType"
          label="Account type"
          options={[
            { value: "CURRENT", label: "Current" },
            { value: "SAVINGS", label: "Savings" },
            { value: "OD", label: "Overdraft" },
            { value: "CC", label: "Cash credit" },
          ]}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          form={form}
          name="accountNumber"
          label="Account number"
          required
          className="font-mono"
          inputMode="numeric"
        />
        <TextField
          form={form}
          name="ifsc"
          label="IFSC"
          required
          placeholder="HDFC0001234"
          className="font-mono uppercase"
          maxLength={11}
        />
      </div>

      <TextField form={form} name="bankBranchName" label="Bank's branch" placeholder="Boring Road" />

      {/* §7: these identify the real-world account that entries are posted against, so the
          form says up front that they are permanent — before the operator types them. */}
      <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">
          The account number, IFSC, bank and branch cannot be changed later. They identify the
          account that months of entries were posted against — if they are wrong, the correct
          fix is to close this account and open the right one, leaving the trail intact.
        </span>
      </p>

      <Separator />

      <div className="grid gap-4 sm:grid-cols-3">
        <AmountField
          form={form}
          name="openingBalance"
          label="Opening balance"
          hint="Negative for an account that starts drawn down."
        />
        <AmountField
          form={form}
          name="overdraftLimit"
          label="Overdraft limit"
          hint="How far below zero this account may go. 0 means not at all."
        />
        <AmountField
          form={form}
          name="lowBalanceThreshold"
          label="Warn below"
          hint="Flagged on the dashboard."
        />
      </div>

      {opening !== 0 || overdraft !== 0 ? (
        <p className="flex items-start gap-2 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            {opening !== 0 ? (
              <>
                Posts <span className="font-medium text-foreground">{formatINR(opening)}</span> against
                equity.{" "}
              </>
            ) : null}
            {overdraft > 0 ? (
              <>
                Payments will be refused once the balance would fall below{" "}
                <span className="font-medium text-foreground">-{formatINR(overdraft)}</span>.
              </>
            ) : (
              <>With no overdraft limit, this account cannot be taken below zero.</>
            )}
          </span>
        </p>
      ) : null}

      <NotesField form={form} name="notes" label="Notes" />

      {formError ? <FormError message={formError} /> : null}

      <DialogFooter>
        <Button type="submit" variant="accent" loading={mutation.isPending}>
          Open account
        </Button>
      </DialogFooter>
    </form>
  );
}

/* ── Cash drawer ─────────────────────────────────────────────────────────── */

function CashAccountForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<CreateCashAccountInput>({
    resolver: zodResolver(createCashAccountSchema),
    defaultValues: {
      name: "", code: "", openingBalance: 0, status: "ACTIVE", notes: "",
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreateCashAccountInput) => api.post<{ id: string; name: string }>("/cash-accounts", values),
    onSuccess: async (account) => {
      toast.success(`${account.name} opened`, {
        description: "Its opening balance is posted and on the trial balance.",
      });
      await queryClient.invalidateQueries({ queryKey: ["cash-accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
      form.reset();
      onDone();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not open the drawer.");
    },
  });

  const opening = useParsedAmount(form.watch("openingBalance") as never);

  return (
    <form
      onSubmit={form.handleSubmit((values) => {
        setFormError(null);
        mutation.mutate(values);
      })}
      className="space-y-4"
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Drawer name" required placeholder="Main Counter" />
        <TextField
          form={form}
          name="code"
          label="Code"
          hint="Optional, for telling several drawers apart."
          className="font-mono uppercase"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <AmountField
          form={form}
          name="openingBalance"
          label="Opening cash"
          hint="What is physically in the drawer today."
        />
      </div>

      <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
        <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">
          {opening > 0 ? (
            <>
              <span className="font-medium text-foreground">{formatINR(opening)}</span> will be
              posted against equity.{" "}
            </>
          ) : null}
          A cash drawer can never go below zero — unlike a bank account, there is no overdraft.
          A payment that would overdraw it is refused at posting time.
        </span>
      </p>

      <NotesField form={form} name="notes" label="Notes" />

      {formError ? <FormError message={formError} /> : null}

      <DialogFooter>
        <Button type="submit" variant="accent" loading={mutation.isPending}>
          Open drawer
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Parse a typed amount for preview only — the server's parse is the one that counts. */
function useParsedAmount(raw: string | number | undefined): number {
  return React.useMemo(() => {
    try {
      return parseAmount(String(raw ?? 0));
    } catch {
      return 0;
    }
  }, [raw]);
}
