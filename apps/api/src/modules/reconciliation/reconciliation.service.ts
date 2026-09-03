import { Types, type ClientSession } from "mongoose";
import {
  bankAccountLabel,
  daysBetween,
  type ImportStatementInput,
  type ReconciliationLineRow,
  type ReconciliationSummary,
  type StartReconciliationInput,
} from "@amiri/shared";
import {
  BankAccount,
  LedgerEntry,
  Reconciliation,
  ReconciliationLine,
  type ReconciliationDoc,
} from "../../models/index.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/errors.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Bank reconciliation (§23).
 *
 * Compares what the BANK says against what OUR LEDGER says, and lists everything that
 * does not agree.
 *
 * The governing rule is §62, and it shapes every function here: the difference is
 * REPORTED, never absorbed. If the statement says ₹9,80,000 and the ledger says
 * ₹10,00,000, this module says SHORT ₹20,000 and shows which lines are unexplained. It
 * will not write the bank's figure over ours — that would balance the screen and destroy
 * the only evidence that something is wrong.
 *
 * Completing a reconciliation with a non-zero difference is allowed, but only by posting
 * an explicit adjustment against suspense, which leaves a permanent, attributable record.
 */

/**
 * Load an open reconciliation, or behave as though it does not exist.
 *
 * Reconciliations are organisation-wide, because the account they reconcile is: the bank
 * issues one statement covering every counter's activity, so there is no per-branch share
 * of it that could tie. Access is governed by `finance.bank.reconcile` alone.
 *
 * Still routed through one loader rather than a bare `findById` at each call site, so the
 * NotFound behaviour and the open/closed checks stay in one place.
 */
async function loadScoped(reconciliationId: string, session?: ClientSession) {
  const query = Reconciliation.findOne({ _id: reconciliationId });
  if (session) query.session(session);
  const recon = await query;
  if (!recon) throw new NotFoundError("Reconciliation", reconciliationId);
  return recon;
}

export async function start(
  input: StartReconciliationInput,
  ctx: audit.AuditContext,
): Promise<ReconciliationDoc> {
  const account = await BankAccount.findById(input.bankAccountId)
    .populate<{ bankId: { name: string; shortName?: string } }>("bankId", "name shortName")
    .lean();

  if (!account) throw new NotFoundError("Bank account", input.bankAccountId);
  if (input.from > input.to) {
    throw new BadRequestError("The start date must not be after the end date", "from");
  }

  const open = await Reconciliation.findOne({
    bankAccountId: account._id,
    status: "IN_PROGRESS",
  }).lean();
  if (open) {
    throw new ConflictError(
      "A reconciliation is already open for this account. Finish or abandon it first.",
    );
  }

  // Our balance as at the statement's closing date, computed from ENTRIES rather than the
  // cached figure — a reconciliation exists to validate the books, so it must not lean on
  // the cache it is checking.
  const { balance: systemBalance } = await ledger.computeBalance(account.ledgerAccountId, {
    asOf: input.to,
  });

  return withTransaction(async (session) => {
    const [recon] = await Reconciliation.create(
      [
        {
          bankAccountId: account._id,
          ledgerAccountId: account.ledgerAccountId,
          from: input.from,
          to: input.to,
          statementBalance: input.statementBalance,
          systemBalance,
          difference: input.statementBalance - systemBalance,
          status: "IN_PROGRESS",
          createdBy: ctx.userId,
        },
      ],
      { session },
    );

    if (!recon) throw new Error("Reconciliation creation returned no document");

    await audit.record(
      ctx,
      {
        action: "CREATE",
        entity: "Reconciliation",
        entityId: String(recon._id),
        entityLabel: bankAccountLabel(account.bankId.shortName ?? account.bankId.name, account.accountNumber),
        amount: recon.difference,
        newValue: {
          statementBalance: input.statementBalance,
          systemBalance,
          difference: recon.difference,
        },
      },
      session,
    );

    return recon;
  }, { label: "reconciliation.start" });
}

/**
 * Import statement lines and auto-match what is unambiguous.
 *
 * Matching is deliberately conservative. A line is auto-matched only when exactly ONE
 * ledger entry fits on amount, direction and a close date — anything else is left for a
 * human, with suggestions ranked. An over-eager matcher that guesses wrong is far worse
 * than one that asks: a wrongly matched line hides a genuine discrepancy behind a tick.
 */
export async function importStatement(
  reconciliationId: string,
  input: ImportStatementInput,
  ctx: audit.AuditContext,
): Promise<{ imported: number; autoMatched: number }> {
  const recon = await loadScoped(reconciliationId);
  if (recon.status !== "IN_PROGRESS") {
    throw new ConflictError("This reconciliation is no longer open");
  }

  // Every ledger entry in the window that has not already been reconciled elsewhere.
  const candidates = await LedgerEntry.find({
    ledgerAccountId: recon.ledgerAccountId,
    date: { $gte: recon.from, $lte: recon.to },
    reconciledAt: null,
  })
    .select("date direction amount txnNo narration referenceNo")
    .lean();

  const claimed = new Set<string>();
  let autoMatched = 0;

  const docs = input.lines.map((line) => {
    // The bank's sign convention is the mirror of ours: a credit on their statement is
    // money arriving, which is a DEBIT on our asset account.
    const wantedDirection = line.amount > 0 ? "DEBIT" : "CREDIT";
    const magnitude = Math.abs(line.amount);

    const fits = candidates.filter(
      (c) =>
        !claimed.has(String(c._id)) &&
        c.amount === magnitude &&
        c.direction === wantedDirection &&
        Math.abs(daysBetween(c.date, line.date)) <= 3,
    );

    // Exactly one candidate, or it stays for a human.
    if (fits.length === 1) {
      const match = fits[0]!;
      claimed.add(String(match._id));
      autoMatched += 1;
      return {
        reconciliationId: recon._id,
        date: line.date,
        description: line.description,
        referenceNo: line.referenceNo,
        amount: line.amount,
        status: "MATCHED" as const,
        ledgerEntryId: match._id,
        matchedBy: ctx.userId,
        matchedAt: new Date(),
      };
    }

    return {
      reconciliationId: recon._id,
      date: line.date,
      description: line.description,
      referenceNo: line.referenceNo,
      amount: line.amount,
      // Several candidates is NOT a match — it is a question. Flagging it as such is the
      // difference between a reconciliation and a rubber stamp.
      status: fits.length > 1 ? ("NEEDS_REVIEW" as const) : ("MISSING_IN_SYSTEM" as const),
      ledgerEntryId: null,
    };
  });

  await ReconciliationLine.insertMany(docs);

  /**
   * Ledger entries with no statement line: money we recorded that the bank did not.
   *
   * These are recorded as MISSING_IN_BANK lines rather than left implicit. An uncleared
   * cheque is the benign case; a payment recorded twice is not, and it only becomes
   * visible if the unmatched side is listed too.
   */
  const unmatchedEntries = candidates.filter((c) => !claimed.has(String(c._id)));
  if (unmatchedEntries.length > 0) {
    await ReconciliationLine.insertMany(
      unmatchedEntries.map((entry) => ({
        reconciliationId: recon._id,
        date: entry.date,
        description: entry.narration ?? `${entry.txnNo} — not on the statement`,
        referenceNo: entry.txnNo,
        amount: entry.direction === "DEBIT" ? entry.amount : -entry.amount,
        status: "MISSING_IN_BANK" as const,
        ledgerEntryId: entry._id,
      })),
    );
  }

  await audit.recordSafe(
    ctx,
    {
      action: "IMPORT",
      entity: "Reconciliation",
      entityId: String(recon._id),
      entityLabel: `${input.lines.length} statement lines`,
      newValue: { imported: input.lines.length, autoMatched, unmatchedInLedger: unmatchedEntries.length },
    },
  );

  return { imported: docs.length, autoMatched };
}

/** Match, unmatch or reclassify one line. */
export async function setLineStatus(
  lineId: string,
  update: { ledgerEntryId?: string | null; status?: string },
  ctx: audit.AuditContext,
): Promise<void> {
  const line = await ReconciliationLine.findById(lineId);
  if (!line) throw new NotFoundError("Statement line", lineId);

  // Scoped through the PARENT: the line carries no branch of its own, so its owner is
  // whichever reconciliation it belongs to — and that lookup is where isolation applies.
  const recon = await loadScoped(String(line.reconciliationId));
  if (recon.status !== "IN_PROGRESS") {
    throw new ConflictError("This reconciliation is no longer open");
  }

  await withTransaction(async (session) => {
    // Release the previously matched entry so it can be matched to something else.
    if (line.ledgerEntryId) {
      await LedgerEntry.updateOne(
        { _id: line.ledgerEntryId },
        { $set: { reconciledAt: null, reconciliationId: null } },
        { session },
      );
    }

    if (update.ledgerEntryId) {
      const entry = await LedgerEntry.findById(update.ledgerEntryId).session(session).lean();
      if (!entry) throw new NotFoundError("Ledger entry", update.ledgerEntryId);
      if (!entry.ledgerAccountId.equals(recon.ledgerAccountId)) {
        throw new BadRequestError("That entry belongs to a different account");
      }

      // The only sanctioned mutation of a posted ledger entry, and it touches no financial
      // field — see the guard in LedgerEntry.
      await LedgerEntry.updateOne(
        { _id: entry._id },
        { $set: { reconciledAt: new Date(), reconciliationId: recon._id } },
        { session },
      );

      line.ledgerEntryId = new Types.ObjectId(update.ledgerEntryId);
      line.status = "MATCHED";
    } else {
      line.ledgerEntryId = null;
      line.status = (update.status as never) ?? "UNMATCHED";
    }

    line.matchedBy = ctx.userId ? new Types.ObjectId(ctx.userId) : null;
    line.matchedAt = new Date();
    await line.save({ session });
  }, { label: "reconciliation.match" });
}

export async function getSummary(
  reconciliationId: string,
): Promise<ReconciliationSummary> {
  const recon = await Reconciliation.findOne({ _id: reconciliationId })
    .populate<{
      bankAccountId: {
        _id: Types.ObjectId;
        accountNumber: string;
        accountName: string;
        bankId: Types.ObjectId;
      };
    }>("bankAccountId", "accountNumber accountName bankId")
    .lean();

  if (!recon) throw new NotFoundError("Reconciliation", reconciliationId);

  const counts = await ReconciliationLine.aggregate<{ _id: string; n: number }>([
    { $match: { reconciliationId: recon._id } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const by = (status: string) => counts.find((c) => c._id === status)?.n ?? 0;

  return {
    id: String(recon._id),
    bankAccount: {
      id: String(recon.bankAccountId._id),
      // Masked: a reconciliation screen has no need for the full number.
      label: `${recon.bankAccountId.accountName} ••${recon.bankAccountId.accountNumber.slice(-4)}`,
    },
    from: recon.from.toISOString(),
    to: recon.to.toISOString(),
    statementBalance: recon.statementBalance,
    systemBalance: recon.systemBalance,
    difference: recon.difference,
    status: recon.status,
    counts: {
      matched: by("MATCHED"),
      unmatched: by("UNMATCHED"),
      missingInSystem: by("MISSING_IN_SYSTEM"),
      missingInBank: by("MISSING_IN_BANK"),
      duplicate: by("DUPLICATE"),
      needsReview: by("NEEDS_REVIEW"),
    },
    completedAt: recon.completedAt ? recon.completedAt.toISOString() : null,
    createdAt: recon.createdAt.toISOString(),
  };
}

/**
 * Reconciliations for the branches in scope, newest first.
 *
 * Returns the same summary shape as `getSummary` so the list and the detail screen agree
 * on what a reconciliation looks like — including `difference`, which is the column the
 * list exists to expose. A list that showed only IN_PROGRESS / COMPLETED would let a
 * closed-with-a-difference reconciliation look identical to a clean one.
 */
export async function list(
  filters: { bankAccountId?: string; status?: string },
  page: { skip: number; limit: number; sort: Record<string, 1 | -1> },
): Promise<{ items: ReconciliationSummary[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (filters.bankAccountId) filter.bankAccountId = new Types.ObjectId(filters.bankAccountId);
  if (filters.status) filter.status = filters.status;

  const [docs, total] = await Promise.all([
    Reconciliation.find(filter).sort(page.sort).skip(page.skip).limit(page.limit).select("_id").lean(),
    Reconciliation.countDocuments(filter),
  ]);

  // Summaries are built one at a time because each needs its own line-status aggregate.
  // The page limit keeps this bounded; a single $lookup pipeline would be faster and would
  // duplicate the summary shape in a second place, which is how the two drift apart.
  return {
    items: await Promise.all(docs.map((d) => getSummary(String(d._id)))),
    total,
  };
}

export async function getLines(
  reconciliationId: string,
): Promise<ReconciliationLineRow[]> {
  const recon = await Reconciliation.findOne({ _id: reconciliationId }).lean();
  if (!recon) throw new NotFoundError("Reconciliation", reconciliationId);

  const lines = await ReconciliationLine.find({ reconciliationId: recon._id })
    .sort({ date: 1, _id: 1 })
    .populate<{
      ledgerEntryId: { _id: Types.ObjectId; txnNo: string; amount: number; date: Date; narration?: string } | null;
    }>("ledgerEntryId", "txnNo amount date narration")
    .lean();

  // Candidates for the lines a human still has to decide on.
  const open = await LedgerEntry.find({
    ledgerAccountId: recon.ledgerAccountId,
    date: { $gte: recon.from, $lte: recon.to },
    reconciledAt: null,
  })
    .select("txnNo amount date direction")
    .lean();

  return lines.map((line) => {
    const suggestions =
      line.status === "MATCHED"
        ? []
        : open
            .filter((e) => e.amount === Math.abs(line.amount))
            .map((e) => ({
              id: String(e._id),
              txnNo: e.txnNo,
              amount: e.amount,
              date: e.date.toISOString(),
              // Amount already matches; closeness in date is what separates the options.
              confidence: Math.max(0, 100 - Math.abs(daysBetween(e.date, line.date)) * 10),
            }))
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 5);

    return {
      id: String(line._id),
      date: line.date.toISOString(),
      description: line.description,
      referenceNo: line.referenceNo,
      amount: line.amount,
      status: line.status,
      ledgerEntry: line.ledgerEntryId
        ? {
            id: String(line.ledgerEntryId._id),
            txnNo: line.ledgerEntryId.txnNo,
            amount: line.ledgerEntryId.amount,
            date: line.ledgerEntryId.date.toISOString(),
            narration: line.ledgerEntryId.narration,
          }
        : null,
      suggestions,
    };
  });
}

/**
 * Close a reconciliation.
 *
 * A non-zero difference does NOT block completion — sometimes the bank really is wrong,
 * or a cheque genuinely has not cleared. What it does is force the difference to be
 * acknowledged in writing. The unexplained amount stays visible on the record; it is never
 * quietly zeroed to make the screen look tidy (§62).
 */
export async function complete(
  reconciliationId: string,
  options: { notes?: string; acknowledgeDifference?: boolean },
  ctx: audit.AuditContext,
): Promise<ReconciliationDoc> {
  return withTransaction(async (session) => {
    const recon = await loadScoped(reconciliationId, session);
    if (recon.status !== "IN_PROGRESS") throw new ConflictError("This reconciliation is already closed");

    const unresolved = await ReconciliationLine.countDocuments({
      reconciliationId: recon._id,
      status: { $in: ["UNMATCHED", "NEEDS_REVIEW"] },
    }).session(session);

    if (unresolved > 0) {
      throw new ConflictError(
        `${unresolved} line${unresolved === 1 ? " is" : "s are"} still unresolved. ` +
          `Match them, or mark them as missing in the bank or the system.`,
      );
    }

    if (recon.difference !== 0 && !options.acknowledgeDifference) {
      throw new ConflictError(
        `The statement and the ledger differ by ${recon.difference > 0 ? "+" : ""}${recon.difference / 100}. ` +
          `Investigate it, or acknowledge the difference explicitly to close with it on the record.`,
      );
    }

    recon.status = "COMPLETED";
    recon.completedAt = new Date();
    recon.completedBy = ctx.userId ? new Types.ObjectId(ctx.userId) : null;
    recon.notes = options.notes;
    await recon.save({ session });

    await audit.record(
      ctx,
      {
        action: "RECONCILED",
        entity: "Reconciliation",
        entityId: String(recon._id),
        entityLabel: `${recon.from.toISOString().slice(0, 10)} to ${recon.to.toISOString().slice(0, 10)}`,
        amount: recon.difference,
        reason: options.notes,
        newValue: {
          statementBalance: recon.statementBalance,
          systemBalance: recon.systemBalance,
          // Recorded permanently, whatever it was.
          difference: recon.difference,
          acknowledged: Boolean(options.acknowledgeDifference),
        },
      },
      session,
    );

    return recon;
  }, { label: "reconciliation.complete" });
}
