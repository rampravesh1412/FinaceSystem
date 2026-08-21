import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ShieldCheck, Users as UsersIcon } from "lucide-react";
import type { UserSummary } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { Can } from "@/features/auth/auth-context";
import { NewUserButton } from "./user-form";
import { UserRowActions } from "./user-actions";
import { useDebounced } from "@/hooks/use-debounced";
import { initials, relativeTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PaginationBar } from "@/components/pagination-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Users (§2, §3).
 *
 * The directory is branch-scoped on the server: a branch admin sees only users who share
 * at least one branch with them. That is why this page never filters by branch itself —
 * doing so would imply the full list had been sent and merely hidden.
 */
export function UsersPage() {
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounced(search, 300);

  React.useEffect(() => setPage(1), [debouncedSearch]);

  const query = useQuery({
    queryKey: ["users", { page, q: debouncedSearch }],
    queryFn: () => api.list<UserSummary>(`/users${qs({ page, limit: 25, q: debouncedSearch })}`),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users"
        description="People who can sign in, and the branches their access is limited to."
        actions={
          <Can permission="users.create">
            <NewUserButton />
          </Can>
        }
      />

      <Card className="overflow-hidden">
        <div className="border-b border-border p-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or email…"
              className="pl-9"
              aria-label="Search users"
            />
          </div>
        </div>

        {query.isPending ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <EmptyState
            icon={UsersIcon}
            title="Could not load users"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        ) : query.data.items.length === 0 ? (
          <EmptyState
            icon={UsersIcon}
            title={debouncedSearch ? "No users matched" : "No users to show"}
            description={
              debouncedSearch
                ? `Nothing matched “${debouncedSearch}”.`
                : "You can only see users who share a branch with you."
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="hidden md:table-cell">Role</TableHead>
                  <TableHead className="hidden lg:table-cell">Branches</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Last sign-in</TableHead>
                  <TableHead className="w-12 screen-only"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="size-8">
                          <AvatarFallback>{initials(user.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{user.name}</div>
                          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge variant={user.role?.name === "SUPER_ADMIN" ? "accent" : "outline"}>
                        {user.role?.name === "SUPER_ADMIN" ? <ShieldCheck className="size-3" /> : null}
                        {user.role?.label ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {user.branches.length === 0 ? (
                        <span className="text-xs text-muted-foreground">All branches</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {user.branches.slice(0, 3).map((b) => (
                            <Badge key={b.id} variant="default" className="font-mono">
                              {b.code}
                            </Badge>
                          ))}
                          {user.branches.length > 3 ? (
                            <Badge variant="outline">+{user.branches.length - 3}</Badge>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.status === "ACTIVE" ? "success" : "warning"}>
                        {user.status.charAt(0) + user.status.slice(1).toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                      {user.lastLoginAt ? relativeTime(user.lastLoginAt) : "Never"}
                    </TableCell>
                    <TableCell className="screen-only">
                      <UserRowActions user={user} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationBar meta={query.data.meta} onPageChange={setPage} label="users" />
          </>
        )}
      </Card>
    </div>
  );
}
