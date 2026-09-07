import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Table primitives (§45).
 *
 * The wrapper owns the horizontal scroll rather than the page, so a wide DayBook scrolls
 * inside its own container and the app chrome stays put.
 *
 * `wrapperClassName` exists for the virtualised reports. CSS promotes `overflow-x: auto`
 * with a visible y-axis to `overflow: auto` on both, so this wrapper silently becomes a
 * vertical scroll container too. Nested inside `VirtualScroller` that means TWO scrollers,
 * and the virtualiser measures the outer one while the inner one is what actually moves —
 * so the window never updates and the table renders the same twenty rows forever. Those
 * screens pass `overflow-visible` to collapse the wrapper and let the scroller own both
 * axes.
 */
interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  wrapperClassName?: string;
  /**
   * Draw the horizontal-overflow fade. On by default; the virtualised report tables set
   * it false because they hand their scrolling to an outer `VirtualScroller`.
   */
  scrollHint?: boolean;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, wrapperClassName, scrollHint = true, ...props }, ref) => (
    /*
     * `scroll-fade-x` marks the horizontal overflow with a soft fade at whichever edge
     * has more content behind it.
     *
     * The report and ledger tables stay as tables at every width — a trial balance IS a
     * grid and card-ifying it would destroy the column alignment that makes it checkable.
     * So on a phone they scroll sideways, and without a cue nobody discovers that: the
     * table simply looks like it ends at the screen edge and the remaining columns are
     * reported as missing data.
     *
     * The fade costs nothing when there is no overflow. It is drawn with
     * `background-attachment: local`, so the gradient scrolls with the content and is
     * only visible while there is content to scroll to — no JS scroll listener, and no
     * fade on a table that already fits.
     */
    <div
      className={cn(
        "relative w-full overflow-x-auto",
        // Only where this wrapper is the thing that scrolls. On a wrapper collapsed with
        // `overflow-visible` there is nothing to scroll, and `background-attachment:
        // local` would then paint both gradients permanently — shading down each edge of
        // a report that fits perfectly well.
        scrollHint && "scroll-fade-x",
        wrapperClassName,
      )}
    >
      <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={cn("table-sticky-head [&_tr]:border-b", className)} {...props} />
  ),
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  ),
);
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot
      ref={ref}
      className={cn("border-t bg-surface-muted/60 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  ),
);
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "border-b border-border/70 transition-colors hover:bg-surface-muted/50 data-[state=selected]:bg-accent/8",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-10 whitespace-nowrap px-3 text-left align-middle text-2xs font-semibold uppercase tracking-wider text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("px-3 py-2.5 align-middle", className)} {...props} />
  ),
);
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell };
