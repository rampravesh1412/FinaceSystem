import { Types } from "mongoose";
import {
  KHATA_LABEL,
  TRANSACTION_TYPE_LABEL,
  agingBucket,
  daysBetween,
  formatINR,
  khataDirection,
  type AgingBucketKey,
  type AgingRow,
  type CreateAdjustmentInput,
  type CreditSummary,
  type KhataStatement,
} from "@amiri/shared";
import {
  LedgerAccount,
  LedgerEntry,
  Party,
  type PartyDoc,
  type TransactionDoc,
} from "../../models/index.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as accounts from "../../services/accounts.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Digital Khata (§11), adjustments (§25) and credit aging (§12).
 *
 * The Khata is a PRESENTATION of the party's ledger account, not a second store. §11's
 * arithmetic — opening + given + taken + adjustments = current — is exactly what the
 * ledger already holds. Building a parallel khata table would give the same party two
 * balances that drift, and then nobody could say which one they actually owe.
 *
 * What this module contributes is the vocabulary and the aging.
 */

/* -------------------------------------------------------------------------- */
/* Statement                                                                  */
/* -------------------------------------------------------------------------- */

export async function getStatement(
  partyId: string,
  options: { from?: Date; to?: Date; limit?: number },
  scopeFilter: Record<string, unknown>,
): Promise<KhataStatement> {
  const party = await Party.findOne({ _id: partyId, ...scopeFilter })
    .populate<{ branchId: { _id: Types.ObjectId; name: string; code: string } }>("branchId", "name code")
    .lean();

  if (!party) throw new NotFoundError("Party", partyId);

  const filter: Record<string, unknown> = { ledgerAccountId: party.ledgerAccountId };
  if (options.from || options.to) {
    filter.date = {
      ...(options.from ? { $gte: options.from } : {}),
      ...(options.to ? { $lte: options.to } : {}),
    };
  }

  // Balance brought forward. Without it, a date-filtered khata starts from zero and every
  // running balance on the page is wrong — the single most damaging bug a statement can
  // have, because it looks plausible.
  const opening = options.from
    ? (await ledger.computeBalance(party.ledgerAccountId, { asOf: new Date(options.from.getTime() - 1) }))
        .balance
    : 0;

  const entries = await LedgerEntry.find(filter)
    .sort({ date: 1, _id: 1 })
    .limit(options.limit ?? 500)
    .populate<{ createdBy: { name: string } | null }>("createdBy", "name")
    .lean();

  // Reversed transactions stay in the statement — struck through in the UI rather than
  // hidden — because §28 requires the original to remain visible.
  const { Transaction } = await import("../../models/index.js");
  const txnIds = [...new Set(entries.map((e) => String(e.transactionId)))];
  const txns = await Transaction.find({ _id: { $in: txnIds } }).select("status").lean();
  const statusById = new Map(txns.map((t) => [String(t._id), t.status]));

  let running = opening;
  let totalGiven = 0;
  let totalTaken = 0;

  const rows = entries.map((entry) => {
    // A party account is ASSET-normal, so a DEBIT means we gave — they owe us more.
    const given = entry.direction === "DEBIT" ? entry.amount : 0;
    const taken = entry.direction === "CREDIT" ? entry.amount : 0;
    running += given - taken;
    totalGiven += given;
    totalTaken += taken;

    return {
      id: String(entry._id),
      date: entry.date.toISOString(),
      txnNo: entry.txnNo,
      transactionType: entry.transactionType,
      typeLabel:
        TRANSACTION_TYPE_LABEL[entry.transactionType as keyof typeof TRANSACTION_TYPE_LABEL] ??
        entry.transactionType,
      narration: entry.narration,
      given,
      taken,
      balance: running,
      direction: khataDirection(running),
      createdBy: entry.createdBy?.name ?? null,
      isReversed: statusById.get(String(entry.transactionId)) === "REVERSED",
    };
  });

  const closing = running;
  const creditUsed = Math.max(0, closing);
  const direction = khataDirection(closing);

  return {
    party: {
      id: String(party._id),
      name: party.name,
      code: party.code,
      type: party.type,
      mobile: party.mobile,
      branch: { id: String(party.branchId._id), name: party.branchId.name, code: party.branchId.code },
    },
    openingBalance: opening,
    openingDirection: khataDirection(opening),
    totalGiven,
    totalTaken,
    closingBalance: closing,
    closingDirection: direction,
    // The sentence a shopkeeper actually reads: "₹50,000 Lena Hai".
    closingLabel:
      direction === "CLEAR"
        ? KHATA_LABEL.CLEAR
        : `${formatINR(Math.abs(closing))} ${KHATA_LABEL[direction]}`,
    creditLimit: party.creditLimit,
    availableCredit: party.creditLimit > 0 ? Math.max(0, party.creditLimit - creditUsed) : 0,
    isOverLimit: party.creditLimit > 0 && creditUsed > party.creditLimit,
    entries: rows,
    from: options.from ? options.from.toISOString() : null,
    to: options.to ? options.to.toISOString() : null,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Adjustments (§25)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Correct a balance — by POSTING, never by writing to a field.
 *
 * An adjustment is an ordinary double-entry transaction whose other side lands on the
 * suspense account by default. Suspense is the right home for a difference nobody has
 * explained yet: the books stay balanced, and the unexplained amount sits in an account
 * whose entire purpose is to be conspicuous until someone clears it.
 *
 * `reason` is mandatory at the schema level and is written verbatim into the audit trail.
 */
export async function createAdjustment(
  input: CreateAdjustmentInput,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  return withTransaction(async (session) => {
    let targetLedgerId: Types.ObjectId;
    let label: string;

    if (input.partyId) {
      const party = await accounts.resolveParty(input.partyId, input.branchId, session);
      targetLedgerId = party.ledgerAccountId;
      label = `${party.name} (${party.code})`;
    } else if (input.accountId) {
      const account = await accounts.resolveAccount(input.accountId, input.branchId, session);
      targetLedgerId = account.ledgerAccountId;
      label = account.label;
    } else {
      throw new BadRequestError("Choose a party or an account to adjust", "partyId");
    }

    const counterId = input.counterAccountId
      ? new Types.ObjectId(input.counterAccountId)
      : await ledger.systemAccountId("SUSPENSE", session);

    const magnitude = Math.abs(input.amount);

    // A positive adjustment increases the target's balance, so it debits an asset-normal
    // account and credits the counter. Negative reverses the pair.
    const lines: ledger.PostingLine[] =
      input.amount > 0
        ? [
            { ledgerAccountId: targetLedgerId, direction: "DEBIT", amount: magnitude },
            { ledgerAccountId: counterId, direction: "CREDIT", amount: magnitude },
          ]
        : [
            { ledgerAccountId: counterId, direction: "DEBIT", amount: magnitude },
            { ledgerAccountId: targetLedgerId, direction: "CREDIT", amount: magnitude },
          ];

    const txn = await ledger.postTransaction(
      {
        type: "ADJUSTMENT",
        date: input.date,
        branchId: input.branchId,
        lines,
        grossAmount: magnitude,
        narration: input.notes ?? `Adjustment — ${label}`,
        partyId: input.partyId ?? null,
        createdBy: ctx.userId!,
        // An adjustment may legitimately take an account negative — correcting an
        // over-recorded receipt is exactly that. Blocking it would make the error
        // permanent.
        allowOverdraft: true,
        details: {
          adjustmentType: input.adjustmentType,
          reason: input.reason,
        },
      },
      session,
      { ...ctx, branchId: String(input.branchId) },
    );

    // A second, explicitly-labelled audit row. The POST row records the movement; this one
    // records that a human deliberately corrected a balance and why — which is the
    // question an auditor actually asks.
    await audit.record(
      { ...ctx, branchId: String(input.branchId) },
      {
        action: "BALANCE_ADJUSTED",
        entity: "Transaction",
        entityId: String(txn._id),
        entityLabel: `${txn.txnNo} — ${label}`,
        amount: input.amount,
        reason: input.reason,
        newValue: { adjustmentType: input.adjustmentType, amount: input.amount, target: label },
      },
      session,
    );

    return txn;
  }, { label: "adjustment.create" });
}

/* -------------------------------------------------------------------------- */
/* Credit and aging (§12)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Age a party's outstanding balance into buckets.
 *
 * The method is FIFO against the open entries: the balance a party owes today is made up
 * of the oldest unsettled debits, so payments are applied to the oldest first. That is how
 * a collections team reasons about it — "which invoice is 90 days late", not "what is the
 * average age of the balance".
 *
 * Only a POSITIVE balance ages. If we owe them, there is nothing to collect.
 */
async function ageParty(
  party: PartyDoc & { branchId: { _id: Types.ObjectId; code: string } },
  balance: number,
  asOf: Date,
): Promise<{ buckets: Record<AgingBucketKey, number>; daysOverdue: number; overdueAmount: number; dueDate: string | null; last: Date | null }> {
  const empty: Record<AgingBucketKey, number> = { current: 0, b31_60: 0, b61_90: 0, b90plus: 0 };

  const entries = await LedgerEntry.find({ ledgerAccountId: party.ledgerAccountId })
    .sort({ date: 1, _id: 1 })
    .select("date direction amount")
    .lean();

  const last = entries.length > 0 ? entries.at(-1)!.date : null;
  if (balance <= 0) return { buckets: empty, daysOverdue: 0, overdueAmount: 0, dueDate: null, last };

  /**
   * Walk forward applying credits against the oldest open debits, leaving the lots that
   * still make up today's balance.
   *
   * `unapplied` carries forward a credit that arrives with nothing yet to settle — a
   * payment received in advance, or simply an opening balance dated later than the
   * activity it relates to. An earlier version discarded those credits, which inflated
   * every bucket: the party's aged total came to more than the balance they actually
   * owed, and the discrepancy grew with each advance payment.
   */
  const open: Array<{ date: Date; amount: number }> = [];
  let unapplied = 0;

  for (const entry of entries) {
    if (entry.direction === "DEBIT") {
      let amount = entry.amount;
      // Settle against any credit still waiting for something to pay off.
      if (unapplied > 0) {
        const applied = Math.min(unapplied, amount);
        unapplied -= applied;
        amount -= applied;
      }
      if (amount > 0) open.push({ date: entry.date, amount });
      continue;
    }

    let remaining = entry.amount;
    while (remaining > 0 && open.length > 0) {
      const lot = open[0]!;
      const applied = Math.min(lot.amount, remaining);
      lot.amount -= applied;
      remaining -= applied;
      if (lot.amount === 0) open.shift();
    }
    // Whatever the credit could not settle waits for the next debit.
    unapplied += remaining;
  }

  const buckets = { ...empty };
  let overdueAmount = 0;
  let oldestOverdue: Date | null = null;

  for (const lot of open) {
    if (lot.amount <= 0) continue;
    // The clock starts when payment falls due, not when the debit was raised — a party on
    // 30-day terms is not overdue on day 29.
    const due = new Date(lot.date.getTime() + party.creditDays * 86_400_000);
    const daysPastDue = Math.max(0, daysBetween(due, asOf));
    buckets[agingBucket(daysPastDue)] += lot.amount;

    if (daysPastDue > 0) {
      overdueAmount += lot.amount;
      if (!oldestOverdue || due < oldestOverdue) oldestOverdue = due;
    }
  }

  const oldestOpen = open.find((l) => l.amount > 0);
  const dueDate = oldestOpen
    ? new Date(oldestOpen.date.getTime() + party.creditDays * 86_400_000).toISOString()
    : null;

  return {
    buckets,
    daysOverdue: oldestOverdue ? daysBetween(oldestOverdue, asOf) : 0,
    overdueAmount,
    dueDate,
    last,
  };
}

export async function creditReport(
  scopeFilter: Record<string, unknown>,
  options: { overLimit?: boolean; overdueOnly?: boolean; bucket?: AgingBucketKey; limit?: number } = {},
): Promise<{ rows: AgingRow[]; summary: CreditSummary }> {
  const parties = await Party.find({ ...scopeFilter, status: "ACTIVE" })
    .populate<{ branchId: { _id: Types.ObjectId; code: string } }>("branchId", "code")
    .lean();

  const ledgerIds = parties.map((p) => p.ledgerAccountId);
  const balances = await LedgerAccount.find({ _id: { $in: ledgerIds } })
    .select("cachedBalance")
    .lean();
  const balanceById = new Map(balances.map((b) => [String(b._id), b.cachedBalance]));

  const asOf = new Date();
  const rows: AgingRow[] = [];

  for (const party of parties) {
    const balance = balanceById.get(String(party.ledgerAccountId)) ?? 0;
    const aged = await ageParty(party as never, balance, asOf);
    const creditUsed = Math.max(0, balance);

    rows.push({
      partyId: String(party._id),
      name: party.name,
      code: party.code,
      type: party.type,
      mobile: party.mobile,
      branch: { id: String(party.branchId._id), code: party.branchId.code },
      balance,
      creditLimit: party.creditLimit,
      creditDays: party.creditDays,
      availableCredit: party.creditLimit > 0 ? Math.max(0, party.creditLimit - creditUsed) : 0,
      isOverLimit: party.creditLimit > 0 && creditUsed > party.creditLimit,
      buckets: aged.buckets,
      daysOverdue: aged.daysOverdue,
      overdueAmount: aged.overdueAmount,
      dueDate: aged.dueDate,
      lastTransactionAt: aged.last ? aged.last.toISOString() : null,
    });
  }

  // Summary is computed over ALL rows before filtering, so the headline figures describe
  // the book rather than whatever subset is on screen.
  const summary: CreditSummary = {
    totalOutstanding: rows.reduce((s, r) => s + Math.max(0, r.balance), 0),
    totalOverdue: rows.reduce((s, r) => s + r.overdueAmount, 0),
    dueToday: 0,
    dueThisWeek: 0,
    buckets: { current: 0, b31_60: 0, b61_90: 0, b90plus: 0 },
    partyCount: rows.filter((r) => r.balance > 0).length,
    overLimitCount: rows.filter((r) => r.isOverLimit).length,
    topDebtors: [...rows]
      .filter((r) => r.balance > 0)
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 5)
      .map((r) => ({ id: r.partyId, name: r.name, balance: r.balance })),
    topCreditors: [...rows]
      .filter((r) => r.balance < 0)
      .sort((a, b) => a.balance - b.balance)
      .slice(0, 5)
      .map((r) => ({ id: r.partyId, name: r.name, balance: Math.abs(r.balance) })),
  };

  const weekFromNow = new Date(asOf.getTime() + 7 * 86_400_000);
  for (const row of rows) {
    for (const key of Object.keys(summary.buckets) as AgingBucketKey[]) {
      summary.buckets[key] += row.buckets[key];
    }
    if (row.dueDate) {
      const due = new Date(row.dueDate);
      if (daysBetween(asOf, due) === 0) summary.dueToday += Math.max(0, row.balance);
      else if (due > asOf && due <= weekFromNow) summary.dueThisWeek += Math.max(0, row.balance);
    }
  }

  let filtered = rows;
  if (options.overLimit) filtered = filtered.filter((r) => r.isOverLimit);
  if (options.overdueOnly) filtered = filtered.filter((r) => r.overdueAmount > 0);
  if (options.bucket) filtered = filtered.filter((r) => r.buckets[options.bucket!] > 0);

  filtered.sort((a, b) => b.balance - a.balance);
  if (options.limit) filtered = filtered.slice(0, options.limit);

  return { rows: filtered, summary };
}
