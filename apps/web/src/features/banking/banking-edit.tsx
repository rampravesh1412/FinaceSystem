import * as React from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Lock, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  formatINR,
  money,
  paiseToRupees,
  updateBankAccountSchema,
  updateBankSchema,
  updateCashAccountSchema,
  type BankAccountSummary,
  type BankSummary,
  type CashAccountSummary,
  type OpeningBalanceState,
  type UpdateBankAccountInput,
  type UpdateBankInput,
  type UpdateCashAccountInput,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { useAuth } from "@/features/auth/auth-context";
import { AmountField, NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { useParsedAmount } from "./account-form";
import { FormError } from "./bank-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

function ActionsMenu({
  label, onEdit, onDelete,
}: {
  label: string;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${label}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onEdit ? (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            Edit details
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <DropdownMenuItem destructive onSelect={onDelete}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Opening balance ─────────────────────────────────────────────────────── */

/** Asked only when an edit dialog opens: answering it costs the server a query per account. */
function useOpeningBalance(path: string) {
  return useQuery({
    queryKey: ["opening-balance", path],
    queryFn: () => api.get<OpeningBalanceState>(`${path}/opening-balance`),
  });
}

/** Paise as the rupee text an amount field holds — the shared `money` parse reads it back. */
function rupeeInput(paise: number): string {
  return paiseToRupees(paise).toFixed(2);
}

const OPENING_CHANGED =
  "The opening balance was corrected: the old figure is reversed and the new one posted, so the ledger shows the change.";

/**
 * The opening balance, inside Edit.
 *
 * Editable only while nothing but the opening has been posted to the account. The server
 * decides, and this shows its answer: a field while it is open, the figure and the reason
 * once it is locked. `children` is the field, so each dialog binds it to its own form.
 */
function OpeningBalanceSection({
  query, typed, label, children,
}: {
  query: UseQueryResult<OpeningBalanceState>;
  typed: string | number | undefined;
  label: string;
  children: React.ReactNode;
}) {
  const parsed = useParsedAmount(typed);

  if (query.isPending) {
    return (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <p className="text-xs text-muted-foreground">
        The opening balance could not be loaded, so it cannot be changed right now.
      </p>
    );
  }

  const state = query.data;

  if (!state.editable) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">
          {label}{" "}
          <span className="tabular font-medium text-foreground">{formatINR(state.amount)}</span> is locked:{" "}
          {state.otherEntryCount} transaction{state.otherEntryCount === 1 ? " has" : "s have"} been
          posted to this account since. Correct a mistake in it with an adjustment instead.
        </span>
      </p>
    );
  }

  const changed = typed !== undefined && parsed !== state.amount;

  return (
    <div className="space-y-1.5">
      {children}
      <p className="text-xs text-muted-foreground">
        {changed ? (
          <span className="tabular font-medium text-foreground">
            {formatINR(state.amount)} → {formatINR(parsed)}.{" "}
          </span>
        ) : null}
        Can be changed until the first transaction is posted.{" "}
        {state.txnNo
          ? `Saving a new figure reverses ${state.txnNo} and posts the new one on ${formatDate(state.date)}, so the ledger shows the correction.`
          : "It posts against equity like any opening balance."}
      </p>
    </div>
  );
}

/* ── Delete ──────────────────────────────────────────────────────────────── */

/**
 * Soft delete, for a super admin.
 *
 * Says what "delete" means here before anyone confirms it: hidden from every list and
 * picker, erased from nothing. An account that still holds money cannot be deleted — the
 * dialog says so and offers no button, and the server refuses on the same grounds.
 */
function DeleteAccountDialog({
  path, name, balance, onClose,
}: {
  path: string;
  name: string;
  balance: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const holdsMoney = balance !== 0;

  const mutation = useMutation({
    mutationFn: () => api.del(path),
    onSuccess: async () => {
      toast.success(`${name} deleted`, {
        description: "Hidden from every list and picker. Its history stays in the ledger and the reports.",
      });
      // Lists, pickers and ledger pickers all drop it — refetch the lot.
      await queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not delete the account."),
  });

  return (
    <AlertDialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {holdsMoney ? (
              <>
                It still holds <span className="tabular font-medium text-foreground">{formatINR(balance)}</span>.
                Move the money to another account first — or, if that is only its opening
                balance, set the opening balance to zero in Edit details. Deleting it now would
                hide money that the reports still count.
              </>
            ) : (
              <>
                It disappears from the accounts list and from every picker, so nothing new can be
                posted to it. Nothing is erased: the record stays in the database, and its past
                entries stay in the ledger and in every report.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>{holdsMoney ? "Close" : "Keep it"}</AlertDialogCancel>
          {holdsMoney ? null : (
            <Button variant="destructive" loading={mutation.isPending} onClick={() => mutation.mutate()}>
              Delete
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  const { can, user } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const canEdit = can("bank_accounts.edit");
  // A super admin's alone — the delete route checks the same flag.
  const canDelete = user?.isSuperAdmin === true;
  if (!canEdit && !canDelete) return null;

  return (
    <>
      <ActionsMenu
        label={account.accountName}
        onEdit={canEdit ? () => setEditing(true) : undefined}
        onDelete={canDelete ? () => setDeleting(true) : undefined}
      />
      {editing ? (
        <EditBankAccountDialog account={account} onClose={() => setEditing(false)} />
      ) : null}
      {deleting ? (
        <DeleteAccountDialog
          path={`/bank-accounts/${account.id}`}
          name={account.accountName}
          balance={account.balance}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </>
  );
}

/** The details form plus the opening balance, which saves through its own route. */
const editBankAccountSchema = updateBankAccountSchema.extend({ openingBalance: money.optional() });
type EditBankAccountValues = UpdateBankAccountInput & { openingBalance?: number };

function EditBankAccountDialog({
  account, onClose,
}: {
  account: BankAccountSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const opening = useOpeningBalance(`/bank-accounts/${account.id}`);

  const form = useForm<EditBankAccountValues>({
    resolver: zodResolver(editBankAccountSchema),
    defaultValues: {
      accountName: account.accountName,
      bankBranchName: account.bankBranchName ?? "",
      accountType: account.accountType as never,
      overdraftLimit: account.overdraftLimit,
      lowBalanceThreshold: account.lowBalanceThreshold,
      status: account.status as never,
    } as never,
  });

  // The field exists only once the server has said the opening is still editable.
  React.useEffect(() => {
    if (opening.data?.editable) {
      form.resetField("openingBalance", { defaultValue: rupeeInput(opening.data.amount) as never });
    }
  }, [opening.data, form]);

  const mutation = useMutation({
    mutationFn: async ({ openingBalance, ...details }: EditBankAccountValues) => {
      await api.patch<BankAccountSummary>(`/bank-accounts/${account.id}`, details);
      const state = opening.data;
      if (openingBalance === undefined || !state?.editable || openingBalance === state.amount) return false;
      await api.put<OpeningBalanceState>(`/bank-accounts/${account.id}/opening-balance`, { openingBalance });
      return true;
    },
    onSuccess: async (openingChanged) => {
      toast.success(`${account.accountName} updated`, openingChanged ? { description: OPENING_CHANGED } : undefined);
      if (openingChanged) {
        // A new opening moves balances on the dashboard and in the books as well.
        await queryClient.invalidateQueries();
      } else {
        await queryClient.invalidateQueries({ queryKey: ["bank-accounts"] });
        await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
      }
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
            Balance is {formatINR(account.balance)} — it is derived from the ledger. Only the
            opening balance can be corrected here, and only until the first transaction.
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

          <OpeningBalanceSection
            query={opening}
            typed={form.watch("openingBalance")}
            label="Opening balance"
          >
            <AmountField
              form={form}
              name="openingBalance"
              label="Opening balance"
              placeholder="0.00 — negative if it opened overdrawn"
            />
          </OpeningBalanceSection>

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
  const { can, user } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const canEdit = can("bank_accounts.edit");
  const canDelete = user?.isSuperAdmin === true;
  if (!canEdit && !canDelete) return null;

  return (
    <>
      <ActionsMenu
        label={account.name}
        onEdit={canEdit ? () => setEditing(true) : undefined}
        onDelete={canDelete ? () => setDeleting(true) : undefined}
      />
      {editing ? (
        <EditCashAccountDialog account={account} onClose={() => setEditing(false)} />
      ) : null}
      {deleting ? (
        <DeleteAccountDialog
          path={`/cash-accounts/${account.id}`}
          name={account.name}
          balance={account.balance}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </>
  );
}

const editCashAccountSchema = updateCashAccountSchema.extend({ openingBalance: money.optional() });
type EditCashAccountValues = UpdateCashAccountInput & { openingBalance?: number };

function EditCashAccountDialog({
  account, onClose,
}: {
  account: CashAccountSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const opening = useOpeningBalance(`/cash-accounts/${account.id}`);

  const form = useForm<EditCashAccountValues>({
    resolver: zodResolver(editCashAccountSchema),
    defaultValues: {
      name: account.name,
      code: account.code ?? "",
      status: account.status as never,
    } as never,
  });

  React.useEffect(() => {
    if (opening.data?.editable) {
      form.resetField("openingBalance", { defaultValue: rupeeInput(opening.data.amount) as never });
    }
  }, [opening.data, form]);

  const mutation = useMutation({
    mutationFn: async ({ openingBalance, ...details }: EditCashAccountValues) => {
      await api.patch<CashAccountSummary>(`/cash-accounts/${account.id}`, details);
      const state = opening.data;
      if (openingBalance === undefined || !state?.editable || openingBalance === state.amount) return false;
      await api.put<OpeningBalanceState>(`/cash-accounts/${account.id}/opening-balance`, { openingBalance });
      return true;
    },
    onSuccess: async (openingChanged) => {
      toast.success(`${account.name} updated`, openingChanged ? { description: OPENING_CHANGED } : undefined);
      if (openingChanged) {
        await queryClient.invalidateQueries();
      } else {
        await queryClient.invalidateQueries({ queryKey: ["cash-accounts"] });
        await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
      }
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

          <OpeningBalanceSection
            query={opening}
            typed={form.watch("openingBalance")}
            label="Opening cash"
          >
            <AmountField form={form} name="openingBalance" label="Opening cash" />
          </OpeningBalanceSection>

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
