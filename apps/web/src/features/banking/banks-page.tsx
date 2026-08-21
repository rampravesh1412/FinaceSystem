import { useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";
import type { BankSummary } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { Can, useAuth } from "@/features/auth/auth-context";
import { NewBankButton } from "./bank-form";
import { BankRowActions } from "./banking-edit";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Banks (§7) — the institutions, not the accounts.
 *
 * A bank holds no balance of its own. The figure on each card is the sum of the accounts
 * beneath it THAT THE CALLER MAY SEE, computed server-side inside the aggregation. A
 * branch admin sees their own two HDFC accounts totalled, not the organisation's twelve.
 */
export function BanksPage() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ["banks"],
    queryFn: () => api.list<BankSummary>(`/banks${qs({ limit: 50 })}`),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Banks"
        description={
          user?.isSuperAdmin
            ? "Institutions across the organisation. Totals cover every branch."
            : "Institutions you bank with. Totals cover your branches only."
        }
        actions={
          <Can permission="finance.bank.create">
            <NewBankButton />
          </Can>
        }
      />

      {query.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader><Skeleton className="h-5 w-32" /></CardHeader>
              <CardContent><Skeleton className="h-7 w-40" /></CardContent>
            </Card>
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <EmptyState
            icon={Landmark}
            title="Could not load banks"
            description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
            action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>}
          />
        </Card>
      ) : query.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Landmark}
            title="No banks yet"
            description="Add the institutions you bank with, then create accounts beneath them."
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {query.data.items.map((bank) => (
            <Card key={bank.id} className="transition-shadow hover:shadow-card">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-9 items-center justify-center rounded-md bg-accent/10">
                      <Landmark className="size-4.5 text-accent" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">{bank.shortName ?? bank.name}</CardTitle>
                      <p className="truncate text-xs text-muted-foreground">{bank.name}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Badge variant={bank.status === "ACTIVE" ? "success" : "warning"}>
                      {bank.status.charAt(0) + bank.status.slice(1).toLowerCase()}
                    </Badge>
                    <span className="screen-only">
                      <BankRowActions bank={bank} />
                    </span>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                <div>
                  <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Balance across your accounts
                  </div>
                  <Money value={bank.totalBalance} direction="auto" size="lg" showIcon={false} />
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">
                    {bank.accountCount} account{bank.accountCount === 1 ? "" : "s"}
                  </Badge>
                  {bank.ifscPrefix ? (
                    <span className="font-mono">{bank.ifscPrefix}••••••</span>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
