import { Types } from "mongoose";
import { REVERSAL_PREFIX, canTransition, fiscalYearOf, formatDocumentNumber } from "@amiri/shared";
import {
  LedgerAccount,
  LedgerEntry,
  Transaction,
  nextSequence,
  type TransactionDoc,
} from "../../models/index.js";
import {
  AlreadyReversedError,
  BadRequestError,
  NotFoundError,
  StateConflictError,
} from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Transaction reversal (§28).
 *
 * NOTHING IS EVER DELETED. A mistaken transaction is cancelled by posting its exact
 * mirror image: every DEBIT becomes a CREDIT and every CREDIT a DEBIT, for the same
 * amounts against the same accounts. Both documents remain visible forever and point at
 * each other.
 *
 *     PAY-OUT-2026-000123     the original, now marked REVERSED
 *     REV-2026-000001         the reversal, linked to it
 *
 * Why mirror rather than delete: the balance is the sum of an append-only list. Deleting
 * an entry would change a balance with no record of why, and "explain this balance"
 * becomes unanswerable. Mirroring nets the effect to zero while leaving the whole story
 * on the page.
 */

export interface ReverseOptions {
  reason: string;
  date?: Date;
}

export async function reverseTransaction(
  transactionId: string,
  options: ReverseOptions,
  scopeFilter: Record<string, unknown>,
  ctx: audit.AuditContext,
): Promise<{ original: TransactionDoc; reversal: TransactionDoc }> {
  return withTransaction(async (session) => {
    const original = await Transaction.findOne({ _id: transactionId, ...scopeFilter }).session(session);
    if (!original) throw new NotFoundError("Transaction", transactionId);

    // ── What may be reversed ────────────────────────────────────────────────
    if (original.reversedBy) {
      const existing = await Transaction.findById(original.reversedBy).select("txnNo").session(session).lean();
      throw new AlreadyReversedError(original.txnNo, existing?.txnNo ?? "a reversal");
    }

    if (original.reversalOf) {
      // Reversing a reversal would produce a re-application of the original under a
      // confusing number. If the reversal itself was a mistake, post the original
      // transaction again as a fresh entry — the intent then reads correctly on the page.
      throw new BadRequestError(
        `${original.txnNo} is itself a reversal. To reinstate the original, post a new transaction rather than reversing the reversal.`,
      );
    }

    if (!canTransition(original.status, "REVERSED")) {
      throw new StateConflictError(original.status, "REVERSED");
    }

    const entries = await LedgerEntry.find({ transactionId: original._id }).session(session).lean();
    if (entries.length === 0) {
      throw new BadRequestError(
        `${original.txnNo} has no ledger entries, so there is nothing to reverse.`,
      );
    }

    // ── Mirror every line ───────────────────────────────────────────────────
    const lines: ledger.PostingLine[] = entries.map((entry) => ({
      ledgerAccountId: entry.ledgerAccountId,
      direction: entry.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
      amount: entry.amount,
      narration: `Reversal of ${original.txnNo}`,
    }));

    /**
     * Carry the original's type-specific fields onto the reversal.
     *
     * The mirror is the same TYPE as what it cancels — reversing a bank transfer produces
     * a bank transfer — so the discriminator's required fields must be present. Copying
     * them also makes the reversal readable on its own: it names the same accounts, the
     * same category, the same invoice, so a reader is not forced to open the original to
     * understand what was undone.
     */
    const raw = original.toObject() as unknown as Record<string, unknown>;
    const BASE_FIELDS = new Set([
      "_id", "__v", "txnNo", "type", "date", "branchId", "status",
      "grossAmount", "chargeAmount", "netAmount", "paymentMode", "referenceNo",
      "narration", "partyId", "accountIds", "attachments", "notes", "approvals",
      "approvedBy", "approvedAt", "postedAt", "periodId", "reversalOf", "reversedBy",
      "reversalReason", "fiscalYear", "createdBy", "updatedBy", "createdAt", "updatedAt",
      "id",
    ]);

    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!BASE_FIELDS.has(key) && value !== undefined) details[key] = value;
    }

    const date = options.date ?? new Date();
    const fiscalYear = fiscalYearOf(date, env.FISCAL_YEAR_START_MONTH);
    const seq = await nextSequence(REVERSAL_PREFIX, fiscalYear, session);
    const reversalNo = formatDocumentNumber(REVERSAL_PREFIX, fiscalYear, seq);

    const reversal = await ledger.postTransaction(
      {
        type: original.type,
        date,
        branchId: original.branchId ?? null,
        lines,
        grossAmount: original.grossAmount,
        chargeAmount: original.chargeAmount,
        // The mirror settles for exactly what the original settled, whichever way its
        // charge went. Recomputing it here would give the reversal a different net from
        // the entry it cancels.
        netAmount: original.netAmount,
        paymentMode: original.paymentMode,
        referenceNo: original.referenceNo,
        narration: `Reversal of ${original.txnNo} — ${options.reason}`,
        partyId: original.partyId,
        txnNo: reversalNo,
        reversalOf: original._id,
        createdBy: ctx.userId!,
        details,
        /**
         * A reversal is never blocked by a funds check.
         *
         * Reversing a payment-in credits the bank back out; if that money has since been
         * spent, the account would briefly go below zero. Refusing on those grounds would
         * make an erroneous entry permanently uncorrectable, which is far worse than a
         * temporary negative balance that the books themselves explain.
         */
        allowOverdraft: true,
      },
      session,
      { ...ctx, branchId: original.branchId ? String(original.branchId) : null },
    );

    // ── Link the pair, both ways ────────────────────────────────────────────
    original.status = "REVERSED";
    original.reversedBy = reversal._id;
    original.reversalReason = options.reason;
    original.updatedBy = ctx.userId ? new Types.ObjectId(ctx.userId) : undefined;
    await original.save({ session });

    await audit.record(
      { ...ctx, branchId: original.branchId ? String(original.branchId) : null },
      {
        action: "REVERSE",
        entity: "Transaction",
        entityId: String(original._id),
        entityLabel: original.txnNo,
        amount: original.grossAmount,
        // The reason is mandatory and is stored verbatim. "Why was ₹9,50,000 undone" has
        // to be answerable years later, by someone who was not here.
        reason: options.reason,
        oldValue: { status: "COMPLETED", reversedBy: null },
        newValue: { status: "REVERSED", reversedBy: reversal.txnNo },
      },
      session,
    );

    return { original, reversal };
  }, { label: "transaction.reverse" });
}

/**
 * Confirm that a reversed pair nets to zero on every account it touched.
 *
 * Used by the tests and available as a diagnostic. If this ever returns a non-zero delta,
 * the mirroring is wrong and the reversal did not fully cancel the original.
 */
export async function verifyReversal(originalId: string): Promise<{
  balanced: boolean;
  perAccount: Array<{ account: string; delta: number }>;
}> {
  const original = await Transaction.findById(originalId).lean();
  if (!original?.reversedBy) throw new NotFoundError("Reversal for transaction", originalId);

  const entries = await LedgerEntry.find({
    transactionId: { $in: [original._id, original.reversedBy] },
  }).lean();

  const byAccount = new Map<string, number>();
  for (const entry of entries) {
    const key = String(entry.ledgerAccountId);
    const signed = entry.direction === "DEBIT" ? entry.amount : -entry.amount;
    byAccount.set(key, (byAccount.get(key) ?? 0) + signed);
  }

  const accountDocs = await LedgerAccount.find({ _id: { $in: [...byAccount.keys()] } })
    .select("name")
    .lean();
  const names = new Map(accountDocs.map((a) => [String(a._id), a.name]));

  const perAccount = [...byAccount.entries()].map(([id, delta]) => ({
    account: names.get(id) ?? id,
    delta,
  }));

  return { balanced: perAccount.every((a) => a.delta === 0), perAccount };
}
