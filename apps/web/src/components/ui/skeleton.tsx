import { cn } from "@/lib/utils";

/** Loading placeholder. Shaped like the content it replaces so the layout does not jump. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton-shimmer rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
