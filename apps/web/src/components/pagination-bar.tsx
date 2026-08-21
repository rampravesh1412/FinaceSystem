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
    <div className="screen-only flex flex-col-reverse items-center justify-between gap-3 border-t border-border px-4 py-3 sm:flex-row">
      <p className="text-xs text-muted-foreground">
        Showing <span className="tabular font-medium text-foreground">{first}</span>–
        <span className="tabular font-medium text-foreground">{last}</span> of{" "}
        <span className="tabular font-medium text-foreground">{meta.total.toLocaleString("en-IN")}</span>{" "}
        {label}
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!meta.hasPrev}
          onClick={() => onPageChange(meta.page - 1)}
        >
          <ChevronLeft />
          Previous
        </Button>
        <span className="px-1 text-xs text-muted-foreground">
          Page <span className="tabular font-medium text-foreground">{meta.page}</span> of{" "}
          <span className="tabular font-medium text-foreground">{meta.totalPages}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
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
