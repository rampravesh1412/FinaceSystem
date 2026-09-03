import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Check, ClipboardCheck, Clock, Lock, X } from "lucide-react";
import { rejectSchema, type PendingApproval, type RejectInput } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * The approval queue (§27).
 *
 * Each card shows the EXACT ledger postings that will be written on approval, not just an
 * amount. An approver signing off "₹7,00,000 to Sharma Traders" without seeing which
 * accounts move is rubber-stamping, and the whole control exists to prevent that.
 *
 * Requests above the caller's tier are shown but disabled, rather than hidden — an
 * approver should know what is waiting even when somebody else has to clear it.
 */
export function ApprovalsPage() {
  const [page, setPage] = React.useState(1);
  const [rejecting, setRejecting] = React.useState<PendingApproval | null>(null);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["approvals", page],
    queryFn: () => api.list<PendingApproval>(`/approvals${qs({ page, limit: 20 })}`),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api.post<{ txnNo: string }>(`/approvals/${id}/approve`, {}),
    onSuccess: async (result) => {
      toast.success(`Approved and posted as ${result.txnNo}`, {
        description: "The ledger entries are now on the books.",
      });
      await queryClient.invalidateQueries();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not approve.");
    },
  });

  const meta = query.data?.meta as { totalValue?: number } | undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Approvals"
        description="Transactions held for sign-off. Nothing here has touched a balance."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Awaiting approval" value={query.data?.meta.total} asCount icon={ClipboardCheck} loading={query.isPending} />
        <StatCard label="Total value held" value={meta?.totalValue} loading={query.isPending} />
        <StatCard
          label="Oldest request"
          value={query.data?.items[0]?.ageHours ?? 0}
          asCount
          icon={Clock}
          loading={query.isPending}
        />
      </div>

      {/* The reassurance an approver needs before they trust the queue. */}
      <p className="rounded-md border border-border bg-surface-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Nothing here has moved any money.</span>{" "}
        A held transaction has no ledger entries at all — the postings below are written only
        when you approve. Rejecting posts nothing and keeps the request on the record.
      </p>

      {query.isPending ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-44 w-full" />)}
        </div>
      ) : query.isError ? (
        <Card>
          <EmptyState
            icon={ClipboardCheck}
            title="Could not load the queue"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          />
        </Card>
      ) : query.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Check}
            title="Nothing awaiting approval"
            description="Transactions above the configured threshold will appear here for sign-off."
          />
        </Card>
      ) : (
        <>
          <div className="space-y-4">
            {query.data.items.map((item) => (
              <Card key={item.id} className={item.canApprove ? undefined : "opacity-80"}>
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{item.typeLabel}</span>
                        <Badge variant={item.requiredTier === "SUPER_ADMIN" ? "warning" : "default"}>
                          {item.requiredTier.replace("_", " ").toLowerCase()} approval
                        </Badge>
                        {item.ageHours >= 24 ? (
                          <Badge variant="danger">
                            <Clock className="size-3" />
                            {Math.floor(item.ageHours / 24)}d waiting
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {item.party?.name ?? item.accountLabel}
                        {item.narration ? ` · ${item.narration}` : ""}
                      </p>
                      <p className="text-2xs text-muted-foreground">
                        Raised by {item.submittedBy?.name ?? "—"} · {relativeTime(item.submittedAt)}
                      </p>
                    </div>

                    <div className="text-right">
                      <Money value={item.grossAmount} size="xl" showIcon={false} />
                      {item.chargeAmount > 0 ? (
                        <div className="text-2xs text-muted-foreground">
                          charge <Money value={item.chargeAmount} showIcon={false} size="sm" /> · net{" "}
                          <Money value={item.netAmount} showIcon={false} size="sm" />
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <Separator />

                  {/* The postings themselves — what approval actually authorises. */}
                  <div>
                    <div className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Will post
                    </div>
                    <ul className="space-y-1">
                      {item.lines.map((line, i) => (
                        <li key={i} className="flex items-center gap-3 text-sm">
                          <Badge variant={line.direction === "DEBIT" ? "info" : "default"} className="w-16 justify-center">
                            {line.direction === "DEBIT" ? "Dr" : "Cr"}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate">{line.accountName}</span>
                          <Money value={line.amount} showIcon={false} size="sm" />
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {item.canApprove ? (
                      <>
                        <Button variant="outline" size="sm" onClick={() => setRejecting(item)}>
                          <X />
                          Reject
                        </Button>
                        <Button
                          variant="accent"
                          size="sm"
                          loading={approve.isPending}
                          onClick={() => approve.mutate(item.id)}
                        >
                          <Check />
                          Approve &amp; post
                        </Button>
                      </>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Button variant="outline" size="sm" disabled>
                              <Lock />
                              Above your tier
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          This amount needs {item.requiredTier.replace("_", " ").toLowerCase()} approval.
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <PaginationBar meta={query.data.meta} onPageChange={setPage} label="requests" />
        </>
      )}

      <RejectDialog item={rejecting} onClose={() => setRejecting(null)} />
    </div>
  );
}

function RejectDialog({ item, onClose }: { item: PendingApproval | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<RejectInput>({ resolver: zodResolver(rejectSchema), defaultValues: { reason: "" } });

  const mutation = useMutation({
    mutationFn: (values: RejectInput) => api.post(`/approvals/${item!.id}/reject`, values),
    onSuccess: async () => {
      toast.success("Rejected", { description: "Nothing was posted. The request stays on the record." });
      await queryClient.invalidateQueries();
      form.reset();
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not reject.");
    },
  });

  return (
    <AlertDialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reject this request?</AlertDialogTitle>
          <AlertDialogDescription>
            Nothing will be posted. The request stays visible with your reason attached — a
            rejected request that simply vanished would teach people to route around the control.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form id="reject-form" onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="space-y-1.5">
          <Label htmlFor="reject-reason">Reason (recorded in the audit log)</Label>
          <Textarea
            id="reject-reason"
            rows={3}
            placeholder="e.g. The supporting invoice does not match the amount requested"
            {...form.register("reason")}
          />
          {form.formState.errors.reason ? (
            <p className="text-xs text-destructive">{form.formState.errors.reason.message}</p>
          ) : null}
        </form>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={mutation.isPending}
            onClick={(e) => {
              e.preventDefault();
              void form.handleSubmit((v) => mutation.mutate(v))();
            }}
          >
            {mutation.isPending ? "Rejecting…" : "Reject"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

