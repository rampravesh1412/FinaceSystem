import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArrowLeftRight, Calculator, MoreHorizontal, Pencil, Percent, RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import {
  formatINR, parseAmount,
  type ChargeBreakdown, type ChargeRuleSummary, type ChargeTier,
} from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { Can } from "@/features/auth/auth-context";
import { NewChargeRuleButton } from "./charge-form";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Charges & commission (§18).
 *
 * The screen's job is to make a rate CONCRETE. A rule that reads "1.75%, min ₹50, max
 * ₹5,000, tiered" is not something anyone can evaluate in their head, so every row carries
 * a worked example on ₹1,00,000, and the calculator at the top runs any amount through
 * every active rule at once.
 *
 * Rates are basis points throughout — 1.75% is 175, exactly. The percent shown here is
 * rendered from the integer; nothing on this page stores or sends a float.
 */
export function ChargesPage() {
  const query = useQuery({
    queryKey: ["charge-rules"],
    queryFn: () => api.get<ChargeRuleSummary[]>(`/charges${qs({ limit: 200 })}`),
  });

  const rules = query.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Charges & Commission"
        description="Every rule shows what it does to ₹1,00,000. Gross, charge and net stay three separate figures — a charge never silently rewrites an amount."
        actions={
          <Can permission="finance.charges.manage">
            <NewChargeRuleButton />
          </Can>
        }
      />

      {rules.length > 0 ? <ChargeCalculator rules={rules} /> : null}

      <Card className="overflow-hidden">
        {query.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={Percent}
            title="Could not load charge rules"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          />
        ) : rules.length === 0 ? (
          <EmptyState
            icon={Percent}
            title="No charge rules yet"
            description="A charge rule turns a rate into a posting. Until one exists, every transaction is recorded at its gross amount with no commission."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rule</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead className="hidden lg:table-cell">Bounds</TableHead>
                <TableHead>Borne by</TableHead>
                <TableHead className="hidden xl:table-cell">Applies to</TableHead>
                <TableHead className="text-right">On ₹1,00,000</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="screen-only w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div className="text-sm font-medium">{rule.name}</div>
                    <div className="font-mono text-2xs text-muted-foreground">{rule.code}</div>
                  </TableCell>
                  <TableCell className="text-sm"><RateCell rule={rule} /></TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {rule.minCharge || rule.maxCharge ? (
                      <>
                        {rule.minCharge ? <>min {formatINR(rule.minCharge)}</> : null}
                        {rule.minCharge && rule.maxCharge ? " · " : null}
                        {rule.maxCharge ? <>max {formatINR(rule.maxCharge)}</> : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {/* Who bears it decides which side of the ledger it lands on, so it is
                        spelled out rather than left as an enum. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {/* The arrangement, not just the bearer — "Us" alone does not
                            distinguish ₹1,00,000 leaving from ₹1,01,500 leaving. */}
                        <Badge variant={rule.bearer === "SELF" ? "outline" : "default"}>
                          {rule.bearer === "PARTY"
                            ? "The party"
                            : rule.deductFromAmount
                              ? "Us · from the amount"
                              : "Us · on top"}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        {rule.bearer === "PARTY"
                          ? "Our income. On a ₹1,00,000 payment out, ₹98,500 leaves the bank and their full ₹1,00,000 claim is discharged — the ₹1,500 you keep is the commission."
                          : rule.deductFromAmount
                            ? "Our expense, taken out of the amount. On a ₹1,00,000 payment out the whole ₹1,00,000 leaves the bank, only ₹98,500 reaches them, and the ₹1,500 is your cost."
                            : "Our expense, levied on top. On a ₹1,00,000 payment out, ₹1,01,500 leaves the bank and they receive the full ₹1,00,000."}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {rule.appliesTo.length === 0 ? (
                        <span className="text-xs text-muted-foreground">Any transaction</span>
                      ) : (
                        rule.appliesTo.map((t) => (
                          <Badge key={t} variant="outline" className="text-2xs">
                            {t.replace(/_/g, " ").toLowerCase()}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={rule.sampleOn100k} showIcon={false} />
                    {rule.chargeAccount ? (
                      <div className="truncate text-2xs text-muted-foreground">
                        to {rule.chargeAccount.name}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={rule.status === "ACTIVE" ? "success" : "outline"}>
                      {rule.status === "ACTIVE" ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="screen-only text-right">
                    <Can permission="finance.charges.manage">
                      <RuleActions rule={rule} />
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ── The calculator ──────────────────────────────────────────────────────── */

/**
 * Run one amount through every active rule.
 *
 * The charge itself is computed SERVER-SIDE via `/charges/preview` — the same code path
 * that posts it. Re-implementing tiered lookup, floors and ceilings in the browser would
 * give an operator a figure that could differ from the one that actually posts, which is
 * the specific failure this screen exists to prevent.
 */
function ChargeCalculator({ rules }: { rules: ChargeRuleSummary[] }) {
  const [amount, setAmount] = React.useState("1,00,000");

  const paise = React.useMemo(() => {
    try {
      return parseAmount(amount);
    } catch {
      return null;
    }
  }, [amount]);

  const active = rules.filter((r) => r.status === "ACTIVE");

  const preview = useQuery({
    queryKey: ["charge-preview", paise, active.map((r) => r.id)],
    queryFn: async () => {
      return Promise.all(
        active.map((rule) =>
          api
            .post<ChargeBreakdown>("/charges/preview", { chargeRuleId: rule.id, amount: paise })
            .then((breakdown) => ({ rule, breakdown }))
            // One bad rule must not blank the whole panel — it reports itself instead.
            .catch(() => ({ rule, breakdown: null })),
        ),
      );
    },
    enabled: paise !== null && paise > 0 && active.length > 0,
    placeholderData: (prev) => prev,
  });

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="w-full max-w-xs space-y-1.5">
          <Label htmlFor="calc-amount" className="flex items-center gap-1.5">
            <Calculator className="size-3.5" aria-hidden />
            Try an amount
          </Label>
          <Input
            id="calc-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="tabular"
          />
          {paise === null && amount.trim() ? (
            <p className="text-xs text-destructive">That is not an amount.</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Charges are computed by the server — the same code that posts them.
            </p>
          )}
        </div>

        <div className="flex-1">
          {paise === null || paise <= 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Enter an amount to see what each active rule would charge.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {(preview.data ?? []).map(({ rule, breakdown }) => (
                <div key={rule.id} className="rounded-md border border-border bg-surface-muted/40 p-3">
                  <div className="truncate text-xs font-medium">{rule.name}</div>
                  {breakdown === null ? (
                    <p className="mt-1 text-xs text-destructive">This rule could not be applied.</p>
                  ) : (
                    <>
                      {/* The server's own words for how it got there — "1.75% of ₹1,00,000",
                          "Tier 2: 1.5%" — so a tiered rule is not a black box. */}
                      <div className="truncate text-2xs text-muted-foreground">{breakdown.basis}</div>
                      {/* Gross / charge / net, always all three — §18 forbids showing only
                          the net and leaving the operator to reverse-engineer the rest. */}
                      <dl className="mt-1.5 space-y-0.5 text-xs">
                        <Row label="Gross" value={breakdown.gross} />
                        <Row label="Charge" value={breakdown.charge} muted />
                        <Row label="Net" value={breakdown.net} bold />
                      </dl>
                    </>
                  )}
                </div>
              ))}
              {preview.isPending && !preview.data ? (
                <>
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Row({
  label, value, muted, bold,
}: { label: string; value: number; muted?: boolean; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Money
          value={value}
          showIcon={false}
          size="sm"
          className={muted ? "text-muted-foreground" : bold ? "font-semibold" : undefined}
        />
      </dd>
    </div>
  );
}

/* ── Rate rendering ──────────────────────────────────────────────────────── */

/** Basis points → a percent string, without ever creating a float the system stores. */
function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return fraction === 0
    ? `${whole}%`
    : `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}%`;
}

function RateCell({ rule }: { rule: ChargeRuleSummary }) {
  if (rule.type === "PERCENTAGE") {
    return (
      <span className="tabular">
        {rule.rateBps !== undefined ? bpsToPercent(rule.rateBps) : "—"}
      </span>
    );
  }

  if (rule.type === "FIXED") {
    return <Money value={rule.fixedAmount ?? 0} showIcon={false} size="sm" />;
  }

  const tiers = rule.tiers ?? [];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline">
          {tiers.length} band{tiers.length === 1 ? "" : "s"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <ul className="space-y-0.5 text-xs">
          {tiers.map((tier: ChargeTier, i) => (
            <li key={i} className="tabular">
              {tier.upTo === null ? "above the last band" : `up to ${formatINR(tier.upTo)}`} —{" "}
              {tier.rateBps !== undefined
                ? bpsToPercent(tier.rateBps)
                : formatINR(tier.fixedAmount ?? 0)}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/* ── Editing a rule ──────────────────────────────────────────────────────── */

/**
 * Change the bearer, the rate, or retire the rule.
 *
 * The bearer is the reason this exists. It decides whether a charge is deducted from what
 * the party receives or paid on top of it, which on a ₹1,00,000 payout at 1.5% is a
 * ₹3,000 difference — and until now a rule set the wrong way could not be corrected at
 * all, only abandoned and replaced.
 *
 * Editing affects future postings only. Every transaction already posted froze its own
 * charge amount and its basis text, so last month's commission cannot be rewritten by
 * changing this month's rate. The dialog says so, because it is the first thing anybody
 * sensibly worries about before touching a rate.
 */
function RuleActions({ rule }: { rule: ChargeRuleSummary }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<ChargeRuleSummary>(`/charges/${rule.id}`, body),
    onSuccess: async (updated) => {
      toast.success(
        updated.status === "ACTIVE" ? `${updated.name} updated` : `${updated.name} retired`,
        { description: `On ₹1,00,000 it now charges ${formatINR(updated.sampleOn100k)}.` },
      );
      await queryClient.invalidateQueries({ queryKey: ["charge-rules"] });
      await queryClient.invalidateQueries({ queryKey: ["charge-preview"] });
      setEditing(false);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not update the rule."),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${rule.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Edit rule
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              mutation.mutate({
                bearer: rule.bearer === "SELF" ? "PARTY" : "SELF",
              })
            }
          >
            <ArrowLeftRight />
            {rule.bearer === "SELF" ? "Deduct from the party instead" : "We bear it instead"}
          </DropdownMenuItem>
          <DropdownMenuItem
            destructive={rule.status === "ACTIVE"}
            onSelect={() =>
              mutation.mutate({ status: rule.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })
            }
          >
            {rule.status === "ACTIVE" ? <Archive /> : <RotateCcw />}
            {rule.status === "ACTIVE" ? "Retire" : "Reactivate"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? (
        <EditRuleDialog
          rule={rule}
          saving={mutation.isPending}
          onSave={(body) => mutation.mutate(body)}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function EditRuleDialog({
  rule,
  saving,
  onSave,
  onClose,
}: {
  rule: ChargeRuleSummary;
  saving: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [name, setName] = React.useState(rule.name);
  const [bearer, setBearer] = React.useState(rule.bearer);
  const [rate, setRate] = React.useState(
    rule.rateBps !== undefined ? String(rule.rateBps / 100) : "",
  );

  const bps = Math.round(Number(rate.replace(/[^\d.]/g, "")) * 100);
  const validRate = rule.type !== "PERCENTAGE" || (Number.isFinite(bps) && bps > 0);
  // The worked example, on the amount the operator is actually arguing about.
  const on100k = Number.isFinite(bps) ? Math.round((100_000_00 * bps) / 10_000) : 0;

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {rule.code}</DialogTitle>
          <DialogDescription>
            Applies to future postings only. Everything already posted keeps the charge and
            the basis text it was given at the time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {rule.type === "PERCENTAGE" ? (
            <div className="space-y-1.5">
              <Label htmlFor="rule-rate">Rate (%)</Label>
              <Input
                id="rule-rate"
                inputMode="decimal"
                className="tabular"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="rule-bearer">Who bears it?</Label>
            <Select value={bearer} onValueChange={setBearer}>
              <SelectTrigger id="rule-bearer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PARTY">The party — deduct it from their payment</SelectItem>
                <SelectItem value="SELF">We do — pay it on top</SelectItem>
              </SelectContent>
            </Select>

            {/* The whole point of the screen, in money, on a payment out. */}
            <p className="rounded-md border border-border bg-surface-muted/40 p-2.5 text-2xs">
              On a ₹1,00,000 payment out at a {formatINR(on100k)} charge:{" "}
              {bearer === "PARTY" ? (
                <span className="font-medium text-foreground">
                  {formatINR(100_000_00 - on100k)} leaves the bank
                </span>
              ) : (
                <span className="font-medium text-warning-foreground">
                  {formatINR(100_000_00 + on100k)} leaves the bank
                </span>
              )}
              {bearer === "PARTY"
                ? " — the charge comes out of what they receive and is booked as our income."
                : " — the charge is paid on top and is booked as our expense."}{" "}
              Either way the party&rsquo;s ₹1,00,000 is fully discharged.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            loading={saving}
            disabled={name.trim().length < 2 || !validRate}
            onClick={() =>
              onSave({
                name: name.trim(),
                bearer,
                ...(rule.type === "PERCENTAGE" ? { rateBps: bps } : {}),
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
