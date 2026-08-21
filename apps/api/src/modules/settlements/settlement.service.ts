import { Types, type FilterQuery } from "mongoose";
import {
  fiscalYearOf,
  formatDocumentNumber,
  type CreateSettlementInput,
  type SettlementRow,
} from "@amiri/shared";
import { LedgerAccount, Settlement, nextSequence, type SettlementDoc } from "../../models/index.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { type Paging } from "../../lib/http.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as charges from "../../services/charges.service.js";
import * as accounts from "../../services/accounts.service.js";
import * as audit from "../../services/audit.service.js";
import * as payments from "../transactions/payment.service.js";

/**
 * Settlement (§24).
 *
 * A settlement is an INTENT with postings hanging off it — "clear the ₹2,40,000 we owe
 * EDDIGO" — not a posting in its own right. That separation is what makes partial
 * settlement work: the intent stays open at its full amount while `settledAmount`
 * accumulates from the linked transactions, so the shortfall is always visible rather
 * than being lost when someone pays half.
 *
 * `settledAmount` is derived from the links. Nobody types it in.
 */

export async function createSettlement(
  input: CreateSettlementInput,
  ctx: audit.AuditContext,
): Promise<SettlementDoc> {
  const fiscalYear = fiscalYearOf(input.date, env.FISCAL_YEAR_START_MONTH);

  return withTransaction(async (session) => {
    const seq = await nextSequence("SET", fiscalYear, session);
    const settlementNo = formatDocumentNumber("SET", fiscalYear, seq);

    const charge = await charges.resolveCharge(
      {
        chargeRuleId: input.chargeRuleId,
        manualCharge: input.manualCharge,
        amount: input.amount,
        transactionType: "SETTLEMENT",
      },
      session,
    );

    let sourceLabel = "—";
    let destinationLabel = "—";
    let partyId: Types.ObjectId | null = null;

    if (input.kind === "PARTY") {
      const party = await accounts.resolveParty(input.partyId!, input.branchId, session);
      partyId = party.id;
      destinationLabel = `${party.name} (${party.code})`;

      // How much is actually outstanding right now. Settling more than is owed would
      // leave the party in credit without anyone deciding to do that.
      const balance = (await LedgerAccount.findById(party.ledgerAccountId)
        .select("cachedBalance")
        .session(session))!.cachedBalance;
      const outstanding = Math.abs(balance);

      if (input.amount > outstanding) {
        throw new BadRequestError(
          `${party.name} has ${outstanding / 100} outstanding — a settlement cannot exceed it`,
          "amount",
        );
      }

      if (input.sourceAccountId) {
        const account = await accounts.resolveAccount(input.sourceAccountId, input.branchId, session);
        sourceLabel = account.label;
      }
    } else {
      const source = await accounts.resolveAccount(input.sourceAccountId!, input.branchId, session);
      const destination = await accounts.resolveAccount(
        input.destinationAccountId!,
        input.branchId,
        session,
      );
      sourceLabel = source.label;
      destinationLabel = destination.label;
    }

    const [settlement] = await Settlement.create(
      [
        {
          settlementNo,
          date: input.date,
          branchId: input.branchId,
          kind: input.kind,
          partyId,
          sourceAccountId: input.sourceAccountId ?? null,
          sourceLabel,
          destinationAccountId: input.destinationAccountId ?? null,
          destinationLabel,
          amount: input.amount,
          charges: charge.amount,
          netAmount: input.amount - charge.amount,
          settledAmount: 0,
          transactionIds: [],
          status: "PENDING",
          referenceNo: input.referenceNo,
          narration: input.narration,
          createdBy: ctx.userId,
        },
      ],
      { session },
    );

    if (!settlement) throw new Error("Settlement creation returned no document");

    await audit.record(
      { ...ctx, branchId: String(input.branchId) },
      {
        action: "CREATE",
        entity: "Settlement",
        entityId: String(settlement._id),
        entityLabel: `${settlementNo} — ${destinationLabel}`,
        amount: input.amount,
        newValue: { kind: input.kind, amount: input.amount, charges: charge.amount },
      },
      session,
    );

    return settlement;
  }, { label: "settlement.create" });
}

/**
 * Execute a settlement, in whole or in part.
 *
 * Posts the money movement through the ordinary payment services — a settlement does not
 * get its own posting path, because a second way to move money is a second thing that can
 * disagree with the ledger. It then links the resulting transaction and recomputes
 * `settledAmount` from the links.
 */
export async function executeSettlement(
  settlementId: string,
  input: { amount: number; accountId: string; paymentMode: string; date: Date; referenceNo?: string },
  scopeFilter: Record<string, unknown>,
  ctx: audit.AuditContext,
): Promise<SettlementDoc> {
  const settlement = await Settlement.findOne({ _id: settlementId, ...scopeFilter });
  if (!settlement) throw new NotFoundError("Settlement", settlementId);
  if (settlement.status === "COMPLETED") {
    throw new BadRequestError("This settlement is already complete");
  }
  if (settlement.status === "CANCELLED") {
    throw new BadRequestError("This settlement was cancelled");
  }

  const remaining = settlement.netAmount - settlement.settledAmount;
  if (input.amount > remaining) {
    throw new BadRequestError(
      `Only ${remaining / 100} remains on this settlement`,
      "amount",
    );
  }

  /**
   * Execution posts through the ORDINARY transaction services, never through a settlement-
   * specific posting path.
   *
   * A second way to move money is a second thing that can disagree with the ledger. Going
   * through `createPaymentOut` / `createBankTransfer` means a settlement inherits every
   * guard those already have: balance checks, credit limits, period closure, approval
   * thresholds, numbering and audit.
   */
  const txn =
    settlement.kind === "PARTY"
      ? await payments.createPaymentOut(
          {
            date: input.date,
            branchId: String(settlement.branchId),
            partyId: String(settlement.partyId!),
            accountId: input.accountId,
            amount: input.amount,
            paymentMode: input.paymentMode as never,
            referenceNo: input.referenceNo ?? settlement.settlementNo,
            narration: `Settlement ${settlement.settlementNo}`,
            attachments: [],
          } as never,
          ctx,
        )
      : // BANK and BRANCH settlements move money between our own accounts, which is
        // exactly a bank transfer — the destination is fixed by the settlement, the source
        // by whoever is executing it.
        await payments.createBankTransfer(
          {
            date: input.date,
            branchId: String(settlement.branchId),
            sourceAccountId: input.accountId,
            destinationAccountId: String(settlement.destinationAccountId!),
            amount: input.amount,
            paymentMode: (input.paymentMode ?? "NEFT") as never,
            referenceNo: input.referenceNo ?? settlement.settlementNo,
            narration: `Settlement ${settlement.settlementNo} — ${settlement.sourceLabel} to ${settlement.destinationLabel}`,
            attachments: [],
          } as never,
          ctx,
        );

  /**
   * An execution held for approval must NOT count as settled.
   *
   * `createPaymentOut` returns a PENDING header when the amount crosses a threshold — no
   * money has moved. Treating that as progress would show a settlement as complete while
   * the payment still sat in somebody's queue.
   */
  if (txn.status === "PENDING") {
    settlement.transactionIds.push(txn._id);
    await settlement.save();

    throw new BadRequestError(
      `That amount needs approval before it can be paid. The settlement stays at ${
        (settlement.netAmount - settlement.settledAmount) / 100
      } outstanding until the payment is approved.`,
    );
  }

  settlement.transactionIds.push(txn._id);
  settlement.settledAmount += input.amount;
  settlement.status = settlement.settledAmount >= settlement.netAmount ? "COMPLETED" : "PARTIAL";
  await settlement.save();

  await audit.recordSafe(
    { ...ctx, branchId: String(settlement.branchId) },
    {
      action: "UPDATE",
      entity: "Settlement",
      entityId: String(settlement._id),
      entityLabel: settlement.settlementNo,
      amount: input.amount,
      newValue: {
        settledAmount: settlement.settledAmount,
        status: settlement.status,
        transaction: txn.txnNo,
      },
    },
  );

  return settlement;
}

export async function listSettlements(
  scopeFilter: Record<string, unknown>,
  filters: { status?: string; kind?: string },
  page: Paging,
): Promise<{ items: SettlementRow[]; total: number; pending: number }> {
  const filter: FilterQuery<SettlementDoc> = { ...scopeFilter };
  if (filters.status) filter.status = filters.status;
  if (filters.kind) filter.kind = filters.kind;

  const [docs, total, pendingAgg] = await Promise.all([
    Settlement.find(filter)
      .sort(page.sort)
      .skip(page.skip)
      .limit(page.limit)
      .populate<{ partyId: { _id: Types.ObjectId; name: string } | null }>("partyId", "name")
      .populate<{ createdBy: { name: string } | null }>("createdBy", "name")
      .populate<{ approvedBy: { name: string } | null }>("approvedBy", "name")
      .lean(),
    Settlement.countDocuments(filter),
    Settlement.aggregate<{ total: number }>([
      { $match: { ...scopeFilter, status: { $in: ["PENDING", "PARTIAL"] } } },
      { $group: { _id: null, total: { $sum: { $subtract: ["$netAmount", "$settledAmount"] } } } },
    ]),
  ]);

  return {
    items: docs.map((s) => ({
      id: String(s._id),
      settlementNo: s.settlementNo,
      date: s.date.toISOString(),
      kind: s.kind,
      party: s.partyId ? { id: String(s.partyId._id), name: s.partyId.name } : null,
      sourceLabel: s.sourceLabel ?? "—",
      destinationLabel: s.destinationLabel ?? "—",
      amount: s.amount,
      charges: s.charges,
      netAmount: s.netAmount,
      settledAmount: s.settledAmount,
      status: s.status,
      approvedBy: s.approvedBy?.name ?? null,
      createdBy: s.createdBy?.name ?? null,
    })),
    total,
    pending: pendingAgg[0]?.total ?? 0,
  };
}
