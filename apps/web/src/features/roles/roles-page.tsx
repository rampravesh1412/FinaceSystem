import { useQuery } from "@tanstack/react-query";
import { Lock, ShieldCheck, Users } from "lucide-react";
import type { RoleSummary } from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { Can } from "@/features/auth/auth-context";
import { NewRoleButton, RoleRowActions } from "./role-form";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Roles & permissions (§5).
 *
 * A role is a database row holding permission strings, not a hard-coded branch in the
 * code. Editing one changes what every guard in the API allows, immediately and with no
 * deploy — which is why this screen shows the permission count prominently and why
 * changing a role signs its holders out.
 */
export function RolesPage() {
  const query = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleSummary[]>("/roles"),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Roles & permissions"
        description="What each role may do. Changing a role takes effect immediately and signs its holders out."
        actions={
          <Can permission="roles.manage">
            <NewRoleButton />
          </Can>
        }
      />

      {query.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader><Skeleton className="h-5 w-32" /></CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <EmptyState
            icon={ShieldCheck}
            title="Could not load roles"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {query.data.map((role) => (
            <Card key={role.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{role.label}</CardTitle>
                  <div className="flex shrink-0 items-center gap-1">
                    {role.isSystem ? (
                      <Badge variant="outline"><Lock className="size-3" />System</Badge>
                    ) : null}
                    <span className="screen-only">
                      <RoleRowActions role={role} />
                    </span>
                  </div>
                </div>
                <p className="font-mono text-2xs text-muted-foreground">{role.name}</p>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col gap-4">
                <p className="text-sm text-muted-foreground">{role.description ?? "No description."}</p>

                <div className="mt-auto flex flex-wrap items-center gap-2">
                  <Badge variant="accent">
                    {role.permissions.includes("*") ? "All" : role.permissions.length} permission
                    {role.permissions.length === 1 && !role.permissions.includes("*") ? "" : "s"}
                  </Badge>
                  <Badge variant="outline">
                    <Users className="size-3" />
                    {role.userCount} user{role.userCount === 1 ? "" : "s"}
                  </Badge>
                  {role.isSuperAdmin ? (
                    <Badge variant="warning" title="This role bypasses branch isolation">
                      <ShieldCheck className="size-3" />
                      Every branch
                    </Badge>
                  ) : (
                    <Badge variant="default">Branch scoped</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
