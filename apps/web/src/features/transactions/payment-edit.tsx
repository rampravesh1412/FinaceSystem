import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Info, Pencil, TriangleAlert } from "lucide-react";
import {
  PAYMENT_MONEY_FIELDS,
  formatINR,
  parseAmount,
  type PaymentEditResult,
  type TransactionDetail,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAccounts, useParties } from "./use-reference-data";

/**
 * Edit a posted payment (§25, §28).
 *
 * Every field on the voucher is editable here, and the form is candid about the fact that
 * they are not all editable the same way:
 *
 *   LABELS  — reference, narration, payment mode, a note. Saved in place. No balance moves.
 *   MONEY   — date, amount, party, account. Saving one REVERSES this transaction and posts
 *             a corrected replacement in its place, all three documents linked and visible.
 *
 * The banner switches as soon as a money field is touched, so nobody discovers after
 * saving that their voucher number changed. That is the whole reason this is one form with
 * a live warning rather than two separate screens: the operator wants to "fix the payment",
 * and which mechanism that requires is the system's problem to explain, not theirs to know.
 */
export function EditPaymentDialog({
  txn,
  open,
  onOpenChange,
  onDone,
}: {
  txn: TransactionDetail;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const endpoint = txn.type === "PAYMENT_IN" ? "/payment-in" : "/payment-out";

  const parties = useParties();
  const { options: accounts } = useAccounts();

  // Seeded from what is on the voucher, so an untouched field submits unchanged.
  const [date, setDate] = React.useState(txn.date.slice(0, 10));
  const [amount, setAmount] = React.useState(String(txn.grossAmount / 100));
  const [partyId, setPartyId] = React.useState(txn.party?.id ?? "");
  const [accountId, setAccountId] = React.useState("");
  const [paymentMode, setPaymentMode] = React.useState(txn.paymentMode ?? "");
  const [referenceNo, setReferenceNo] = React.useState(txn.referenceNo ?? "");
  const [narration, setNarration] = React.useState(txn.narration ?? "");
  const [reason, setReason] = React.useState("");

  const original = React.useRef({
    date: txn.date.slice(0, 10),
    amount: String(txn.grossAmount / 100),
    partyId: txn.party?.id ?? "",
  });

  /**
   * Whether this save will reverse and repost.
   *
   * `accountId` is deliberately excluded from the comparison when it is empty: the detail
   * payload carries the account LABEL, not its id, so an untouched picker has nothing to
   * compare against. Leaving it blank means "unchanged", and the server keeps the original.
   */
  const willRepost =
    date !== original.current.date ||
    amount !== original.current.amount ||
    partyId !== original.current.partyId ||
    accountId !== "";

  const mutation = useMutation({
    mutationFn: () =>
      api.patch<PaymentEditResult>(`${endpoint}/${txn.id}`, {
        // Money fields — only sent when actually changed, so an untouched form is a
        // label-only edit and the server does not reverse anything.
        ...(date !== original.current.date ? { date } : {}),
        ...(amount !== original.current.amount ? { amount } : {}),
        ...(partyId !== original.current.partyId ? { partyId } : {}),
        ...(accountId ? { accountId } : {}),
        // Labels.
        ...(paymentMode ? { paymentMode } : {}),
        referenceNo,
        narration,
        reason,
      }),
    onSuccess: async (result) => {
      if (result.outcome === "REPOSTED") {
        toast.success(`Reposted as ${result.transaction.txnNo}`, {
          description: `${result.replaced!.txnNo} was reversed and stays on the record.`,
        });
      } else {
        toast.success(`${result.transaction.txnNo} updated`);
      }
      await queryClient.invalidateQueries();
      onOpenChange(false);
      onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not save the change."),
  });

  const parsed = React.useMemo(() => {
    try {
      return parseAmount(amount);
    } catch {
      return null;
    }
  }, [amount]);

  const reasonShort = reason.trim().length < 10;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {txn.txnNo}</DialogTitle>
          <DialogDescription>
            Change any field. What happens on save depends on whether the money changed.
          </DialogDescription>
        </DialogHeader>

        {/* The live consequence. It changes the moment a money field is touched. */}
        {willRepost ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle p-3 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              <span className="font-medium text-foreground">
                This will reverse {txn.txnNo} and post a corrected replacement.
              </span>{" "}
              All three documents stay on the books and link to each other, so the balance
              is still explained by its entries. The voucher number will change.
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              Only labels have changed, so {txn.txnNo} is updated in place. No entry is
              posted and no balance moves.
            </span>
          </p>
        )}

        <div className="space-y-4">
          <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            Money — changing any of these reposts
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-date">Date</Label>
              <Input id="edit-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-amount">Amount</Label>
              <Input
                id="edit-amount"
                inputMode="decimal"
                className="tabular"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {parsed !== null && parsed !== txn.grossAmount ? (
                <p className="text-2xs text-muted-foreground">
                  Was {formatINR(txn.grossAmount)}, becomes {formatINR(parsed)}.
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-party">Party</Label>
            <Select value={partyId} onValueChange={setPartyId}>
              <SelectTrigger id="edit-party">
                <SelectValue placeholder="Choose a party" />
              </SelectTrigger>
              <SelectContent>
                {(parties.data?.items ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-account">
              {txn.type === "PAYMENT_IN" ? "Received into" : "Paid from"}
            </Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="edit-account">
                <SelectValue placeholder={txn.accountLabel || "Choose an account"} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-2xs text-muted-foreground">
              Currently {txn.accountLabel}. Leave it to keep that account.
            </p>
          </div>

          <Separator />

          <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            Labels — saved in place
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-mode">Payment mode</Label>
              <Select value={paymentMode} onValueChange={setPaymentMode}>
                <SelectTrigger id="edit-mode">
                  <SelectValue placeholder="Not recorded" />
                </SelectTrigger>
                <SelectContent>
                  {["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "NEFT", "RTGS", "IMPS", "CARD", "OTHER"].map(
                    (m) => (
                      <SelectItem key={m} value={m}>
                        {m.replace(/_/g, " ")}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-ref">Reference no</Label>
              <Input id="edit-ref" value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-narration">Narration</Label>
            <Input
              id="edit-narration"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <Separator />

          {/* Mandatory either way. An unexplained change to a posted payment is exactly
              what the audit trail exists to prevent, and this is what it quotes. */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-reason">Why is this being changed?</Label>
            <Textarea
              id="edit-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Recounted the cash — it was 7,500 not 10,000"
            />
            <p className="text-2xs text-muted-foreground">
              {reasonShort
                ? `${10 - reason.trim().length} more to go — this goes on the audit trail verbatim.`
                : "Recorded against your name on the audit trail."}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={willRepost ? "destructive" : "accent"}
            loading={mutation.isPending}
            disabled={reasonShort || parsed === null || parsed <= 0}
            onClick={() => mutation.mutate()}
          >
            <Pencil />
            {willRepost ? "Reverse and repost" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Exported so the drawer can label its own button consistently. */
export const PAYMENT_EDITABLE_MONEY_FIELDS = PAYMENT_MONEY_FIELDS;
