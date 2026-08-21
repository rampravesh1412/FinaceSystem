import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCompactINR, formatINR } from "@amiri/shared";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

/**
 * Chart primitives.
 *
 * COLOUR IS ASSIGNED BY THE JOB THE DATA DOES, not by taste:
 *
 *   Two named series (income vs expenses, money in vs money out) — CATEGORICAL.
 *   Slots 1 and 2 of the validated order: blue and orange. Deliberately NOT green
 *   and red: those are reserved status colours, and a green/red pair is the single
 *   worst choice for a red-green colour-blind reader, who is ~8% of men.
 *
 *   Aging buckets — ORDINAL. One hue, light to dark, because "older" is a magnitude
 *   along a scale rather than four unrelated identities.
 *
 *   Expense breakdown — SEQUENTIAL. One hue; the categories are ranked by size and
 *   their identity is carried by the axis label, not by eight competing hues.
 *
 * Both palettes were run through the validator in light and dark mode: every check
 * passes, worst adjacent CVD ΔE 24.7 light / 26.8 dark against a ≥8 target.
 *
 * Dark mode is a SELECTED set of steps for the dark surface, not an inversion.
 */

/* ── Palette ─────────────────────────────────────────────────────────────── */

export const SERIES = {
  /** Categorical slot 1 — the "positive" series: income, money in. */
  primary: { light: "#2a78d6", dark: "#3987e5" },
  /** Categorical slot 2 — the contrasting series: expenses, money out. */
  secondary: { light: "#eb6834", dark: "#d95926" },
} as const;

/** Ordinal blue ramp for the aging buckets, light→dark = newer→older. */
export const ORDINAL = {
  light: ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"],
  dark: ["#cde2fb", "#86b6ef", "#3987e5", "#184f95"],
} as const;

function useIsDark(): boolean {
  const [dark, setDark] = React.useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );

  React.useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

/* ── Tooltip ─────────────────────────────────────────────────────────────── */

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
  dataKey: string;
}

/**
 * Shared tooltip.
 *
 * The label text stays in ink colours; only the small swatch carries the series
 * colour. Text wearing the series colour is unreadable at small sizes and fails
 * contrast against the surface.
 */
function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  labelFormatter?: (v: string) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-raised">
      <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        {labelFormatter && label ? labelFormatter(label) : label}
      </div>
      <ul className="space-y-0.5">
        {payload.map((entry) => (
          <li key={entry.dataKey} className="flex items-center gap-2 text-sm">
            <span
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: entry.color }}
              aria-hidden
            />
            <span className="text-muted-foreground">{entry.name}</span>
            <span className="tabular ml-auto font-medium text-foreground">
              {formatINR(entry.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Two-series trend ────────────────────────────────────────────────────── */

export interface TrendSeries {
  key: string;
  label: string;
  slot: "primary" | "secondary";
}

/**
 * Two named series over time.
 *
 * ONE axis, always. A dual-axis chart lets any two series be made to look
 * correlated by choosing the scales, which is why it is never used here — if two
 * measures need different scales they get two charts.
 */
export function TrendChart<T extends { date: string }>({
  data,
  series,
  height = 240,
  emptyLabel = "No activity in this period",
}: {
  /**
   * Any row carrying a `date` plus the numeric keys named in `series`.
   *
   * Generic rather than an index-signature type: callers keep their precise row type
   * (`DashboardTrendPoint`), which would otherwise have to be widened just to satisfy
   * this prop.
   */
  data: readonly T[];
  series: TrendSeries[];
  height?: number;
  emptyLabel?: string;
}) {
  const isDark = useIsDark();
  const mode = isDark ? "dark" : "light";

  const hasData = data.some((d) => series.some((s) => Number((d as Record<string, unknown>)[s.key] ?? 0) !== 0));
  if (!hasData) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <>
      {/* A legend is always present for two or more series, so identity is never
          carried by colour alone. */}
      <ul className="mb-3 flex flex-wrap items-center gap-4">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className="size-2.5 rounded-[2px]"
              style={{ backgroundColor: SERIES[s.slot][mode] }}
              aria-hidden
            />
            {s.label}
          </li>
        ))}
      </ul>

      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data as unknown[]} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES[s.slot][mode]} stopOpacity={0.18} />
                <stop offset="100%" stopColor={SERIES[s.slot][mode]} stopOpacity={0.01} />
              </linearGradient>
            ))}
          </defs>

          {/* Recessive grid: horizontal only, so it guides the eye to values without
              competing with the data. */}
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="hsl(var(--border))"
            strokeOpacity={0.6}
          />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => formatDate(v).slice(0, 6)}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v: number) => formatCompactINR(v)}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip
            content={<ChartTooltip labelFormatter={(v) => formatDate(v)} />}
            cursor={{ stroke: "hsl(var(--muted-foreground))", strokeOpacity: 0.35, strokeWidth: 1 }}
          />

          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={SERIES[s.slot][mode]}
              // 2px lines — thin marks read as data, thick ones read as decoration.
              strokeWidth={2}
              fill={`url(#fill-${s.key})`}
              // Markers appear on hover only; a dot on every point of a 30-day series
              // is noise.
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--background))" }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </>
  );
}

/* ── Ranked horizontal bars ──────────────────────────────────────────────── */

/**
 * Magnitude comparison, ranked.
 *
 * Horizontal because the category names are long ("Panel Expense", "Bank Charges")
 * and rotated x-labels are unreadable. One hue: these are ranked magnitudes, and
 * the identity lives in the axis label rather than in eight competing colours.
 */
export function RankedBarChart({
  data,
  height = 240,
  emptyLabel = "Nothing recorded in this period",
}: {
  data: Array<{ name: string; amount: number }>;
  height?: number;
  emptyLabel?: string;
}) {
  const isDark = useIsDark();
  const mode = isDark ? "dark" : "light";

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        {emptyLabel}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(height, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
        <XAxis
          type="number"
          tickFormatter={(v: number) => formatCompactINR(v)}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          width={130}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted-foreground))", fillOpacity: 0.06 }} />
        <Bar dataKey="amount" name="Amount" fill={SERIES.primary[mode]} radius={[0, 4, 4, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Ordinal buckets ─────────────────────────────────────────────────────── */

/**
 * Aging buckets (§12).
 *
 * An ORDINAL ramp, not four categorical hues: 0–30 through 90+ is one ordered
 * scale, and light→dark carries "older" far more directly than four unrelated
 * colours would. The bucket label states the age in words, so the ordering never
 * depends on the reader perceiving the ramp.
 */
export function BucketChart({
  buckets,
  labels,
  onSelect,
  selected,
}: {
  buckets: number[];
  labels: string[];
  onSelect?: (index: number) => void;
  selected?: number;
}) {
  const isDark = useIsDark();
  const ramp = ORDINAL[isDark ? "dark" : "light"];
  const total = buckets.reduce((a, b) => a + b, 0);

  if (total === 0) {
    return <div className="py-6 text-center text-sm text-muted-foreground">Nothing outstanding</div>;
  }

  return (
    <div className="space-y-2">
      {/* A single stacked bar reads as parts of one whole, which is what these are. */}
      <div className="flex h-3 w-full overflow-hidden rounded-full" role="img" aria-label="Outstanding by age">
        {buckets.map((value, i) =>
          value > 0 ? (
            <div
              key={labels[i]}
              // A 2px surface gap between segments so adjacent fills never touch.
              className="border-r-2 border-card last:border-r-0"
              style={{ width: `${(value / total) * 100}%`, backgroundColor: ramp[i] }}
              title={`${labels[i]}: ${formatINR(value)}`}
            />
          ) : null,
        )}
      </div>

      <ul className="grid gap-1.5 sm:grid-cols-2">
        {buckets.map((value, i) => (
          <li key={labels[i]}>
            <button
              type="button"
              onClick={() => onSelect?.(i)}
              disabled={!onSelect}
              aria-pressed={selected === i}
              className={cn(
                "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors",
                onSelect && "hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected === i && "bg-accent/10",
              )}
            >
              <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: ramp[i] }} aria-hidden />
              <span className="text-muted-foreground">{labels[i]}</span>
              <span className="tabular ml-auto font-medium text-foreground">{formatINR(value)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Branch comparison ───────────────────────────────────────────────────── */

/** Profit by branch. One hue; a negative bar is tinted with the contrasting slot so
 *  a loss is not distinguishable by position alone. */
export function BranchProfitChart({
  data,
  height = 220,
}: {
  data: Array<{ code: string; profit: number }>;
  height?: number;
}) {
  const isDark = useIsDark();
  const mode = isDark ? "dark" : "light";

  if (data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
        <XAxis
          dataKey="code"
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={(v: number) => formatCompactINR(v)}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted-foreground))", fillOpacity: 0.06 }} />
        <Bar dataKey="profit" name="Profit" radius={[4, 4, 0, 0]} maxBarSize={40}>
          {data.map((entry) => (
            <Cell
              key={entry.code}
              fill={entry.profit >= 0 ? SERIES.primary[mode] : SERIES.secondary[mode]}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
