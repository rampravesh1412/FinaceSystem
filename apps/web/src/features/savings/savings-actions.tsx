import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, Info, PiggyBank, Plus, TriangleAlert } from "lucide-react";
import {
  PAYMENT_MODE_LABEL,
  createSavingsAccountSchema,
  formatINR,
  parseAmount,
  savingsTransactionSchema,
  type BankAccountSummary,
  type CashAccountSummary,
  type CreateSavingsAccountInput,
  type PartySummary,
  type SavingsAccountSummary,
  type SavingsTransactionInput,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Bachat Khata operations (§13).
 *
 * Two things the forms have to get right, both of which follow from savings being a
 * LIABILITY rather than an asset:
 *
 *   - A member's balance is money the business **owes them**. Every deposit increases what
 *     we owe; every withdrawal decreases it. The forms say so in those words, because
 *     "balance ₹12,780" on a savings screen otherwise reads like an asset.
 *   - It cannot be overdrawn. A member cannot withdraw more than they hold, and the form
 *     refuses locally as well — the server enforces it regardless, but an operator counting
 *     out cash should be told before they count it, not after.
 */

/* ── Open an account ─────────────────────────────────────────────────────── */

export function NewSavingsAccountButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus />
        Open account
      </Button>
      {open ? <OpenAccountDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function OpenAccountDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const parties = useQuery({
    queryKey: ["parties", "for-savings"],
    queryFn: () => api.list<PartySummary>(`/parties${qs({ limit: 200, status: "ACTIVE" })}`),
  });

  const form = useForm<CreateSavingsAccountInput>({
    resolver: zodResolver(createSavingsAccountSchema),
    defaultValues: {
      memberName: "",
      mobile: "",
      interestRateBps: 0,
      openingBalance: 0,
      notes: "",
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreateSavingsAccountInput) =>
      api.post<SavingsAccountSummary>("/savings", values),
    onSuccess: async (account) => {
      toast.success(`${account.accountNo} opened for ${account.memberName}`, {
        description:
          account.balance > 0
            ? `${formatINR(account.balance)} is now held on their behalf — it is a liability, not income.`
            : "They can start depositing straight away.",
      });
      await queryClient.invalidateQueries({ queryKey: ["savings"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not open the account.");
    },
  });

  const rateBps = form.watch("interestRateBps");

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open a Bachat Khata account</DialogTitle>
          <DialogDescription>
            Money held for a member is a liability — it appears on the balance sheet as
            something owed, never as income.
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
          <TextField form={form} name="memberName" label="Member name" required />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="mobile" label="Mobile" inputMode="numeric" maxLength={10} />
          </div>

          <SelectField
            form={form}
            name="partyId"
            label="Existing party (optional)"
            hint="Link this member to a party already on the books, if they are one."
            placeholder="Not linked"
            options={(parties.data?.items ?? []).map((p) => ({
              value: p.id,
              label: `${p.name} (${p.code})`,
            }))}
          />

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              form={form}
              name="openingBalance"
              label="Opening deposit"
              inputMode="decimal"
              className="tabular"
              hint="What they are handing over today. Cannot be negative."
            />
            <TextField
              form={form}
              name="interestRateBps"
              label="Interest rate (basis points)"
              inputMode="numeric"
              registerOptions={{ valueAsNumber: true }}
              hint={
                rateBps
                  ? `${(rateBps / 100).toFixed(2)}% a year`
                  : "650 = 6.50% a year. Integer basis points, never a float."
              }
            />
          </div>

          <NotesField form={form} name="notes" label="Notes" rows={2} />

          {formError ? <InlineError message={formError} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Open account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Deposit and withdraw ────────────────────────────────────────────────── */

export function SavingsTransactionButtons({ account }: { account: SavingsAccountSummary }) {
  const { can } = useAuth();
  const [operation, setOperation] = React.useState<"DEPOSIT" | "WITHDRAWAL" | null>(null);

  if (!can("finance.savings.transact")) return null;

  return (
    <>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => setOperation("DEPOSIT")}>
          <ArrowDownLeft />
          Deposit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOperation("WITHDRAWAL")}
          disabled={account.balance <= 0}
        >
          <ArrowUpRight />
          Withdraw
        </Button>
      </div>

      {operation ? (
        <TransactionDialog
          account={account}
          operation={operation}
          onClose={() => setOperation(null)}
        />
      ) : null}
    </>
  );
}

function TransactionDialog({
  account, operation, onClose,
}: {
  account: SavingsAccountSummary;
  operation: "DEPOSIT" | "WITHDRAWAL";
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const depositing = operation === "DEPOSIT";

  const bankAccounts = useQuery({
    queryKey: ["bank-accounts", "for-savings-txn"],
    queryFn: () => api.list<BankAccountSummary>(`/bank-accounts${qs({ limit: 100 })}`),
  });

  const cashAccounts = useQuery({
    queryKey: ["cash-accounts", "for-savings-txn"],
    queryFn: () => api.list<CashAccountSummary>(`/cash-accounts${qs({ limit: 100 })}`),
  });

  const form = useForm<SavingsTransactionInput>({
    resolver: zodResolver(savingsTransactionSchema),
    defaultValues: {
      date: new Date().toISOString().slice(0, 10),
      savingsAccountId: account.id,
      operation,
      amount: 0,
      paymentMode: "CASH",
      narration: "",
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: SavingsTransactionInput) =>
      api.post<{ txnNo: string }>("/savings/transactions", values),
    onSuccess: async (txn) => {
      toast.success(`${txn.txnNo} posted`, {
        description: depositing
          ? "Held on their behalf — the business now owes them more."
          : "Paid out — the business now owes them less.",
      });
      await queryClient.invalidateQueries({ queryKey: ["savings"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not post the transaction.");
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

  // Checked here as well as on the server, so an operator is told before they count out
  // the cash rather than after the request is refused.
  const overdrawn = !depositing && amount > account.balance;
  const after = depositing ? account.balance + amount : account.balance - amount;

  const accountOptions = [
    ...(cashAccounts.data?.items ?? []).map((a) => ({
      value: a.id,
      label: a.name,
      detail: formatINR(a.balance),
    })),
    ...(bankAccounts.data?.items ?? []).map((a) => ({
      value: a.id,
      label: `${a.bank.shortName ?? a.bank.name} — ${a.accountName}`,
      detail: formatINR(a.balance),
    })),
  ];

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {depositing ? "Deposit" : "Withdrawal"} — {account.memberName}
          </DialogTitle>
          <DialogDescription>
            {account.accountNo} · currently holding{" "}
            <span className="font-medium text-foreground">{formatINR(account.balance)}</span> on
            their behalf.
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
            <TextField form={form} name="date" label="Date" type="date" required />
            <TextField
              form={form}
              name="amount"
              label="Amount"
              required
              inputMode="decimal"
              className="tabular"
              placeholder="0.00"
            />
          </div>

          <SelectField
            form={form}
            name="accountId"
            label={depositing ? "Cash received into" : "Paid out from"}
            required
            placeholder="Choose a drawer or account"
            options={accountOptions}
          />

          <SelectField
            form={form}
            name="paymentMode"
            label="Payment mode"
            options={Object.entries(PAYMENT_MODE_LABEL).map(([value, label]) => ({ value, label }))}
          />

          <TextField form={form} name="referenceNo" label="Reference" />
          <NotesField form={form} name="narration" label="Narration" rows={2} />

          {amount > 0 ? (
            overdrawn ? (
              <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                <span>
                  {account.memberName} holds only{" "}
                  <span className="font-medium">{formatINR(account.balance)}</span>. A savings
                  account cannot be overdrawn — the business would be paying out money it is not
                  holding for them.
                </span>
              </p>
            ) : (
              <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
                <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  After this the business will hold{" "}
                  <span className="font-medium text-foreground">{formatINR(after)}</span> for them
                  — {depositing ? "an increase" : "a decrease"} in what it owes.
                </span>
              </p>
            )
          ) : null}

          {formError ? <InlineError message={formError} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="accent"
              loading={mutation.isPending}
              disabled={overdrawn || amount === 0}
            >
              {depositing ? "Record deposit" : "Record withdrawal"}
            </Button>
          </DialogFooter>
        </form>
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

export const SAVINGS_ICON = PiggyBank;
