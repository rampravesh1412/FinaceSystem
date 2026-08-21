import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Money, type MoneyDirection } from "@/components/money";
import { ValueChange } from "@/components/motion";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * A dashboard metric tile (§31, §47).
 *
 * `to` makes the whole card a link, because §47 requires every card to drill through to
 * the view that explains it — a number an operator cannot interrogate is decoration.
 */
export interface StatCardProps {
  label: string;
  value: number | null | undefined;
  direction?: MoneyDirection;
  icon?: LucideIcon;
  /** Percentage change against the comparison period. */
  delta?: number | null;
  deltaLabel?: string;
  /** Drill-through target. */
  to?: string;
  loading?: boolean;
  /** For counts rather than amounts (pending approvals, unreconciled items). */
  asCount?: boolean;
  className?: string;
}

export function StatCard({
  label, value, direction = "neutral", icon: Icon,
  delta, deltaLabel, to, loading, asCount, className,
}: StatCardProps) {
  const body = (
    <div
      className={cn(
        "group relative flex h-full flex-col justify-between gap-4 rounded-lg border border-border bg-card p-4 shadow-subtle transition-all",
        to && "hover:-translate-y-px hover:border-accent/40 hover:shadow-card",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden /> : null}
      </div>

      <div className="space-y-1">
        {loading ? (
          <Skeleton className="h-7 w-32" />
        ) : (
          /* A tile refetches on a branch switch or after a posting. The flash says "this
             number just moved" without ever displaying an amount that was not true — see
             the note on ValueChange about why it does not count up. */
          <ValueChange value={String(value ?? 0)} className="inline-block rounded px-1 -mx-1">
            {asCount ? (
              <span className="tabular text-2xl font-semibold tracking-tight">{value ?? 0}</span>
            ) : (
              <Money value={value} direction={direction} size="xl" showIcon={false} />
            )}
          </ValueChange>
        )}

        {delta !== undefined && delta !== null && !loading ? (
          <div className="flex items-center gap-1 text-xs">
            {delta >= 0 ? (
              <TrendingUp className="size-3.5 text-success" aria-hidden />
            ) : (
              <TrendingDown className="size-3.5 text-destructive" aria-hidden />
            )}
            <span className={cn("tabular font-medium", delta >= 0 ? "text-success" : "text-destructive")}>
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(1)}%
            </span>
            {deltaLabel ? <span className="text-muted-foreground">{deltaLabel}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (!to) return body;
  return (
    <Link to={to} className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
      {body}
    </Link>
  );
}
