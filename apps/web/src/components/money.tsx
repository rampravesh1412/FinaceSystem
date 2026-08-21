import { ArrowDownLeft, ArrowUpRight, Minus } from "lucide-react";
import { formatCompactINR, formatINR, type Paise } from "@amiri/shared";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The one and only way an amount is rendered.
 *
 * Three rules it exists to enforce:
 *
 * 1. **Never re-derive.** It formats the integer paise the server computed. No component
 *    divides by 100, and no component adds two amounts for display.
 *
 * 2. **Colour is never the only signal (§43).** Direction is carried by an arrow glyph
 *    and, where space allows, a text label. A red figure and a green figure must remain
 *    distinguishable to a colour-blind user, on a greyscale printout, and in a PDF.
 *
 * 3. **Tabular figures.** Digits are fixed-width so a column of amounts aligns to the
 *    decimal point, which is what makes a ledger scannable.
 */

export type MoneyDirection = "in" | "out" | "auto" | "neutral";

export interface MoneyProps {
  /** Integer paise. */
  value: Paise | number | null | undefined;
  /**
   * "in" renders as a receipt, "out" as a payment, "neutral" as a plain balance.
   * "auto" derives direction from the sign — right for a running balance, wrong for a
   * payment-out row where the amount is stored positive but means money leaving.
   */
  direction?: MoneyDirection;
  /** Show the ↑ / ↓ glyph. Default true whenever the direction is not neutral. */
  showIcon?: boolean;
  /** Add a "Money In" / "Money Out" text label — used in detail views, not dense tables. */
  showLabel?: boolean;
  /** Compact tiles: ₹9.50 L, with the exact figure in a tooltip. */
  compact?: boolean;
  /** Hide the paise. Only for headline tiles, never for a ledger line. */
  hideDecimals?: boolean;
  /** Accounting-style negatives: (9,50,000.00). */
  parens?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeClasses: Record<NonNullable<MoneyProps["size"]>, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-lg font-semibold",
  xl: "text-2xl font-semibold tracking-tight",
};

function resolveDirection(value: number, direction: MoneyDirection): "in" | "out" | "neutral" {
  if (direction === "auto") return value > 0 ? "in" : value < 0 ? "out" : "neutral";
  return direction === "neutral" ? "neutral" : direction;
}

export function Money({
  value,
  direction = "neutral",
  showIcon,
  showLabel = false,
  compact = false,
  hideDecimals = false,
  parens = false,
  size = "md",
  className,
}: MoneyProps) {
  if (value === null || value === undefined) {
    return <span className={cn("tabular text-muted-foreground", sizeClasses[size], className)}>—</span>;
  }

  const resolved = resolveDirection(value, direction);
  const withIcon = showIcon ?? resolved !== "neutral";

  const exact = formatINR(value, { decimals: true, parens });
  const display = compact
    ? formatCompactINR(value)
    : formatINR(value, { decimals: !hideDecimals, parens });

  const tone =
    resolved === "in"
      ? "text-money-in"
      : resolved === "out"
        ? "text-money-out"
        : "text-foreground";

  const Icon = resolved === "in" ? ArrowDownLeft : resolved === "out" ? ArrowUpRight : Minus;

  const content = (
    <span className={cn("inline-flex items-baseline gap-1.5 tabular", tone, sizeClasses[size], className)}>
      {withIcon ? (
        <Icon
          className="size-3.5 shrink-0 self-center"
          aria-hidden
          strokeWidth={2.5}
        />
      ) : null}
      <span>{display}</span>
      {showLabel && resolved !== "neutral" ? (
        <span className="text-2xs font-medium uppercase tracking-wider opacity-70">
          {resolved === "in" ? "In" : "Out"}
        </span>
      ) : null}
      {/* Always announced to a screen reader, even when the label is visually hidden. */}
      {resolved !== "neutral" ? (
        <span className="sr-only">{resolved === "in" ? "money in" : "money out"}</span>
      ) : null}
    </span>
  );

  // A compacted or decimal-less figure must never be the only representation available —
  // someone may be about to act on it.
  if (compact || hideDecimals) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent className="tabular">{exact}</TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

/**
 * A debit / credit pair for ledger tables.
 * Exactly one side is ever populated on a given row, which is the visual invariant that
 * makes an unbalanced entry obvious at a glance.
 */
export function DebitCredit({ debit, credit }: { debit?: number | null; credit?: number | null }) {
  return (
    <>
      <td className="px-3 py-2.5 text-right">
        {debit ? <Money value={debit} direction="neutral" className="text-money-out" /> : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2.5 text-right">
        {credit ? <Money value={credit} direction="neutral" className="text-money-in" /> : <span className="text-muted-foreground">—</span>}
      </td>
    </>
  );
}
