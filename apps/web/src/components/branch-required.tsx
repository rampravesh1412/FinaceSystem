import { Building2 } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * The all-branches view is a reading position, not a posting one.
 *
 * Every entry lands in exactly one branch's books, so a form with no branch in context has
 * nothing to post against. Some forms carry their own branch selector and simply start
 * blank; the ones that do not — a transaction, an adjustment, a settlement — would
 * otherwise reach submit with an empty `branchId` and fail validation against a field the
 * operator cannot see, or, worse, quietly default to whichever branch happened to sort
 * first. Saying so up front is the honest version of both.
 */
export function BranchRequired({ action }: { action: string }) {
  return (
    <EmptyState
      icon={Building2}
      title="Choose a branch first"
      description={`You are viewing all branches. ${action} is recorded in one branch's books, so pick a specific branch from the switcher at the top of the screen.`}
    />
  );
}
