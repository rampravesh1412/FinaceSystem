import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  ArrowRight, Clock, FileText, Link2, Paperclip, Pencil, Scale, TriangleAlert, Undo2, User,
} from "lucide-react";
import { reverseTransactionSchema, type ReverseTransactionInput, type TransactionDetail } from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { formatDate, formatDateTime, relativeTime } from "@/lib/utils";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { statusVariant } from "./transaction-table";
import { EditPaymentDialog } from "./payment-edit";

/**
 * Transaction details drawer (§46).
 *
 * Everything traceable from one screen: the financial summary, the actual ledger entries
 * that were posted, the audit timeline, attachments, and the link to a reversal in either
 * direction. If a figure cannot be explained from this drawer, the drawer is incomplete.
 */
export function TransactionDrawer({
  transactionId,
  onClose,
}: {
  transactionId: string | null;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["transaction", transactionId],
    queryFn: () => api.get<TransactionDetail>(`/transactions/${transactionId}`),
    enabled: Boolean(transactionId),
  });

  return (
    <Sheet open={Boolean(transactionId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        {query.isPending ? (
          <div className="space-y-4 p-5">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : query.isError ? (
          <div className="p-5">
            <SheetHeader className="border-0 p-0">
              <SheetTitle>Could not load the transaction</SheetTitle>
            </SheetHeader>
            <p className="mt-2 text-sm text-muted-foreground">
              {query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            </p>
          </div>
        ) : (
          <DrawerBody txn={query.data} onClose={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ txn, onClose }: { txn: TransactionDetail; onClose: () => void }) {
  const { can } = useAuth();
  const [reverseOpen, setReverseOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const isPayment = txn.type === "PAYMENT_IN" || txn.type === "PAYMENT_OUT";

  const totalDebit = txn.entries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = txn.entries.reduce((s, e) => s + e.credit, 0);

  return (
    <>
      <SheetHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <SheetTitle className="font-mono text-base">{txn.txnNo}</SheetTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{txn.typeLabel}</Badge>
              <Badge variant={statusVariant(txn.status)}>
                {txn.status.charAt(0) + txn.status.slice(1).toLowerCase()}
              </Badge>
              {txn.isReversal ? (
                <Badge variant="warning">
                  <Undo2 className="size-3" />
                  Reversal
                </Badge>
              ) : null}
                          </div>
          </div>
        </div>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto">
        {/* A reversed transaction says so at the top. Someone scanning the drawer must not
            read a superseded figure as current. */}
        {txn.status === "REVERSED" ? (
          <div className="flex items-start gap-2.5 border-b border-warning/30 bg-warning-subtle px-5 py-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div>
              {/* An EDIT and a plain reversal both leave the original REVERSED, and they
                  read very differently. Saying "reversed" alone would send somebody
                  looking for a cancellation that never happened. */}
              <p className="font-medium text-foreground">
                {txn.supersededByTxn
                  ? `This was corrected — ${txn.supersededByTxn.txnNo} replaced it.`
                  : "This transaction was reversed."}
              </p>
              <p className="text-muted-foreground">
                {txn.supersededByTxn
                  ? "It stays on the record with the reversal that cancelled it, so the correction is auditable end to end."
                  : "It remains on the record for audit. Its effect on every balance has been cancelled."}
              </p>
            </div>
          </div>
        ) : txn.supersedesTxn ? (
          <div className="flex items-start gap-2.5 border-b border-info/30 bg-info/5 px-5 py-3 text-sm">
            <Pencil className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
            <div>
              <p className="font-medium text-foreground">
                This corrects {txn.supersedesTxn.txnNo}.
              </p>
              <p className="text-muted-foreground">
                The original was reversed rather than rewritten, so both versions and the
                reversal between them are still on the books.
              </p>
            </div>
          </div>
        ) : null}

        {/* Financial summary — gross, charge and net, always all three (§18, §46). */}
        <section className="space-y-3 p-5">
          <SectionTitle icon={Scale}>Financial summary</SectionTitle>
          <dl className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-surface-muted/50 p-4">
            <Figure label="Gross" value={txn.grossAmount} />
            <Figure label="Charge" value={txn.chargeAmount} muted={txn.chargeAmount === 0} />
            <Figure label="Net" value={txn.netAmount} emphasis />
          </dl>

          {txn.chargeRule?.basis ? (
            <p className="text-xs text-muted-foreground">
              Charge basis: <span className="text-foreground">{txn.chargeRule.basis}</span>
            </p>
          ) : null}

          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Field label="Date">{formatDate(txn.date)}</Field>
            <Field label="Payment mode">{txn.paymentMode ?? "—"}</Field>
            <Field label="Account">{txn.accountLabel}</Field>
            <Field label="Party">{txn.party ? `${txn.party.name} (${txn.party.code})` : "—"}</Field>
            <Field label="Reference">{txn.referenceNo ?? "—"}</Field>
            <Field label="Created by">{txn.createdBy?.name ?? "—"}</Field>
          </dl>

          {txn.narration ? (
            <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm">{txn.narration}</p>
          ) : null}
        </section>

        <Separator />

        {/* The actual postings. This is what makes the balance explicable. */}
        <section className="space-y-3 p-5">
          <SectionTitle icon={FileText}>Ledger entries</SectionTitle>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txn.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <div className="text-sm font-medium">{entry.accountName}</div>
                      <div className="font-mono text-2xs text-muted-foreground">{entry.accountCode}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      {entry.debit ? <Money value={entry.debit} showIcon={false} /> : <Dash />}
                    </TableCell>
                    <TableCell className="text-right">
                      {entry.credit ? <Money value={entry.credit} showIcon={false} /> : <Dash />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="text-xs uppercase tracking-wider text-muted-foreground">
                    {totalDebit === totalCredit ? "Balanced" : "OUT OF BALANCE"}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    <Money value={totalDebit} showIcon={false} />
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    <Money value={totalCredit} showIcon={false} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </section>

        {txn.items && txn.items.length > 0 ? (
          <>
            <Separator />
            <section className="space-y-3 p-5">
              <SectionTitle icon={FileText}>Items</SectionTitle>
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {txn.items.map((item, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">{item.description}</TableCell>
                        <TableCell className="tabular text-right text-sm">{item.quantity}</TableCell>
                        <TableCell className="text-right">
                          <Money value={item.unitPrice} showIcon={false} size="sm" />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={item.amount} showIcon={false} size="sm" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          </>
        ) : null}

        {txn.attachments.length > 0 ? (
          <>
            <Separator />
            <section className="space-y-3 p-5">
              <SectionTitle icon={Paperclip}>Attachments</SectionTitle>
              <ul className="space-y-1.5">
                {txn.attachments.map((a) => (
                  <li key={a.url}>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-muted"
                    >
                      <Paperclip className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="truncate">{a.filename}</span>
                      <span className="ml-auto text-2xs text-muted-foreground">
                        {Math.round(a.size / 1024)} KB
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}

        <Separator />

        {/* Audit timeline (§51). */}
        <section className="space-y-3 p-5">
          <SectionTitle icon={Clock}>Timeline</SectionTitle>
          <ol className="space-y-0">
            {txn.timeline.map((event, i) => (
              <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                {i < txn.timeline.length - 1 ? (
                  <span className="absolute left-[7px] top-4 h-full w-px bg-border" aria-hidden />
                ) : null}
                <span className="relative mt-1 size-3.5 shrink-0 rounded-full border-2 border-accent bg-background" aria-hidden />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium">{formatAction(event.action)}</span>
                    <span className="text-xs text-muted-foreground">{relativeTime(event.at)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <User className="mr-1 inline size-3" aria-hidden />
                    {event.by}
                    {event.role ? ` · ${event.role.replace(/_/g, " ").toLowerCase()}` : ""}
                  </p>
                  {event.changedFields?.length ? (
                    <p className="flex flex-wrap items-center gap-1 pt-0.5">
                      {event.changedFields.map((f) => (
                        <Badge key={f} variant="outline" className="font-mono text-2xs">
                          {f}
                        </Badge>
                      ))}
                    </p>
                  ) : null}
                  {event.reason ? (
                    <p className="mt-1 rounded border border-border bg-surface-muted px-2 py-1 text-xs">
                      {event.reason}
                    </p>
                  ) : null}
                  <p className="text-2xs text-muted-foreground">{formatDateTime(event.at)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {txn.reversedBy || txn.reversalOf || txn.supersededByTxn || txn.supersedesTxn ? (
          <>
            <Separator />
            <section className="space-y-2 p-5">
              <SectionTitle icon={Link2}>Related</SectionTitle>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {txn.supersededByTxn ? (
                  <li>
                    Replaced by{" "}
                    <span className="font-mono text-foreground">{txn.supersededByTxn.txnNo}</span>,
                    which carries the corrected figures.
                  </li>
                ) : null}
                {txn.supersedesTxn ? (
                  <li>
                    Corrects{" "}
                    <span className="font-mono text-foreground">{txn.supersedesTxn.txnNo}</span>.
                  </li>
                ) : null}
                {txn.reversedBy ? <li>Cancelled by a reversal.</li> : null}
                {txn.reversalOf ? <li>This is the reversal of an earlier transaction.</li> : null}
              </ul>
            </section>
          </>
        ) : null}
      </div>

      {/**
        * Edit and Reverse. There is no delete, anywhere.
        *
        * Edit is offered only on a payment, because it is the only type whose correction
        * path is built — and it shares `finance.payment.reverse`, since a money edit IS a
        * reversal underneath and gating it lower would be a way around the stricter
        * permission.
        */}
      {txn.status === "COMPLETED" && !txn.isReversal && can("finance.payment.reverse") ? (
        <div className="flex items-center justify-between gap-3 border-t border-border p-4">
          <p className="text-2xs text-muted-foreground">
            Nothing here is deleted. A correction is posted; the original stays.
          </p>
          <div className="flex shrink-0 gap-2">
            {isPayment ? (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil />
                Edit
              </Button>
            ) : null}
            <Button variant="destructive" size="sm" onClick={() => setReverseOpen(true)}>
              <Undo2 />
              Reverse
            </Button>
          </div>
        </div>
      ) : null}

      {isPayment ? (
        <EditPaymentDialog
          txn={txn}
          open={editOpen}
          onOpenChange={setEditOpen}
          onDone={onClose}
        />
      ) : null}

      <ReverseDialog
        open={reverseOpen}
        onOpenChange={setReverseOpen}
        txn={txn}
        onDone={onClose}
      />
    </>
  );
}

function ReverseDialog({
  open,
  onOpenChange,
  txn,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  txn: TransactionDetail;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<ReverseTransactionInput>({
    resolver: zodResolver(reverseTransactionSchema),
    defaultValues: { reason: "" },
  });

  const mutation = useMutation({
    mutationFn: (values: ReverseTransactionInput) =>
      api.post<{ reversal: { txnNo: string } }>(`/transactions/${txn.id}/reverse`, values),
    onSuccess: async (data) => {
      toast.success(`${txn.txnNo} reversed`, {
        description: `${data.reversal.txnNo} posted. The original remains on the record.`,
      });
      await queryClient.invalidateQueries();
      form.reset();
      onOpenChange(false);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        for (const fe of error.fieldErrors) {
          form.setError(fe.field as keyof ReverseTransactionInput, { message: fe.message });
        }
        toast.error(error.message);
        return;
      }
      toast.error("Could not reverse the transaction.");
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reverse {txn.txnNo}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {/* §65: a high-value action states exactly what is about to happen, in words. */}
              <p>
                This posts a mirror-image entry that cancels{" "}
                <span className="tabular font-medium text-foreground">
                  <Money value={txn.grossAmount} showIcon={false} />
                </span>{" "}
                against <span className="font-medium text-foreground">{txn.accountLabel}</span>
                {txn.party ? (
                  <>
                    {" "}and <span className="font-medium text-foreground">{txn.party.name}</span>
                  </>
                ) : null}
                .
              </p>
              <p>
                {txn.txnNo} is <span className="font-medium text-foreground">not deleted</span> — it
                stays visible, marked reversed, linked to its mirror.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
          className="space-y-3"
          id="reverse-form"
        >
          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason (recorded in the audit log)</Label>
            <Textarea
              id="reason"
              rows={3}
              placeholder="e.g. Duplicate entry — the same NEFT was recorded twice"
              aria-invalid={Boolean(form.formState.errors.reason)}
              {...form.register("reason")}
            />
            {form.formState.errors.reason ? (
              <p className="text-xs text-destructive">{form.formState.errors.reason.message}</p>
            ) : null}
          </div>
        </form>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            type="submit"
            form="reverse-form"
            disabled={mutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              void form.handleSubmit((values) => mutation.mutate(values))();
            }}
          >
            {mutation.isPending ? "Reversing…" : "Reverse transaction"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────────── */

function SectionTitle({ icon: Icon, children }: { icon: typeof Clock; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      {children}
    </h3>
  );
}

function Figure({ label, value, emphasis, muted }: { label: string; value: number; emphasis?: boolean; muted?: boolean }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd>
        <Money
          value={value}
          showIcon={false}
          size={emphasis ? "lg" : "md"}
          className={muted ? "text-muted-foreground" : undefined}
        />
      </dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 sm:border-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium">{children}</dd>
    </div>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;

function formatAction(action: string): string {
  const map: Record<string, string> = {
    POST: "Posted to the ledger",
    CREATE: "Created",
    UPDATE: "Updated",
    REVERSE: "Reversed",
    APPROVE: "Approved",
    REJECT: "Rejected",
  };
  return map[action] ?? action.charAt(0) + action.slice(1).toLowerCase().replace(/_/g, " ");
}

export { ArrowRight };
