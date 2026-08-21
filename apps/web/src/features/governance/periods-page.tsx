import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { CalendarClock, Lock, LockOpen, Plus } from "lucide-react";
import {
  closePeriodSchema, createPeriodSchema,
  type ClosePeriodInput, type CreatePeriodInput, type FinancialPeriodSummary,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { Can, useAuth } from "@/features/auth/auth-context";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Financial periods (§35).
 *
 * Closing a period is irreversible in effect if not in mechanism: nothing can be posted
 * into it afterwards, including reversals. The dialog says so in words before the button
 * is pressed, because "why can't I post to March" is a support call nobody should have to
 * make.
 */
export function PeriodsPage() {
  const [creating, setCreating] = React.useState(false);
  const [closing, setClosing] = React.useState<FinancialPeriodSummary | null>(null);
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ["periods"],
    queryFn: () => api.get<FinancialPeriodSummary[]>("/periods"),
  });

  const reopen = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/periods/${id}/reopen`, { reason }),
    onSuccess: async () => {
      toast.success("Period reopened", { description: "Posting into this range is allowed again." });
      await queryClient.invalidateQueries({ queryKey: ["periods"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not reopen the period."),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Financial Periods"
        description="Once a period is closed, nothing can be posted into it — including a reversal."
        actions={
          <Can permission="period.manage">
            <Button variant="accent" onClick={() => setCreating(true)}>
              <Plus />
              New period
            </Button>
          </Can>
        }
      />

      <Card className="overflow-hidden">
        {query.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={CalendarClock}
            title="Could not load periods"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          />
        ) : query.data.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No periods defined"
            description="Periods are optional. Without any, posting is never blocked by date — define one when you want to close a month or a year."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead className="hidden sm:table-cell">Range</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Transactions</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden xl:table-cell">Closed</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {p.name}
                      {p.isCurrent ? <Badge variant="accent">Current</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground sm:table-cell">
                    {formatDate(p.startDate)} → {formatDate(p.endDate)}
                  </TableCell>
                  <TableCell className="tabular hidden text-right text-sm lg:table-cell">
                    {p.transactionCount}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={p.status === "OPEN" ? "success" : p.status === "LOCKED" ? "danger" : "warning"}
                    >
                      {p.status === "OPEN" ? <LockOpen className="size-3" /> : <Lock className="size-3" />}
                      {p.status.charAt(0) + p.status.slice(1).toLowerCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                    {p.closedBy ? `${p.closedBy}${p.closedAt ? ` · ${formatDate(p.closedAt)}` : ""}` : "—"}
                  </TableCell>
                  <TableCell>
                    <Can permission="period.manage">
                      {p.status === "OPEN" ? (
                        <Button variant="outline" size="sm" onClick={() => setClosing(p)}>
                          <Lock />
                          Close
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          // A locked period is one filed with an authority — reopening it
                          // is a super-admin decision, and the button says so rather than
                          // failing after the click.
                          disabled={p.status === "LOCKED" && !user?.isSuperAdmin}
                          onClick={() => {
                            const reason = window.prompt(
                              "Why is this period being reopened? (recorded in the audit log)",
                            );
                            if (reason && reason.trim().length >= 10) {
                              reopen.mutate({ id: p.id, reason: reason.trim() });
                            } else if (reason !== null) {
                              toast.error("Give a reason of at least 10 characters.");
                            }
                          }}
                        >
                          <LockOpen />
                          Reopen
                        </Button>
                      )}
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <CreateDialog open={creating} onOpenChange={setCreating} />
      <CloseDialog period={closing} onClose={() => setClosing(null)} />
    </div>
  );
}

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const form = useForm<CreatePeriodInput>({ resolver: zodResolver(createPeriodSchema) });

  const mutation = useMutation({
    mutationFn: (v: CreatePeriodInput) => api.post("/periods", v),
    onSuccess: async () => {
      toast.success("Period opened");
      await queryClient.invalidateQueries({ queryKey: ["periods"] });
      form.reset();
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        for (const fe of e.fieldErrors) form.setError(fe.field as keyof CreatePeriodInput, { message: fe.message });
        toast.error(e.message);
        return;
      }
      toast.error("Could not create the period.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New financial period</DialogTitle>
          <DialogDescription>
            Periods must not overlap — a transaction's period has to be unambiguous.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="period-name">Name</Label>
            <Input id="period-name" placeholder="FY 2026-27 Q1" {...form.register("name")} />
            {form.formState.errors.name ? (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="period-start">Starts</Label>
              <Input id="period-start" type="date" {...form.register("startDate")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="period-end">Ends</Label>
              <Input id="period-end" type="date" {...form.register("endDate")} />
              {form.formState.errors.endDate ? (
                <p className="text-xs text-destructive">{form.formState.errors.endDate.message}</p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>Open period</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CloseDialog({ period, onClose }: { period: FinancialPeriodSummary | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<ClosePeriodInput>({
    resolver: zodResolver(closePeriodSchema),
    defaultValues: { reason: "", lock: false },
  });

  const mutation = useMutation({
    mutationFn: (v: ClosePeriodInput) => api.post(`/periods/${period!.id}/close`, v),
    onSuccess: async () => {
      toast.success(`${period!.name} closed`, {
        description: "Nothing further can be posted into this range.",
      });
      await queryClient.invalidateQueries({ queryKey: ["periods"] });
      form.reset();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not close the period."),
  });

  const lock = form.watch("lock");

  return (
    <Dialog open={Boolean(period)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close {period?.name}?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>
                After closing, <span className="font-medium text-foreground">nothing can be posted</span>{" "}
                into {period ? `${formatDate(period.startDate)} – ${formatDate(period.endDate)}` : "this range"} —
                payments, adjustments and reversals alike.
              </p>
              <p>
                A correction for a closed period is posted in the current period instead,
                referencing the original. That is deliberate: figures somebody has already
                reported on must not change underneath them.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="close-reason">Reason (recorded in the audit log)</Label>
            <Textarea id="close-reason" rows={2} placeholder="e.g. Quarter closed and reported to the proprietor" {...form.register("reason")} />
            {form.formState.errors.reason ? (
              <p className="text-xs text-destructive">{form.formState.errors.reason.message}</p>
            ) : null}
          </div>

          <label className="flex items-start gap-2.5 rounded-md border border-border p-3">
            <Checkbox
              checked={lock}
              onCheckedChange={(v) => form.setValue("lock", v === true)}
              className="mt-0.5"
            />
            <span className="text-sm">
              <span className="font-medium">Lock as well</span>
              <span className="block text-xs text-muted-foreground">
                For a year already filed with an authority. Only a super admin can reopen a
                locked period.
              </span>
            </span>
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="destructive" loading={mutation.isPending}>
              {lock ? "Close and lock" : "Close period"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
