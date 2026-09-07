import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PageMeta } from "@amiri/shared";
import { Button } from "@/components/ui/button";

/**
 * Server-side pagination controls (§45, §69).
 *
 * Always states the absolute range and total, because "page 3 of 12" alone does not tell
 * an accountant whether they are looking at all 1,284 transactions or a filtered subset.
 */
export function PaginationBar({
  meta,
  onPageChange,
  label = "records",
}: {
  meta: PageMeta;
  onPageChange: (page: number) => void;
  label?: string;
}) {
  if (meta.total === 0) return null;

  const first = (meta.page - 1) * meta.limit + 1;
  const last = Math.min(meta.page * meta.limit, meta.total);

  return (
    <div className="screen-only flex flex-col-reverse items-stretch justify-between gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center">
      <p className="text-center text-xs text-muted-foreground sm:text-left">
        Showing <span className="tabular font-medium text-foreground">{first}</span>–
        <span className="tabular font-medium text-foreground">{last}</span> of{" "}
        <span className="tabular font-medium text-foreground">{meta.total.toLocaleString("en-IN")}</span>{" "}
        {label}
      </p>

      {/*
        Prev and Next grow to fill the row on a phone.

        As 32px-tall auto-width buttons they were two small targets floating in the middle
        of a wide bar — and paging is the most repeated action on any of these screens.
        Full-width, 40px tall, with the page counter between them, they are reachable with
        a thumb without looking.
      */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-10 flex-1 sm:h-8 sm:flex-none"
          disabled={!meta.hasPrev}
          onClick={() => onPageChange(meta.page - 1)}
        >
          <ChevronLeft />
          Previous
        </Button>
        <span className="shrink-0 px-1 text-center text-xs text-muted-foreground">
          Page <span className="tabular font-medium text-foreground">{meta.page}</span> of{" "}
          <span className="tabular font-medium text-foreground">{meta.totalPages}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-10 flex-1 sm:h-8 sm:flex-none"
          disabled={!meta.hasNext}
          onClick={() => onPageChange(meta.page + 1)}
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
