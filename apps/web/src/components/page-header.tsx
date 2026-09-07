import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Page header.
 *
 * Consistent placement of title, context line and primary action is most of what makes
 * an information hierarchy "obvious" (§70) — a user should never hunt for the main action
 * on a screen they have not seen before.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {/*
          `truncate` on a phone cut titles like "Bank Reconciliation" to "Bank Reconcil…"
          even though there was a whole second line free. It wraps below `sm`, where
          vertical space is the abundant axis, and truncates from `sm` up, where the
          header shares its row with the actions.
        */}
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:truncate">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? (
        /*
          Full-width, side-by-side actions on a phone.

          `[&>*]:flex-1` makes each direct child share the row — a page header's actions
          are typically one primary ("New party") and one secondary ("Export"), and at
          their natural widths they sat as two small buttons hugging the left edge under a
          full-width title.
        */
        <div className="flex flex-wrap items-center gap-2 [&>*]:flex-1 sm:shrink-0 sm:[&>*]:flex-none">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
