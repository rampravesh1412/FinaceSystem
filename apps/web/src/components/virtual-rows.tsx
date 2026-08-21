import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Row virtualisation for the two lists that are not server-paginated.
 *
 * Almost nothing in this application needs this. Every table that talks to a list endpoint
 * asks for 25–50 rows and pages on the server, and virtualising fifty rows is complexity
 * with no payoff. Two lists are genuinely unbounded, and both are reports rather than
 * pages:
 *
 *   - the **trial balance**, which returns every account in the chart of accounts — a
 *     deployment with five thousand parties has five thousand rows, and it must show all
 *     of them or it does not prove the books tie;
 *   - **reconciliation lines**, which carry up to two thousand imported statement lines
 *     plus every unmatched ledger entry in the window.
 *
 * Neither can be paginated away: their whole purpose is completeness.
 *
 * The markup stays a real `<table>`. The rendered window sits between two spacer rows
 * whose heights stand in for everything scrolled past, which keeps column alignment,
 * header association and text selection intact — the usual `position: absolute` approach
 * throws all three away, and a ledger whose columns do not line up is worse than a slow
 * one.
 */

/**
 * The scroll container a virtualised table lives in.
 *
 * Virtualising requires a scrolling element to measure against, so these tables get their
 * own rather than riding the page scroll. The trade is a nested scrollbar; the sticky
 * header makes it read as a panel with its own extent rather than a lost scroll position,
 * and it is confined to two report screens.
 */
export function VirtualScroller({
  children,
  className,
  scrollRef,
}: {
  children: React.ReactNode;
  className?: string;
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={scrollRef}
      className={cn("print-full relative max-h-[70vh] overflow-y-auto overflow-x-auto", className)}
    >
      {children}
    </div>
  );
}

export interface VirtualRowsProps<T> {
  rows: T[];
  /** The container from `VirtualScroller`. */
  scrollRef: React.RefObject<HTMLElement>;
  /** Initial row-height guess in px; rows are then measured for real. */
  estimateRowHeight?: number;
  /** Rows rendered beyond the window, so a fast scroll does not show blank space. */
  overscan?: number;
  /** Column count, for the spacer rows' colSpan. */
  columns: number;
  children: (row: T, index: number) => React.ReactNode;
  /** At or below this many rows everything renders and the virtualiser is bypassed. */
  threshold?: number;
}

export function VirtualRows<T>({
  rows,
  scrollRef,
  estimateRowHeight = 44,
  overscan = 12,
  columns,
  children,
  threshold = 150,
}: VirtualRowsProps<T>) {
  const windowed = rows.length > threshold;

  const virtualiser = useVirtualizer({
    // Zero when the list is short: the hook still has to run — it cannot be called
    // conditionally — but it does no work and the full list renders below.
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan,
  });

  // Short lists render whole. A 40-row trial balance gains nothing from a windowing
  // calculation and loses the browser's own find-in-page across all of it.
  if (!windowed) {
    return <>{rows.map((row, i) => children(row, i))}</>;
  }

  const items = virtualiser.getVirtualItems();
  if (items.length === 0) return null;

  const before = items[0]!.start;
  const after = virtualiser.getTotalSize() - items.at(-1)!.end;

  return (
    <>
      {before > 0 ? (
        <TableRow aria-hidden>
          <TableCell colSpan={columns} className="p-0" style={{ height: before }} />
        </TableRow>
      ) : null}

      {items.map((item) => (
        <React.Fragment key={item.key}>{children(rows[item.index]!, item.index)}</React.Fragment>
      ))}

      {after > 0 ? (
        <TableRow aria-hidden>
          <TableCell colSpan={columns} className="p-0" style={{ height: after }} />
        </TableRow>
      ) : null}
    </>
  );
}

/**
 * Tells the user what they are looking at when a list is windowed.
 *
 * §66-adjacent: a virtualised table shows twenty rows out of four thousand and looks
 * exactly like a table with twenty rows in it. The total has to be stated, or someone
 * scrolls to the end of what is drawn and concludes that is all there is.
 */
export function VirtualNotice({ total, threshold = 150 }: { total: number; threshold?: number }) {
  if (total <= threshold) return null;
  return (
    <>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        All <span className="tabular font-medium text-foreground">{total.toLocaleString("en-IN")}</span>{" "}
        rows are present — they are drawn as you scroll. The export contains the complete
        list in one file.
      </p>
      {/* On paper the windowing is invisible and the page would look complete. It is not:
          only the drawn rows exist in the document being printed. */}
      <p className="print-only border-t px-4 py-2 text-xs">
        This printout shows only part of a {total.toLocaleString("en-IN")}-row report — the
        rest is drawn on screen as you scroll and is not in this document. Use the CSV,
        Excel or PDF export for the complete list.
      </p>
    </>
  );
}
