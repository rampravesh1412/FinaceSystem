import { useQuery } from "@tanstack/react-query";
import { PiggyBank } from "lucide-react";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Passbook {
  account: {
    accountNo: string;
    memberName: string;
    mobile?: string;
    balance: number;
    interestRateBps: number;
    status: string;
    openedAt: string;
  };
  entries: Array<{
    id: string;
    date: string;
    txnNo: string;
    narration?: string;
    deposit: number;
    withdrawal: number;
    balance: number;
    isReversed: boolean;
  }>;
}

/** The member's passbook — deliberately shaped like the paper one it replaces. */
export function SavingsPassbook({
  savingsAccountId,
  onClose,
}: {
  savingsAccountId: string | null;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["savings-passbook", savingsAccountId],
    queryFn: () => api.get<Passbook>(`/savings/${savingsAccountId}/passbook`),
    enabled: Boolean(savingsAccountId),
  });

  return (
    <Sheet open={Boolean(savingsAccountId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {query.isPending ? (
          <div className="space-y-4 p-5">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : query.isError ? (
          <EmptyState icon={PiggyBank} title="Could not load the passbook" />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>{query.data.account.memberName}</SheetTitle>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{query.data.account.accountNo}</span>
                <Badge variant={query.data.account.status === "ACTIVE" ? "success" : "warning"}>
                  {query.data.account.status.charAt(0) + query.data.account.status.slice(1).toLowerCase()}
                </Badge>
                {query.data.account.interestRateBps > 0 ? (
                  <Badge variant="outline">{query.data.account.interestRateBps / 100}% p.a.</Badge>
                ) : null}
              </div>
            </SheetHeader>

            <div className="border-b border-border p-5">
              <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Balance held for this member
              </div>
              <Money value={query.data.account.balance} showIcon={false} size="xl" />
              <p className="mt-1 text-2xs text-muted-foreground">
                Opened {formatDate(query.data.account.openedAt)}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead className="text-right">Deposit</TableHead>
                    <TableHead className="text-right">Withdrawal</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.entries.map((e) => (
                    <TableRow key={e.id} className={cn(e.isReversed && "opacity-55")}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(e.date)}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{e.narration ?? "—"}</div>
                        <div className="font-mono text-2xs text-muted-foreground">{e.txnNo}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        {e.deposit ? <Money value={e.deposit} direction="in" showIcon={false} /> : <Dash />}
                      </TableCell>
                      <TableCell className="text-right">
                        {e.withdrawal ? <Money value={e.withdrawal} direction="out" showIcon={false} /> : <Dash />}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={e.balance} showIcon={false} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;
