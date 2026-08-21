import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "react-router-dom";
import { BadgeIndianRupee, Phone, Search, Undo2 } from "lucide-react";
import { KHATA_LABEL, type KhataStatement, type PartySummary } from "@amiri/shared";
import { ApiError, api, qs } from "@/lib/api";
import { useDebounced } from "@/hooks/use-debounced";
import { formatDate } from "@/lib/utils";
import { Money } from "@/components/money";
import { Can } from "@/features/auth/auth-context";
import { NewAdjustmentButton } from "./adjustment-form";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Digital Khata (§11).
 *
 * Deliberately reads like a paper khata rather than a general ledger: GIVEN and TAKEN
 * columns, a running balance, and a closing figure stated as "₹60,000 Lena Hai". The
 * numbers underneath are the party's ledger account — there is no second store — but the
 * vocabulary is the one the person collecting the money actually uses.
 */
export function KhataPage() {
  const { partyId } = useParams<{ partyId?: string }>();
  return partyId ? <KhataStatementView partyId={partyId} /> : <KhataPartyPicker />;
}

function KhataPartyPicker() {
  const navigate = useNavigate();
  const [search, setSearch] = React.useState("");
  const debounced = useDebounced(search, 300);

  const query = useQuery({
    queryKey: ["parties", "khata", debounced],
    queryFn: () => api.list<PartySummary>(`/parties${qs({ limit: 50, q: debounced })}`),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Digital Khata"
        description="Choose a party to open their khata — what they owe, what we owe, and every entry between."
        actions={
          <Can permission="finance.adjustment.create">
            <NewAdjustmentButton />
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
              placeholder="Search by name, code or mobile…"
              className="pl-9"
              autoFocus
              aria-label="Search parties"
            />
          </div>
        </div>

        {query.isPending || query.isError ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : query.data.items.length === 0 ? (
          <EmptyState
            icon={BadgeIndianRupee}
            title={debounced ? "No party matched" : "No parties yet"}
            description={debounced ? `Nothing matched “${debounced}”.` : "Add a party to start a khata."}
          />
        ) : (
          <ul className="divide-y divide-border">
            {query.data.items.map((party) => (
              <li key={party.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/khata/${party.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{party.name}</div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{party.code}</span>
                      {party.mobile ? (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="size-3" aria-hidden />
                          {party.mobile}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <Money
                      value={Math.abs(party.balance)}
                      direction={party.direction === "LENA" ? "in" : party.direction === "DENA" ? "out" : "neutral"}
                      showIcon={false}
                    />
                    <div className="text-2xs">
                      <Badge
                        variant={
                          party.direction === "LENA" ? "success" : party.direction === "DENA" ? "danger" : "default"
                        }
                      >
                        {KHATA_LABEL[party.direction]}
                      </Badge>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function KhataStatementView({ partyId }: { partyId: string }) {
  const query = useQuery({
    queryKey: ["khata", partyId],
    queryFn: () => api.get<KhataStatement>(`/khata/${partyId}`),
  });

  if (query.isPending) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <EmptyState
          icon={BadgeIndianRupee}
          title="Could not load the khata"
          description={query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/khata">Back to parties</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  const k = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={k.party.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{k.party.code}</span>
            <Badge variant="outline">{k.party.type.charAt(0) + k.party.type.slice(1).toLowerCase()}</Badge>
            <Badge variant="outline" className="font-mono">{k.party.branch.code}</Badge>
            {k.party.mobile ? <span className="text-muted-foreground">{k.party.mobile}</span> : null}
          </span>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/khata">All parties</Link>
          </Button>
        }
      />

      {/* The headline: the sentence a shopkeeper reads first. */}
      <Card
        className={cn(
          "border-l-4",
          k.closingDirection === "LENA" && "border-l-money-in",
          k.closingDirection === "DENA" && "border-l-money-out",
          k.closingDirection === "CLEAR" && "border-l-border",
        )}
      >
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Current balance
            </div>
            <div className="flex items-baseline gap-3">
              <Money
                value={Math.abs(k.closingBalance)}
                direction={
                  k.closingDirection === "LENA" ? "in" : k.closingDirection === "DENA" ? "out" : "neutral"
                }
                size="xl"
                showIcon={false}
              />
              <Badge
                variant={
                  k.closingDirection === "LENA" ? "success" : k.closingDirection === "DENA" ? "danger" : "default"
                }
              >
                {KHATA_LABEL[k.closingDirection]}
              </Badge>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
            <Stat label="Opening" value={k.openingBalance} />
            <Stat label="Given" value={k.totalGiven} />
            <Stat label="Taken" value={k.totalTaken} />
            {k.creditLimit > 0 ? (
              <>
                <Stat label="Credit limit" value={k.creditLimit} />
                <Stat label="Available" value={k.availableCredit} />
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      {k.isOverLimit ? (
        <div className="rounded-md border border-warning/40 bg-warning-subtle px-4 py-3 text-sm">
          <span className="font-medium text-foreground">Past their credit limit.</span>{" "}
          <span className="text-muted-foreground">
            Further payments out to this party will be refused until the balance comes down.
          </span>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {k.entries.length === 0 ? (
          <EmptyState
            icon={BadgeIndianRupee}
            title="No entries yet"
            description="Nothing has been recorded against this party."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="hidden sm:table-cell">Date</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="text-right">Given</TableHead>
                <TableHead className="text-right">Taken</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {/* Opening carried forward, so the running balance starts where it should. */}
              <TableRow className="bg-surface-muted/40">
                <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">—</TableCell>
                <TableCell className="text-sm font-medium">Opening balance</TableCell>
                <TableCell />
                <TableCell />
                <TableCell className="text-right">
                  <Money value={k.openingBalance} direction="auto" showIcon={false} />
                </TableCell>
              </TableRow>

              {k.entries.map((entry) => (
                <TableRow key={entry.id} className={cn(entry.isReversed && "opacity-55")}>
                  <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground sm:table-cell">
                    {formatDate(entry.date)}
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm">{entry.narration ?? entry.typeLabel}</span>
                      {entry.isReversed ? (
                        <Badge variant="warning">
                          <Undo2 className="size-3" />
                          Reversed
                        </Badge>
                      ) : null}
                    </div>
                    <div className="font-mono text-2xs text-muted-foreground">
                      {entry.txnNo}
                      <span className="sm:hidden"> · {formatDate(entry.date)}</span>
                    </div>
                  </TableCell>

                  <TableCell className="text-right">
                    {entry.given ? <Money value={entry.given} showIcon={false} className="text-money-out" /> : <Dash />}
                  </TableCell>
                  <TableCell className="text-right">
                    {entry.taken ? <Money value={entry.taken} showIcon={false} className="text-money-in" /> : <Dash />}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={entry.balance} direction="auto" showIcon={false} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>

            <TableFooter>
              <TableRow>
                <TableCell className="hidden sm:table-cell" />
                <TableCell className="text-xs uppercase tracking-wider text-muted-foreground">
                  {k.closingLabel}
                </TableCell>
                <TableCell className="text-right font-semibold">
                  <Money value={k.totalGiven} showIcon={false} />
                </TableCell>
                <TableCell className="text-right font-semibold">
                  <Money value={k.totalTaken} showIcon={false} />
                </TableCell>
                <TableCell className="text-right font-semibold">
                  <Money value={k.closingBalance} direction="auto" showIcon={false} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd>
        <Money value={value} showIcon={false} size="sm" />
      </dd>
    </div>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;
