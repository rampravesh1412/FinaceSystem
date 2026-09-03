import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Lock, MoreHorizontal, Pencil } from "lucide-react";
import {
  formatINR,
  updateBankAccountSchema,
  updateBankSchema,
  updateCashAccountSchema,
  type BankAccountSummary,
  type BankSummary,
  type CashAccountSummary,
  type UpdateBankAccountInput,
  type UpdateBankInput,
  type UpdateCashAccountInput,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { AmountField, NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { FormError } from "./bank-form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Editing banks, accounts and drawers (§7).
 *
 * The consistent rule across all three: anything that IDENTIFIES a real-world account is
 * immutable, and everything else is not. An account number, IFSC, bank and branch name the
 * account that months of reconciled entries were posted against — editing one would
 * silently re-point that history at a different account. The form shows them, locked, with
 * the reason, rather than omitting them and leaving an operator hunting.
 *
 * Renaming, on the other hand, has to reach the LEDGER account too, or the trial balance
 * keeps printing the old name forever.
 */

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "BLOCKED", label: "Blocked" },
];

function ActionsMenu({ label, onEdit }: { label: string; onEdit: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${label}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          Edit details
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Bank ────────────────────────────────────────────────────────────────── */

export function BankRowActions({ bank }: { bank: BankSummary }) {
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  if (!can("banks.edit")) return null;

  return (
    <>
      <ActionsMenu label={bank.name} onEdit={() => setEditing(true)} />
      {editing ? <EditBankDialog bank={bank} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

function EditBankDialog({ bank, onClose }: { bank: BankSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<UpdateBankInput>({
    resolver: zodResolver(updateBankSchema),
    defaultValues: {
      name: bank.name,
      shortName: bank.shortName ?? "",
      ifscPrefix: bank.ifscPrefix ?? "",
      status: bank.status as never,
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: UpdateBankInput) => api.patch<BankSummary>(`/banks/${bank.id}`, values),
    onSuccess: async () => {
      toast.success(`${bank.name} updated`, {
        description: "Any rename has been carried through to the ledger account names.",
      });
      await queryClient.invalidateQueries({ queryKey: ["banks"] });
      await queryClient.invalidateQueries({ queryKey: ["bank-accounts"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not update the bank.");
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {bank.name}</DialogTitle>
          <DialogDescription>
            {bank.accountCount === 0
              ? "No accounts are open under this bank yet."
              : `${bank.accountCount} account${bank.accountCount === 1 ? "" : "s"} sit under this bank. Retiring it does not close them — an account with posted history stays usable for reconciliation and reversal.`}
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
          <TextField form={form} name="name" label="Bank name" required />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="shortName" label="Short name" className="uppercase" />
            <TextField
              form={form}
              name="ifscPrefix"
              label="IFSC prefix"
              maxLength={4}
              className="font-mono uppercase"
            />
          </div>

          <SelectField form={form} name="status" label="Status" options={STATUS_OPTIONS} />
          <NotesField form={form} name="notes" label="Notes" />

          {formError ? <FormError message={formError} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Bank account ────────────────────────────────────────────────────────── */

export function BankAccountRowActions({ account }: { account: BankAccountSummary }) {
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  if (!can("bank_accounts.edit")) return null;

  return (
    <>
      <ActionsMenu label={account.accountName} onEdit={() => setEditing(true)} />
      {editing ? (
        <EditBankAccountDialog account={account} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

function EditBankAccountDialog({
  account, onClose,
}: {
  account: BankAccountSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<UpdateBankAccountInput>({
    resolver: zodResolver(updateBankAccountSchema),
    defaultValues: {
      accountName: account.accountName,
      bankBranchName: account.bankBranchName ?? "",
      accountType: account.accountType as never,
      overdraftLimit: account.overdraftLimit,
      lowBalanceThreshold: account.lowBalanceThreshold,
      status: account.status as never,
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: UpdateBankAccountInput) =>
      api.patch<BankAccountSummary>(`/bank-accounts/${account.id}`, values),
    onSuccess: async () => {
      toast.success(`${account.accountName} updated`);
      await queryClient.invalidateQueries({ queryKey: ["bank-accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not update the account.");
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {account.accountName}</DialogTitle>
          <DialogDescription>
            Balance is {formatINR(account.balance)} — it is derived from the ledger and cannot be
            typed in here.
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
          <TextField form={form} name="accountName" label="Account name" required />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="bankBranchName" label="Bank's branch" />
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
            <AmountField
              form={form}
              name="overdraftLimit"
              label="Overdraft limit"
              hint="Payments are refused once the balance would fall below the negative of this."
            />
            <AmountField form={form} name="lowBalanceThreshold" label="Warn below" />
          </div>

          <SelectField form={form} name="status" label="Status" options={STATUS_OPTIONS} />

          <Separator />

          {/* Shown locked rather than omitted: an operator who came here to fix a mistyped
              account number needs to be told what to do instead. */}
          <div className="space-y-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
            <p className="flex items-start gap-2">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">
                Permanent: account number{" "}
                <span className="font-mono font-medium text-foreground">{account.accountNumber}</span>
                {account.accountNumberMasked ? " (masked)" : null}, IFSC{" "}
                <span className="font-mono font-medium text-foreground">{account.ifsc}</span>, bank{" "}
                <span className="font-medium text-foreground">{account.bank.name}</span>.
              </span>
            </p>
            <p className="pl-5 text-muted-foreground">
              They identify the real account that this account's entries were posted against.
              If they are wrong, close this account and open the correct one — that leaves the
              history intact instead of silently re-pointing it.
            </p>
          </div>

          {formError ? <FormError message={formError} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Cash drawer ─────────────────────────────────────────────────────────── */

export function CashAccountRowActions({ account }: { account: CashAccountSummary }) {
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  if (!can("bank_accounts.edit")) return null;

  return (
    <>
      <ActionsMenu label={account.name} onEdit={() => setEditing(true)} />
      {editing ? (
        <EditCashAccountDialog account={account} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

function EditCashAccountDialog({
  account, onClose,
}: {
  account: CashAccountSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<UpdateCashAccountInput>({
    resolver: zodResolver(updateCashAccountSchema),
    defaultValues: {
      name: account.name,
      code: account.code ?? "",
      status: account.status as never,
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: UpdateCashAccountInput) =>
      api.patch<CashAccountSummary>(`/cash-accounts/${account.id}`, values),
    onSuccess: async () => {
      toast.success(`${account.name} updated`);
      await queryClient.invalidateQueries({ queryKey: ["cash-accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not update the drawer.");
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {account.name}</DialogTitle>
          <DialogDescription>
            Holding {formatINR(account.balance)}.
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
            <TextField form={form} name="name" label="Drawer name" required />
            <TextField form={form} name="code" label="Code" className="font-mono uppercase" />
          </div>

          <SelectField
            form={form}
            name="status"
            label="Status"
            hint={
              account.balance !== 0
                ? "This drawer still holds cash. Retiring it does not move the money — transfer it out first."
                : undefined
            }
            options={STATUS_OPTIONS}
          />

          <NotesField form={form} name="notes" label="Notes" />

          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              The branch is permanent — moving a drawer between branches would take its posted
              entries out from under the branch that recorded them.
            </span>
          </p>

          {formError ? <FormError message={formError} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
