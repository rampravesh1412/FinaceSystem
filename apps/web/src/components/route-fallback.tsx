import { Skeleton } from "@/components/ui/skeleton";

/**
 * What a lazily-loaded screen shows while its chunk is in flight.
 *
 * Deliberately the SHAPE of a page — a header, some tiles, a table — rather than a
 * centred spinner. The layout does not jump when the real screen arrives, and on a fast
 * connection this is on screen for a frame or two and reads as the page drawing itself
 * rather than as a load.
 *
 * `role="status"` with a visually-hidden label, because to a screen reader a wall of grey
 * boxes is nothing at all.
 */
export function RouteFallback() {
  return (
    <div className="space-y-5" role="status" aria-live="polite">
      <span className="sr-only">Loading the page</span>

      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>

      <Skeleton className="h-80 w-full" />
    </div>
  );
}
