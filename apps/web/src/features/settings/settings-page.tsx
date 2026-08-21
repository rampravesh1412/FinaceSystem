import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  Building2, ClipboardCheck, Info, Lock, Plus, Save, Settings as SettingsIcon,
  ShieldCheck, Trash2, TriangleAlert,
} from "lucide-react";
import {
  fiscalYearLabel,
  formatINR,
  organisationProfileSchema,
  parseAmount,
  type ApprovalSettings,
  type ApprovalTier,
  type OrganisationProfile,
  type OrganisationSettings,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { useAuth } from "@/features/auth/auth-context";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Settings (§35, §27).
 *
 * Two things live here, and they are not the same kind of thing. The organisation profile
 * is provenance — the name printed on every export. The approval thresholds are a CONTROL:
 * they decide what money can move without a second signature, so the editor states the
 * consequence of every band in plain words rather than leaving an operator to read a table
 * of paise and infer it.
 */
export function SettingsPage() {
  const { can, user } = useAuth();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Organisation details and the approval control. Every change here is audited."
      />

      <Tabs defaultValue="organisation">
        <TabsList>
          <TabsTrigger value="organisation">
            <Building2 className="mr-1.5 size-3.5" />
            Organisation
          </TabsTrigger>
          <TabsTrigger value="approvals">
            <ClipboardCheck className="mr-1.5 size-3.5" />
            Approvals
          </TabsTrigger>
          <TabsTrigger value="system">
            <SettingsIcon className="mr-1.5 size-3.5" />
            System
          </TabsTrigger>
        </TabsList>

        <TabsContent value="organisation">
          <OrganisationPanel canManage={can("settings.manage")} />
        </TabsContent>
        <TabsContent value="approvals">
          {/* Guarded by super-admin on the server, not by a named permission: a branch
              admin could otherwise lower the threshold above their own signing limit. */}
          <ApprovalPanel canManage={Boolean(user?.isSuperAdmin)} />
        </TabsContent>
        <TabsContent value="system">
          <SystemPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── Organisation ────────────────────────────────────────────────────────── */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function OrganisationPanel({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["settings", "organisation"],
    queryFn: () => api.get<OrganisationSettings>("/settings/organisation"),
  });

  const form = useForm<OrganisationProfile>({
    resolver: zodResolver(organisationProfileSchema),
    values: query.data?.profile,
  });

  const mutation = useMutation({
    mutationFn: (values: OrganisationProfile) =>
      api.put<OrganisationSettings>("/settings/organisation", values),
    onSuccess: async (data) => {
      toast.success("Organisation details saved", {
        description: "Exports generated from now on carry this name.",
      });
      form.reset(data.profile);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        for (const fe of error.fieldErrors) {
          form.setError(fe.field as keyof OrganisationProfile, { message: fe.message });
        }
        toast.error(error.message);
        return;
      }
      toast.error("Could not save the organisation details.");
    },
  });

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError) {
    return (
      <Card>
        <EmptyState
          icon={Building2}
          title="Could not load settings"
          description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
        />
      </Card>
    );
  }

  const settings = query.data;
  const fiscalMonth = form.watch("fiscalStartMonth") ?? 4;

  return (
    <form onSubmit={form.handleSubmit((values) => mutation.mutate(values))} className="space-y-4">
      <Card className="space-y-4 p-4">
        <SectionHeading
          title="Identity"
          description="Printed on every exported report, so a PDF that has left the building still says who produced it."
        />

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Legal name" error={form.formState.errors.legalName?.message} required>
            <Input {...form.register("legalName")} disabled={!canManage} />
          </Field>
          <Field
            label="Display name"
            hint="Shown on exports when set — a short trading name rather than the registered one."
            error={form.formState.errors.displayName?.message}
          >
            <Input {...form.register("displayName")} disabled={!canManage} />
          </Field>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="GSTIN" error={form.formState.errors.gstin?.message}>
            <Input {...form.register("gstin")} placeholder="10ABCDE1234F1Z5" className="uppercase" disabled={!canManage} />
          </Field>
          <Field label="PAN" error={form.formState.errors.pan?.message}>
            <Input {...form.register("pan")} placeholder="ABCDE1234F" className="uppercase" disabled={!canManage} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <SectionHeading title="Address & contact" />

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Address line 1" error={form.formState.errors.addressLine1?.message}>
            <Input {...form.register("addressLine1")} disabled={!canManage} />
          </Field>
          <Field label="Address line 2" error={form.formState.errors.addressLine2?.message}>
            <Input {...form.register("addressLine2")} disabled={!canManage} />
          </Field>
          <Field label="City" error={form.formState.errors.city?.message}>
            <Input {...form.register("city")} disabled={!canManage} />
          </Field>
          <Field label="State" error={form.formState.errors.state?.message}>
            <Input {...form.register("state")} disabled={!canManage} />
          </Field>
          <Field label="PIN code" error={form.formState.errors.pincode?.message}>
            <Input {...form.register("pincode")} inputMode="numeric" maxLength={6} disabled={!canManage} />
          </Field>
          <Field label="Phone" error={form.formState.errors.phone?.message}>
            <Input {...form.register("phone")} disabled={!canManage} />
          </Field>
          <Field label="Email" error={form.formState.errors.email?.message}>
            <Input {...form.register("email")} type="email" disabled={!canManage} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <SectionHeading
          title="Fiscal year"
          description="Decides which year every transaction belongs to — its voucher number, the period that locks it, and every year-to-date figure."
        />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full max-w-xs space-y-1.5">
            <Label htmlFor="fiscalStartMonth">Year starts in</Label>
            <Select
              value={String(fiscalMonth)}
              onValueChange={(v) => form.setValue("fiscalStartMonth", Number(v), { shouldDirty: true })}
              disabled={!canManage || !settings.fiscalStartMonthEditable}
            >
              <SelectTrigger id="fiscalStartMonth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((month, i) => (
                  <SelectItem key={month} value={String(i + 1)}>
                    {month}
                    {i + 1 === 4 ? " (Indian default)" : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="pb-2 text-xs text-muted-foreground">
            Today falls in{" "}
            <span className="font-medium text-foreground">
              FY {fiscalYearLabel(fiscalYearFor(new Date(), fiscalMonth), fiscalMonth)}
            </span>
          </p>
        </div>

        {/* Not disabled-and-silent: the reason is the whole point, and an operator who
            cannot see it will file a bug instead. */}
        {!settings.fiscalStartMonthEditable ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">{settings.fiscalLockReason}</span>
          </p>
        ) : null}
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        {canManage ? (
          <Button type="submit" variant="accent" loading={mutation.isPending} disabled={!form.formState.isDirty}>
            <Save />
            Save changes
          </Button>
        ) : (
          <ReadOnlyNotice reason="Your role does not include settings.manage. The server refuses the change too — this is not just a hidden button." />
        )}

        {settings.updatedAt ? (
          <span className="text-xs text-muted-foreground">
            Last changed {relativeTime(settings.updatedAt)}
            {settings.updatedBy ? ` by ${settings.updatedBy}` : ""}
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** Local mirror of the shared helper — the shared one takes a Date and a start month. */
function fiscalYearFor(date: Date, startMonth: number): number {
  const year = date.getUTCFullYear();
  return date.getUTCMonth() + 1 >= startMonth ? year : year - 1;
}

/* ── Approvals ───────────────────────────────────────────────────────────── */

interface ApprovalSettingsResponse {
  settings: ApprovalSettings;
  suggestedTiers: ApprovalTier[];
}

/**
 * The approval threshold editor (§27).
 *
 * Bands are edited in RUPEES and stored as paise, converted once on submit through the
 * shared parser. Every band states its consequence — "₹5,00,001 and above needs a Super
 * Admin" — because a table of numbers does not tell an administrator what they have just
 * authorised without a signature.
 */
function ApprovalPanel({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["approvals", "settings"],
    queryFn: () => api.get<ApprovalSettingsResponse>("/approvals/settings"),
  });

  const [draft, setDraft] = React.useState<ApprovalSettings | null>(null);
  const settings = draft ?? query.data?.settings ?? null;

  const mutation = useMutation({
    mutationFn: (values: ApprovalSettings) => api.put<ApprovalSettings>("/approvals/settings", values),
    onSuccess: async () => {
      toast.success("Approval thresholds updated", {
        description: "New transactions are measured against these bands from now on.",
      });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not save the thresholds.");
    },
  });

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError || !settings) {
    return (
      <Card>
        <EmptyState
          icon={ClipboardCheck}
          title="Could not load approval settings"
          description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
        />
      </Card>
    );
  }

  const patch = (next: Partial<ApprovalSettings>) => setDraft({ ...settings, ...next });

  const setTier = (index: number, next: Partial<ApprovalTier>) => {
    const tiers = settings.tiers.map((t, i) => (i === index ? { ...t, ...next } : t));
    patch({ tiers });
  };

  const addTier = () => {
    const last = settings.tiers.at(-1);
    const from = last?.to !== null && last?.to !== undefined ? last.to + 1 : 0;
    // The new band takes the open end and the previous one gets a ceiling, so the ladder
    // stays valid as it is built rather than only at submit time.
    const tiers: ApprovalTier[] = settings.tiers.map((t, i) =>
      i === settings.tiers.length - 1 && t.to === null ? { ...t, to: from + 5_00_000_00 } : t,
    );
    patch({
      tiers: [
        ...tiers,
        { from: tiers.at(-1)?.to !== undefined && tiers.at(-1)!.to !== null ? tiers.at(-1)!.to! + 1 : from, to: null, tier: "SUPER_ADMIN" },
      ],
    });
  };

  const removeTier = (index: number) => {
    const tiers = settings.tiers.filter((_, i) => i !== index);
    // Whatever is left must still end open-ended, or amounts above the top band would
    // need no approval at all — the exact hole the control exists to close.
    if (tiers.length > 0) tiers[tiers.length - 1] = { ...tiers.at(-1)!, to: null };
    patch({ tiers });
  };

  const dirty = draft !== null;
  const openEnded = settings.tiers.length === 0 || settings.tiers.at(-1)!.to === null;

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <SectionHeading
            title="Require approval before money moves"
            description="A held transaction writes NO ledger entries — nothing moves until somebody signs it off, and nothing has to be reversed if they refuse."
          />
          <Switch
            checked={settings.enabled}
            onCheckedChange={(v) => patch({ enabled: v })}
            disabled={!canManage}
            aria-label="Require approval"
          />
        </div>

        {!settings.enabled ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Approval is off. Every transaction posts immediately, whatever its size.
          </p>
        ) : null}
      </Card>

      {settings.enabled ? (
        <>
          <Card className="space-y-4 p-4">
            <SectionHeading
              title="Floor"
              description="Below this, nothing needs approval regardless of the bands — it keeps a day of small cash receipts out of the queue."
            />
            <div className="w-full max-w-xs space-y-1.5">
              <Label htmlFor="minimumAmount">Ignore anything under</Label>
              <RupeeInput
                id="minimumAmount"
                paise={settings.minimumAmount}
                onChange={(paise) => patch({ minimumAmount: paise })}
                disabled={!canManage}
              />
            </div>
          </Card>

          <Card className="space-y-4 p-4">
            <SectionHeading
              title="Bands"
              description="Who has to sign off, by amount. Bands must ascend and the highest must be open-ended."
            />

            {settings.tiers.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  No bands yet. Approval is on but nothing is routed anywhere.
                </p>
                {canManage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => patch({ tiers: query.data!.suggestedTiers })}
                  >
                    Use the suggested bands
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                {settings.tiers.map((tier, index) => (
                  <div
                    key={index}
                    className="flex flex-col gap-3 rounded-md border border-border bg-surface-muted/30 p-3 lg:flex-row lg:items-end"
                  >
                    <div className="space-y-1.5">
                      <Label className="text-2xs">From</Label>
                      <RupeeInput
                        paise={tier.from}
                        onChange={(paise) => setTier(index, { from: paise })}
                        disabled={!canManage}
                        className="w-36"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-2xs">To</Label>
                      {tier.to === null ? (
                        <div className="flex h-9 w-36 items-center rounded-md border border-input bg-surface-muted px-3 text-sm text-muted-foreground">
                          and above
                        </div>
                      ) : (
                        <RupeeInput
                          paise={tier.to}
                          onChange={(paise) => setTier(index, { to: paise })}
                          disabled={!canManage}
                          className="w-36"
                        />
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-2xs">Signed off by</Label>
                      <Select
                        value={tier.tier}
                        onValueChange={(v) => setTier(index, { tier: v as ApprovalTier["tier"] })}
                        disabled={!canManage}
                      >
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="BRANCH_ADMIN">Branch Admin</SelectItem>
                          <SelectItem value="SUPER_ADMIN">Super Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* The band restated as a sentence. This is what an administrator is
                        actually deciding, and it is not legible from three number fields. */}
                    <p className="flex-1 pb-2 text-xs text-muted-foreground">
                      {formatINR(tier.from)}
                      {tier.to === null ? " and above" : ` to ${formatINR(tier.to)}`} needs a{" "}
                      <span className="font-medium text-foreground">
                        {tier.tier === "SUPER_ADMIN" ? "Super Admin" : "Branch Admin"}
                      </span>
                      .
                    </p>

                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeTier(index)}
                        aria-label={`Remove band ${index + 1}`}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </div>
                ))}

                {canManage ? (
                  <Button variant="outline" size="sm" onClick={addTier}>
                    <Plus />
                    Add a band
                  </Button>
                ) : null}
              </div>
            )}

            {!openEnded ? (
              <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                <span>
                  The highest band has a ceiling, so an amount above it would need no approval at
                  all — the exact gap this control exists to close. The server will refuse to save
                  this.
                </span>
              </p>
            ) : null}
          </Card>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {canManage ? (
          <>
            <Button
              variant="accent"
              loading={mutation.isPending}
              disabled={!dirty}
              onClick={() => mutation.mutate(settings)}
            >
              <Save />
              Save thresholds
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={mutation.isPending}>
                Discard
              </Button>
            ) : null}
          </>
        ) : (
          <ReadOnlyNotice reason="Only a Super Admin can change who must approve what — otherwise a branch admin could lower the threshold above their own signing limit." />
        )}
      </div>
    </div>
  );
}

/* ── System ──────────────────────────────────────────────────────────────── */

interface SystemSummary {
  users: number;
  activeUsers: number;
  ledgerEntries: number;
  oldestEntry: string | null;
  newestEntry: string | null;
}

function SystemPanel() {
  const query = useQuery({
    queryKey: ["settings", "system"],
    queryFn: () => api.get<SystemSummary>("/settings/system"),
  });

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError) {
    return (
      <Card>
        <EmptyState
          icon={SettingsIcon}
          title="Could not load the system summary"
          description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
        />
      </Card>
    );
  }

  const s = query.data;
  const dateOnly = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN") : "—");

  return (
    <Card className="space-y-4 p-4">
      <SectionHeading
        title="What is in the system"
        description="Counts, not calculations. Whether the books balance is the trial balance's question, and asking it in two places invites two answers."
      />

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Users" value={String(s.users)} note={`${s.activeUsers} active`} />
        <Stat label="Ledger entries" value={s.ledgerEntries.toLocaleString("en-IN")} />
        <Stat label="Oldest entry" value={dateOnly(s.oldestEntry)} />
        <Stat label="Newest entry" value={dateOnly(s.newestEntry)} />
      </dl>

      <Separator />

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Ledger entries are append-only. Nothing on this screen, or anywhere else in the
        application, can edit or delete one — a correction is a reversal, which leaves both
        the original and its mirror on the record.
      </p>
    </Card>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────────── */

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function Field({
  label, hint, error, required, children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * An amount field that edits rupees and reports paise.
 *
 * Local text state so a half-typed "1,00," is not thrown away by a parse that fails
 * mid-keystroke; the paise value only moves when the text actually parses.
 */
function RupeeInput({
  id, paise, onChange, disabled, className,
}: {
  id?: string;
  paise: number;
  onChange: (paise: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = React.useState(() => (paise / 100).toString());
  const [focused, setFocused] = React.useState(false);

  // Follow the model while the field is not being typed into.
  React.useEffect(() => {
    if (!focused) setText((paise / 100).toString());
  }, [paise, focused]);

  return (
    <Input
      id={id}
      inputMode="decimal"
      className={`tabular ${className ?? ""}`}
      value={text}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(parseAmount(e.target.value));
        } catch {
          /* not a number yet — the model keeps its last good value */
        }
      }}
    />
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted/40 p-3">
      <dt className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="tabular text-xl font-semibold">{value}</dd>
      {note ? <dd className="text-2xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function ReadOnlyNotice({ reason }: { reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline">
          <Lock className="size-3" />
          Read only
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
