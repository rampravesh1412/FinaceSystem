import * as React from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The card a table row becomes on a phone.
 *
 * A ledger table is seven to nine columns wide. There are three ways to put that on a
 * 360px screen and only one of them is honest:
 *
 *  1. Scroll it sideways. Legible, but you cannot compare two rows without swiping back
 *     and forth, and the columns that matter are always the ones off-screen.
 *  2. Hide columns with `hidden md:table-cell` — which is what this app did. The layout
 *     stops overflowing and the data is simply *gone*, with nothing to say it was ever
 *     there. An accountant checking a charge on their phone sees no charge column and
 *     concludes there was no charge.
 *  3. Re-shape the row. Same data, stacked: the identifying fields as a heading, the
 *     amount pulled out where the eye lands first, and the remaining columns as labelled
 *     pairs underneath.
 *
 * This is (3). Every field the desktop table shows is still present — nothing is dropped
 * on the small screen, it is only laid out differently.
 *
 * Rendered *instead of* the table, never alongside it: the pages that use this switch on
 * `useIsMobile()` so only one of the two is ever mounted. Rendering both and hiding one
 * with CSS would double the DOM of every list in the application, and on the long ledger
 * screens it would double the virtualiser's work as well.
 */

export interface RecordCardProps {
  /** Primary identifier — voucher number, party name, account label. */
  title: React.ReactNode;
  /** Second line under the title: a code, a date, a narration. */
  subtitle?: React.ReactNode;
  /** Top-right: the amount, or whatever the row is really about. */
  trailing?: React.ReactNode;
  /** Under the trailing slot — typically a status badge. */
  trailingBelow?: React.ReactNode;
  /** Label/value pairs, laid out two per row. */
  fields?: React.ReactNode;
  /** Row actions — a "⋯" menu, or one or two real buttons. */
  actions?: React.ReactNode;
  /**
   * Where the actions sit.
   *
   * `"corner"` tucks them into the card's top-right, next to the amount — right for an
   * icon-only "⋯" menu, and it costs no vertical space at all.
   * `"row"` (the default) gives them their own ruled row at the foot of the card, which
   * is what wider controls need: "Execute", "Close period", a pair of
   * deposit/withdraw buttons. Squeezed into the corner those either wrap or shove the
   * amount off the card.
   */
  actionsPlacement?: "corner" | "row";
  /** Makes the whole card a link. Mutually exclusive with `onClick`. */
  to?: string;
  onClick?: () => void;
  /** Dims the card without hiding it — a reversed or inactive record. */
  muted?: boolean;
  /**
   * Accessible name for the tap overlay, e.g. "Open Gaya Wholesale". The overlay covers
   * the card and has no text of its own, so without this a screen reader reaches an
   * unlabelled link.
   */
  label?: string;
  className?: string;
}

export function RecordCard({
  title, subtitle, trailing, trailingBelow, fields, actions,
  actionsPlacement = "row", to, onClick, muted, label, className,
}: RecordCardProps) {
  const interactive = Boolean(to || onClick);
  const cornerActions = actions && actionsPlacement === "corner";

  return (
    <div
      className={cn(
        "relative rounded-lg border border-border bg-card p-3.5 shadow-subtle transition-colors",
        interactive && "focus-within:ring-2 focus-within:ring-ring active:bg-surface-muted",
        muted && "opacity-60",
        className,
      )}
    >
      {/*
        A "stretched link": the whole card is tappable, but the control that makes it so is
        a SIBLING of the content rather than a wrapper around it.
        <a><button/></a> is invalid HTML — browsers disagree about which one a tap
        activates, and a screen reader announces one confused control instead of two — so
        a card carrying a row-actions menu cannot be wrapped in a link. Overlaying an
        absolutely positioned link at z-0 and lifting the actions to z-10 gives a large
        tap target AND a working menu, with no nesting.
      */}
      {to ? (
        <Link to={to} className="absolute inset-0 z-0 rounded-lg focus:outline-none">
          <span className="sr-only">{label ?? "Open"}</span>
        </Link>
      ) : onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="absolute inset-0 z-0 rounded-lg focus:outline-none"
        >
          <span className="sr-only">{label ?? "Open"}</span>
        </button>
      ) : null}

      {/* `pointer-events-none` lets a tap anywhere in the body fall through to the overlay;
          anything that needs its own click re-enables them on itself. */}
      <div className={cn("relative z-[1]", interactive && "pointer-events-none")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-snug">{title}</div>
            {subtitle ? (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-start gap-1">
            <div className="flex flex-col items-end gap-1 text-right">
              {trailing}
              {trailingBelow}
            </div>

            {cornerActions ? (
              // Lifted above the tap overlay and given its clicks back, or the menu would
              // open the record instead of the menu.
              <div className="pointer-events-auto relative z-10 -mr-1 -mt-1">{actions}</div>
            ) : interactive ? (
              /* Only where the whole card navigates. A chevron on a card that does nothing
                 is a promise the interface does not keep. */
              <ChevronRight
                className="mt-0.5 size-4 shrink-0 text-muted-foreground/50"
                aria-hidden
              />
            ) : null}
          </div>
        </div>

        {fields ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/60 pt-3">
            {fields}
          </dl>
        ) : null}
      </div>

      {actions && !cornerActions ? (
        <div className="screen-only relative z-10 mt-2 flex flex-wrap justify-end gap-2 border-t border-border/60 pt-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** One label/value pair inside a card. `wide` spans both columns for long text. */
/**
 * One label/value pair inside a card.
 *
 * `[&_a]:pointer-events-auto` re-enables clicks on any link in the value — a party's
 * phone number should dial rather than open the record, and the card body otherwise lets
 * every tap fall through to the overlay link.
 */
export function RecordField({
  label,
  children,
  wide,
  className,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 [&_a]:pointer-events-auto", wide && "col-span-2", className)}>
      <dt className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm">{children}</dd>
    </div>
  );
}

/** Vertical stack of cards, with the page padding a `Card`-wrapped table would have had. */
export function RecordCardList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-2.5 p-3", className)}>{children}</div>;
}
