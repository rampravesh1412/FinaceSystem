import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { NotificationFeed, NotificationRow } from "@amiri/shared";
import { api, qs } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Notifications (§50).
 *
 * Every entry is a POINTER to something that happened on the books — a tally that came up
 * short, an approval waiting, a reconciliation closed with a difference. None of it is the
 * record itself, which is why the server can expire these after 90 days without losing
 * anything: the transaction, the tally and the audit row all outlive the notification.
 *
 * Polls on a 60-second interval rather than holding a socket open. An accountant does not
 * need sub-second delivery of "a tally was short", and a socket per open tab is a great
 * deal of infrastructure for a badge.
 */
export function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationFeed>(`/notifications${qs({ limit: 30 })}`),
    refetchInterval: 60_000,
    // Keeps the badge honest when the operator comes back to a tab left open all morning.
    refetchOnWindowFocus: true,
  });

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.post<{ marked: number }>("/notifications/read", { ids }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const feed = query.data;
  const unread = feed?.unread ?? 0;

  const onOpenNotification = (notification: NotificationRow) => {
    if (!notification.read) markRead.mutate([notification.id]);
    if (notification.link) {
      setOpen(false);
      navigate(notification.link);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              loading={markRead.isPending}
              onClick={() => markRead.mutate(undefined)}
            >
              <CheckCheck />
              Mark all read
            </Button>
          ) : null}
        </div>

        {query.isPending ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : query.isError ? (
          /* §66: the bell says it could not load rather than showing an empty tray, which
             would read as "nothing has happened". */
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            Notifications could not be loaded.
          </p>
        ) : !feed || feed.items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            Nothing to report. Short tallies, pending approvals and large transactions appear here.
          </p>
        ) : (
          <ScrollArea className="max-h-96">
            <ul>
              {feed.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onOpenNotification(n)}
                    className={cn(
                      "flex w-full items-start gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-surface-muted focus-visible:outline-none focus-visible:bg-surface-muted",
                      !n.read && "bg-accent/5",
                    )}
                  >
                    <SeverityIcon severity={n.severity} />

                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={cn("truncate text-sm", !n.read && "font-semibold")}>
                          {n.title}
                        </span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {relativeTime(n.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">{n.body}</p>
                      {n.amount !== undefined && n.amount !== null ? (
                        <Money value={n.amount} direction="auto" showIcon={false} size="sm" />
                      ) : null}
                    </div>

                    {!n.read ? (
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Severity carries an icon as well as a colour (§43) — never colour alone. */
function SeverityIcon({ severity }: { severity: string }) {
  if (severity === "CRITICAL" || severity === "ERROR") {
    return <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Critical" />;
  }
  if (severity === "WARNING") {
    return <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />;
  }
  return <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Information" />;
}
