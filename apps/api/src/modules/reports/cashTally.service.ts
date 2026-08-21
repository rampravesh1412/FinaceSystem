import { Types } from "mongoose";
import {
  endOfDay,
  startOfDay,
  tallyStatus,
  type CashTally,
  type RecordTallyInput,
} from "@amiri/shared";
import {
  Branch,
  CashAccount,
  DailyCashTally,
  LedgerAccount,
  LedgerEntry,
  type DailyCashTallyDoc,
} from "../../models/index.js";
import { NotFoundError } from "../../lib/errors.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as reports from "../../services/reports.service.js";
import * as audit from "../../services/audit.service.js";
import * as notifications from "../notifications/notification.service.js";

/**
 * Daily Cash Tally (§20).
 *
 * The arithmetic, in the AMIRI workbook's own terms:
 *
 *     Opening Cash
 *   + Cash Received
 *   − Cash Paid
 *   ± Adjustments
 *   ─────────────────
 *   = Expected Closing        ← derived from the ledger; nobody types it
 *
 *     Actual Closing          ← the ONLY figure a human enters: what was counted
 *   − Expected Closing
 *   ─────────────────
 *   = Difference              → MATCHED / SHORT / EXCESS
 *
 * §62 decides what happens next, and it is the whole point of the module: if expected is
 * ₹10,00,000 and the drawer holds ₹9,80,000, the tally records SHORT ₹20,000 and stops.
 * It does NOT adjust the expectation to match the count. The discrepancy stays on the
 * record until someone finds the missing transaction — and if it turns out to be a genuine
 * loss, that is posted as an explicit adjustment with a reason attached, not absorbed here.
 */

/**
 * Compute the tally for a day, whether or not the drawer has been counted.
 *
 * Everything except `actualClosing` is derived, so opening this screen twice cannot
 * produce two different expectations.
 */
export async function getTally(
  date: Date,
  cashAccountId: string,
  scopeFilter: Record<string, unknown>,
): Promise<CashTally> {
  const cashAccount = await CashAccount.findOne({ _id: cashAccountId, ...scopeFilter })
    .populate<{ branchId: { _id: Types.ObjectId; name: string; code: string } }>("branchId", "name code")
    .lean();

  if (!cashAccount) throw new NotFoundError("Cash account", cashAccountId);

  const dayStart = startOfDay(date);
  const dayEnd = endOfDay(date);
  const branchId = String(cashAccount.branchId._id);

  // Opening: the drawer's position at the instant before the day began.
  const [openingAgg] = await LedgerEntry.aggregate<{ debit: number; credit: number }>([
    { $match: { ledgerAccountId: cashAccount.ledgerAccountId, date: { $lt: dayStart } } },
    {
      $group: {
        _id: null,
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
      },
    },
  ]);
  const openingCash = (openingAgg?.debit ?? 0) - (openingAgg?.credit ?? 0);

  /**
   * The day's movement, split by transaction type.
   *
   * Adjustments are separated from ordinary receipts and payments because §20 lists them
   * on their own line — an operator counting the drawer needs to see that ₹5,000 of the
   * expected figure came from a correction rather than from trade.
   */
  const movement = await LedgerEntry.aggregate<{ _id: string; debit: number; credit: number }>([
    {
      $match: {
        ledgerAccountId: cashAccount.ledgerAccountId,
        date: { $gte: dayStart, $lte: dayEnd },
      },
    },
    {
      $group: {
        _id: "$transactionType",
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
      },
    },
  ]);

  let cashReceived = 0;
  let cashPaid = 0;
  let adjustments = 0;

  for (const row of movement) {
    if (row._id === "ADJUSTMENT") {
      adjustments += row.debit - row.credit;
    } else {
      cashReceived += row.debit;
      cashPaid += row.credit;
    }
  }

  const expectedClosing = openingCash + cashReceived - cashPaid + adjustments;

  /* ── Context, as the AMIRI workbook presents it ──────────────────────────── */

  const partyAccounts = await LedgerAccount.find({ kind: "PARTY", branchId: cashAccount.branchId._id })
    .select("_id")
    .lean();

  const [partyMovement] = await LedgerEntry.aggregate<{ given: number; taken: number }>([
    {
      $match: {
        ledgerAccountId: { $in: partyAccounts.map((p) => p._id) },
        date: { $gte: dayStart, $lte: dayEnd },
      },
    },
    {
      $group: {
        _id: null,
        given: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        taken: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
      },
    },
  ]);

  const partyGiven = partyMovement?.given ?? 0;
  const partyTaken = partyMovement?.taken ?? 0;

  // Profit for the day — computed by the P&L engine, NOT from the cash movement above.
  // §21: a day with heavy cash turnover can still be a loss.
  const profit = await reports.profitFor({ from: dayStart, to: dayEnd, branchId });

  const existing = await DailyCashTally.findOne({
    cashAccountId: cashAccount._id,
    date: dayStart,
  })
    .populate<{ countedBy: { name: string } | null }>("countedBy", "name")
    .lean();

  const actualClosing = existing?.actualClosing ?? null;
  const difference = actualClosing === null ? null : actualClosing - expectedClosing;

  return {
    id: existing ? String(existing._id) : null,
    date: dayStart.toISOString(),
    branch: {
      id: branchId,
      name: cashAccount.branchId.name,
      code: cashAccount.branchId.code,
    },
    cashAccount: { id: String(cashAccount._id), name: cashAccount.name },

    openingCash,
    cashReceived,
    cashPaid,
    adjustments,
    expectedClosing,

    actualClosing,
    difference,
    status: difference === null ? "PENDING" : tallyStatus(difference),

    totalExpenses: profit.expenses,
    partyGiven,
    partyTaken,
    netPartyMovement: partyGiven - partyTaken,
    todayProfit: profit.profit,

    countedBy: existing?.countedBy?.name ?? null,
    countedAt: existing?.countedAt ? existing.countedAt.toISOString() : null,
    notes: existing?.notes,
  };
}

/**
 * Record what was counted.
 *
 * Stores the expected figure alongside the counted one, frozen at the moment of counting.
 * If a back-dated transaction later changes what "expected" would be, the tally still
 * shows what the operator was told at the time — which is what makes the record
 * meaningful as evidence rather than a number that silently rewrites itself.
 *
 * Note what this function does NOT do: it never posts an adjustment to make the drawer
 * agree. A shortfall is a finding, not a correction (§62). Writing it off is a separate,
 * separately-permissioned, separately-audited decision.
 */
export async function recordTally(
  input: RecordTallyInput,
  ctx: audit.AuditContext,
  scopeFilter: Record<string, unknown>,
): Promise<CashTally> {
  const computed = await getTally(input.date, input.cashAccountId, scopeFilter);
  const difference = input.actualClosing - computed.expectedClosing;
  const status = tallyStatus(difference);

  await withTransaction(async (session) => {
    await DailyCashTally.findOneAndUpdate(
      { cashAccountId: input.cashAccountId, date: startOfDay(input.date) },
      {
        $set: {
          branchId: input.branchId,
          expectedClosing: computed.expectedClosing,
          openingCash: computed.openingCash,
          cashReceived: computed.cashReceived,
          cashPaid: computed.cashPaid,
          adjustments: computed.adjustments,
          actualClosing: input.actualClosing,
          difference,
          status,
          countedBy: ctx.userId,
          countedAt: new Date(),
          notes: input.notes,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    );

    await audit.record(
      { ...ctx, branchId: input.branchId },
      {
        action: status === "MATCHED" ? "CREATE" : "BALANCE_ADJUSTED",
        entity: "DailyCashTally",
        entityId: `${input.cashAccountId}:${startOfDay(input.date).toISOString().slice(0, 10)}`,
        entityLabel: `${computed.cashAccount.name} — ${startOfDay(input.date).toISOString().slice(0, 10)}`,
        amount: difference,
        // A mismatch is recorded as a finding with its own words, so the audit trail says
        // what was counted and what was expected rather than just "tally saved".
        reason:
          status === "MATCHED"
            ? undefined
            : `Counted ${input.actualClosing / 100}, expected ${computed.expectedClosing / 100} — ${status}`,
        newValue: {
          expectedClosing: computed.expectedClosing,
          actualClosing: input.actualClosing,
          difference,
          status,
        },
      },
      session,
    );
  }, { label: "cashTally.record" });

  // A mismatch is worth telling somebody about; a clean tally is not.
  if (status !== "MATCHED") {
    await notifications.notifyCashTallyMismatch({
      branchId: input.branchId,
      drawer: `${computed.branch.code} — ${computed.cashAccount.name}`,
      difference,
      status,
      countedBy: ctx.userName,
    });
  }

  return { ...computed, actualClosing: input.actualClosing, difference, status, notes: input.notes };
}

/** Tally history for a cash account, newest first. */
export async function listTallies(
  cashAccountId: string,
  scopeFilter: Record<string, unknown>,
  limit = 60,
): Promise<DailyCashTallyDoc[]> {
  const cashAccount = await CashAccount.findOne({ _id: cashAccountId, ...scopeFilter }).lean();
  if (!cashAccount) throw new NotFoundError("Cash account", cashAccountId);

  return DailyCashTally.find({ cashAccountId: cashAccount._id })
    .sort({ date: -1 })
    .limit(limit)
    .populate("countedBy", "name")
    .lean() as never;
}

/** Every branch's default drawer, for the tally picker. */
export async function tallyTargets(scopeFilter: Record<string, unknown>) {
  const accounts = await CashAccount.find({ ...scopeFilter, status: "ACTIVE" })
    .populate<{ branchId: { _id: Types.ObjectId; name: string; code: string } }>("branchId", "name code")
    .sort({ name: 1 })
    .lean();

  const branches = await Branch.find({ status: "ACTIVE" }).select("code name").lean();
  const branchByC = new Map(branches.map((b) => [String(b._id), b]));

  return accounts.map((a) => ({
    id: String(a._id),
    name: a.name,
    branch: {
      id: String(a.branchId._id),
      code: a.branchId.code ?? branchByC.get(String(a.branchId._id))?.code ?? "",
      name: a.branchId.name,
    },
    isDefault: a.isDefault,
  }));
}
