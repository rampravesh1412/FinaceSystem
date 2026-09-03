import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, TriangleAlert, Wallet } from "lucide-react";
import { TALLY_STATUS_LABEL, type CashTally } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { Can } from "@/features/auth/auth-context";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Daily Cash Tally (§20).
 *
 * Everything above the "Counted" field is DERIVED from the ledger and shown read-only —
 * the operator counts the drawer and enters one number. The difference is then stated
 * plainly as SHORT or EXCESS.
 *
 * §62 is the whole point, and the page says so: the system does not offer to "fix" a
 * discrepancy. Recording it starts an investigation; it does not end one.
 */
export function CashTallyPage() {
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [cashAccountId, setCashAccountId] = React.useState<string>("");
  const [counted, setCounted] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const queryClient = useQueryClient();

  const targets = useQuery({
    queryKey: ["tally-targets"],
    queryFn: () => api.get<Array<{ id: string; name: string; code?: string }>>("/cash-tally/targets"),
  });

  React.useEffect(() => {
    if (!cashAccountId && targets.data?.length) setCashAccountId(targets.data[0]!.id);
  }, [targets.data, cashAccountId]);

  const tally = useQuery({
    queryKey: ["cash-tally", { date, cashAccountId }],
    queryFn: () => api.get<CashTally>(`/cash-tally${qs({ date, cashAccountId })}`),
    enabled: Boolean(cashAccountId),
  });

  const mutation = useMutation({
    mutationFn: () =>
      api.post<CashTally>("/cash-tally", {
        date,
        cashAccountId,
        actualClosing: counted,
        notes: notes || undefined,
      }),
    onSuccess: async (result) => {
      if (result.status === "MATCHED") {
        toast.success("Cash tallies exactly");
      } else {
        toast.warning(`${TALLY_STATUS_LABEL[result.status]} — recorded for investigation`, {
          description: "The expectation was not adjusted. Find the missing entry.",
        });
      }
      setCounted("");
      setNotes("");
      await queryClient.invalidateQueries({ queryKey: ["cash-tally"] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not record the tally.");
    },
  });

  const t = tally.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Daily Cash Tally"
        description="Count the drawer and compare it against what the ledger expects."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={cashAccountId} onValueChange={setCashAccountId}>
              <SelectTrigger className="w-56"><SelectValue placeholder="Choose a drawer" /></SelectTrigger>
              <SelectContent>
                {(targets.data ?? []).map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {target.code ? ` — ` : ""}{target.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto" aria-label="Date" />
          </div>
        }
      />

      {tally.isPending || !t ? (
        <Skeleton className="h-80 w-full" />
      ) : tally.isError ? (
        <Card>
          <EmptyState icon={Wallet} title="Could not load the tally" />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Expected closing</CardTitle>
              <p className="text-xs text-muted-foreground">
                Every figure below is derived from the ledger — none of it is typed in.
              </p>
            </CardHeader>
            <CardContent className="space-y-0 p-0">
              <Row label="Opening cash" value={t.openingCash} />
              <Row label="Cash received" value={t.cashReceived} direction="in" sign="+" />
              <Row label="Cash paid" value={t.cashPaid} direction="out" sign="−" />
              <Row label="Adjustments" value={t.adjustments} direction="auto" sign="±" />
              <Separator />
              <div className="flex items-center justify-between px-5 py-3">
                <span className="text-sm font-semibold">Expected closing</span>
                <Money value={t.expectedClosing} showIcon={false} size="lg" />
              </div>

              {t.actualClosing !== null ? (
                <>
                  <Separator />
                  <div className="flex items-center justify-between px-5 py-3">
                    <span className="text-sm">Counted in the drawer</span>
                    <Money value={t.actualClosing} showIcon={false} size="lg" />
                  </div>
                  <div
                    className={
                      t.status === "MATCHED"
                        ? "flex items-center gap-3 border-t border-success/30 bg-success-subtle px-5 py-3"
                        : "flex items-center gap-3 border-t border-warning/40 bg-warning-subtle px-5 py-3"
                    }
                  >
                    {t.status === "MATCHED" ? (
                      <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
                    ) : (
                      <TriangleAlert className="size-5 shrink-0 text-warning" aria-hidden />
                    )}
                    <div className="flex-1 text-sm">
                      <span className="font-medium text-foreground">
                        {TALLY_STATUS_LABEL[t.status]}
                        {t.difference ? (
                          <> <Money value={Math.abs(t.difference)} showIcon={false} size="sm" /></>
                        ) : null}
                      </span>
                      {t.status !== "MATCHED" ? (
                        <div className="text-muted-foreground">
                          The expected figure has not been changed. Find the missing transaction —
                          if it turns out to be a genuine loss, post an adjustment with a reason.
                        </div>
                      ) : null}
                    </div>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Can permission="cash_tally.create">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {t.actualClosing === null ? "Count the drawer" : "Recount"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="counted">Amount counted</Label>
                    <Input
                      id="counted"
                      inputMode="decimal"
                      placeholder="0.00"
                      className="tabular"
                      value={counted}
                      onChange={(e) => setCounted(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tally-notes">Notes</Label>
                    <Textarea
                      id="tally-notes"
                      rows={2}
                      placeholder="Anything worth recording about the count"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </div>
                  <Button
                    variant="accent"
                    className="w-full"
                    disabled={!counted}
                    loading={mutation.isPending}
                    onClick={() => mutation.mutate()}
                  >
                    Record count
                  </Button>
                  {t.countedBy ? (
                    <p className="text-2xs text-muted-foreground">
                      Last counted by {t.countedBy}
                      {t.countedAt ? ` on ${formatDate(t.countedAt)}` : ""}.
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </Can>

            {/* The AMIRI workbook's context columns, preserved. */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">The day in context</CardTitle>
              </CardHeader>
              <CardContent className="space-y-0 p-0">
                <Row label="Total expenses" value={t.totalExpenses} direction="out" compact />
                <Row label="Party given" value={t.partyGiven} compact />
                <Row label="Party taken" value={t.partyTaken} compact />
                <Row label="Net party movement" value={t.netPartyMovement} direction="auto" compact />
                <Separator />
                <div className="flex items-center justify-between px-5 py-2.5">
                  <div>
                    <div className="text-sm">Today's profit</div>
                    {/* The reminder that matters most on this screen. */}
                    <div className="text-2xs text-muted-foreground">
                      Earned, not counted — this is not the cash figure above
                    </div>
                  </div>
                  <Money value={t.todayProfit} direction="auto" showIcon={false} />
                </div>
              </CardContent>
            </Card>

            <Badge variant="outline" className="w-full justify-center py-1.5">
              {t.cashAccount.name} · {formatDate(t.date)}
            </Badge>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  direction = "neutral",
  sign,
  compact,
}: {
  label: string;
  value: number;
  direction?: "in" | "out" | "auto" | "neutral";
  sign?: string;
  compact?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between px-5 ${compact ? "py-2" : "py-2.5"}`}>
      <span className="text-sm text-muted-foreground">
        {sign ? <span className="mr-1.5 tabular text-muted-foreground/70">{sign}</span> : null}
        {label}
      </span>
      <Money value={value} direction={direction} showIcon={false} size={compact ? "sm" : "md"} />
    </div>
  );
}
