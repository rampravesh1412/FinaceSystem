import { useQuery } from "@tanstack/react-query";
import type {
  BankAccountSummary,
  CashAccountSummary,
  ChargeRuleSummary,
  PartySummary,
} from "@amiri/shared";
import { api, qs } from "@/lib/api";

/**
 * Reference data for the entry forms.
 *
 * All of it is branch-scoped on the SERVER, so a form can only ever offer accounts and
 * parties the signed-in user may actually post against. The dropdown is not the control —
 * the API would refuse an out-of-scope id anyway — but it means the interface never
 * presents a choice that will be rejected.
 */

export interface AccountOption {
  id: string;
  label: string;
  kind: "BANK" | "CASH";
  balance: number;
  branchId: string;
}

/** Bank and cash accounts in one list, since a payment can settle through either. */
export function useAccounts() {
  const banks = useQuery({
    queryKey: ["bank-accounts", "options"],
    queryFn: () => api.list<BankAccountSummary>(`/bank-accounts${qs({ limit: 100, status: "ACTIVE" })}`),
  });

  const cash = useQuery({
    queryKey: ["cash-accounts", "options"],
    queryFn: () => api.list<CashAccountSummary>(`/cash-accounts${qs({ limit: 100 })}`),
  });

  const options: AccountOption[] = [
    ...(banks.data?.items ?? []).map((a) => ({
      id: a.id,
      label: `${a.bank.shortName ?? a.bank.name} — ${a.accountName}`,
      kind: "BANK" as const,
      balance: a.balance,
      branchId: a.branch.id,
    })),
    ...(cash.data?.items ?? []).map((a) => ({
      id: a.id,
      label: `Cash — ${a.name}`,
      kind: "CASH" as const,
      balance: a.balance,
      branchId: a.branch.id,
    })),
  ];

  return { options, isPending: banks.isPending || cash.isPending };
}

export function useParties(search?: string) {
  return useQuery({
    queryKey: ["parties", "options", search],
    queryFn: () => api.list<PartySummary>(`/parties${qs({ limit: 100, q: search, status: "ACTIVE" })}`),
  });
}

export function useExpenseCategories() {
  return useQuery({
    queryKey: ["expense-categories"],
    queryFn: () => api.get<Array<{ id: string; name: string; code: string }>>("/expenses/categories"),
  });
}

export function useIncomeHeads() {
  return useQuery({
    queryKey: ["income-heads"],
    queryFn: () => api.get<Array<{ id: string; name: string; code: string }>>("/income/heads"),
  });
}

export function useChargeRules() {
  return useQuery({
    queryKey: ["charge-rules"],
    queryFn: () => api.get<ChargeRuleSummary[]>("/charges"),
  });
}

/**
 * Live charge preview.
 *
 * §18 requires gross, charge and net to be visible BEFORE the transaction is committed,
 * not discovered afterwards. The figure comes from the server so the preview is computed
 * by the same engine that will post it — a client-side approximation could disagree with
 * what actually gets charged.
 */
export function useChargePreview(chargeRuleId: string | undefined, amount: string) {
  return useQuery({
    queryKey: ["charge-preview", chargeRuleId, amount],
    queryFn: () =>
      api.post<{ gross: number; charge: number; net: number; basis: string; bearer: string }>(
        "/charges/preview",
        { chargeRuleId, amount },
      ),
    enabled: Boolean(chargeRuleId) && Boolean(amount) && Number(String(amount).replace(/[^\d.]/g, "")) > 0,
    // A charge preview is pure arithmetic on inputs the user just typed — retrying a
    // rejection would only produce the same rejection.
    retry: false,
  });
}
