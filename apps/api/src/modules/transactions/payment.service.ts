import { Types, type ClientSession } from "mongoose";
import {
  PAYMENT_MONEY_FIELDS,
  TRANSACTION_TYPE_LABEL,
  chargeEffect,
  settlementNet,
  type CreateBankTransferInput,
  type CreatePaymentInInput,
  type CreatePaymentOutInput,
  type PaymentEditResult,
  type UpdatePaymentInput,
} from "@amiri/shared";
import { LedgerAccount, Transaction, type TransactionDoc } from "../../models/index.js";
import {
  BadRequestError,
  CreditLimitExceededError,
  NotFoundError,
  SelfTransferError,
  StateConflictError,
} from "../../lib/errors.js";
import * as reversal_ from "./reversal.service.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as charges from "../../services/charges.service.js";
import * as accounts from "../../services/accounts.service.js";
import * as audit from "../../services/audit.service.js";
import * as approvals from "../governance/approval.service.js";

/**
 * Payment In, Payment Out and Bank Transfer.
 *
 * Each is a thin arrangement of ledger lines around `postTransaction` — or, when the
 * amount crosses an approval threshold (§27), around `submitForApproval`, which stores the
 * same lines WITHOUT posting them. `postOrSubmit` below is the single place that decision
 * is made, so no transaction type can forget to check.
 *
 * Each is a thin arrangement of ledger lines around `postTransaction`. All the hard
 * guarantees — balance assertion, funds check, atomicity, numbering, audit — live in the
 * engine. What these functions own is deciding WHICH accounts move and in which
 * direction, which is the part that differs per business event.
 */

/**
 * Post immediately, or hold for approval.
 *
 * The ONE place the threshold is consulted. Routing every money movement through here is
 * what makes it structurally impossible for a new transaction type to bypass the control
 * — a service that forgets to call this simply has no way to write to the ledger.
 */
async function postOrSubmit(
  input: ledger.PostTransactionInput,
  ctx: audit.AuditContext,
  session: ClientSession,
): Promise<TransactionDoc> {
  const tier = await approvals.requiredTier(input.grossAmount, input.type);

  if (!tier) {
    return ledger.postTransaction(input, session, ctx);
  }

  // Held: the lines are stored and NOTHING touches a balance until somebody approves.
  return approvals.submitForApproval({ ...input, requiredTier: tier }, ctx);
}

/* -------------------------------------------------------------------------- */
/* Payment In (§14)                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Money received from a party.
 *
 * The base posting:
 *
 *     DR  Bank/Cash          100,000     money arrives
 *         CR  Party                      100,000     their debt to us falls
 *
 * With a PARTY-borne charge (a distributor commission we keep), the full gross lands in
 * our account and the party is credited only the net:
 *
 *     DR  Bank/Cash          100,000
 *         CR  Party                       98,250
 *         CR  Commission Income            1,750
 *
 * With a SELF-borne charge (a collection fee our bank levies), the party's whole debt is
 * cleared and we absorb the fee:
 *
 *     DR  Bank/Cash           98,250
 *     DR  Bank Charges         1,750
 *         CR  Party                      100,000
 */
export async function createPaymentIn(
  input: CreatePaymentInInput,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  return withTransaction(
    (session) => postPaymentIn(input, ctx, session),
    { label: "paymentIn.create" },
  );
}

/**
 * The Payment In posting, against a session the caller owns.
 *
 * Split out so `editPayment` can reverse the original and post the corrected replacement
 * inside ONE transaction — see `reverseWithin` for why that matters.
 */
export async function postPaymentIn(
  input: CreatePaymentInInput,
  ctx: audit.AuditContext,
  session: ClientSession,
): Promise<TransactionDoc> {
  {
    // SEQUENTIAL, NOT Promise.all. A MongoDB ClientSession carries exactly one
    // in-flight operation: issuing two at once against the same session makes the driver
    // advance the transaction number under itself, and the second lands as
    // "Given transaction number N does not match any in-progress transactions".
    // The transaction then aborts — intermittently, and only under concurrency.
    const account = await accounts.resolveAccount(input.accountId, session);
    const party = await accounts.resolveParty(input.partyId, session);

    const charge = await charges.resolveCharge(
      {
        chargeRuleId: input.chargeRuleId,
        manualCharge: input.manualCharge,
        amount: input.amount,
        transactionType: "PAYMENT_IN",
        partyType: party.type,
      },
      session,
    );

    const lines: ledger.PostingLine[] = [];

    if (charge.amount === 0) {
      lines.push(
        { ledgerAccountId: account.ledgerAccountId, direction: "DEBIT", amount: input.amount },
        { ledgerAccountId: party.ledgerAccountId, direction: "CREDIT", amount: input.amount },
      );
    } else if (charge.bearer === "PARTY") {
      const commissionId = await ledger.systemAccountId("COMMISSION_INCOME", session);
      lines.push(
        { ledgerAccountId: account.ledgerAccountId, direction: "DEBIT", amount: input.amount },
        {
          ledgerAccountId: party.ledgerAccountId,
          direction: "CREDIT",
          amount: input.amount - charge.amount,
        },
        { ledgerAccountId: commissionId, direction: "CREDIT", amount: charge.amount },
      );
    } else {
      const chargeAccountId = await ledger.systemAccountId("BANK_CHARGES", session);
      lines.push(
        {
          ledgerAccountId: account.ledgerAccountId,
          direction: "DEBIT",
          amount: input.amount - charge.amount,
        },
        { ledgerAccountId: chargeAccountId, direction: "DEBIT", amount: charge.amount },
        { ledgerAccountId: party.ledgerAccountId, direction: "CREDIT", amount: input.amount },
      );
    }

    const txn = await postOrSubmit(
      {
        type: "PAYMENT_IN",
        date: input.date,
        lines,
        grossAmount: input.amount,
        chargeAmount: charge.amount,
        // A charge on money coming in always reduces what reaches us, whoever bears it:
        // a party-borne commission is kept out of what we credit them, and a bank's
        // collection fee is taken out of what lands in the account.
        netAmount: settlementNet(
          input.amount,
          charge.amount,
          chargeEffect("PAYMENT_IN", charge.bearer),
        ),
        paymentMode: input.paymentMode,
        referenceNo: input.referenceNo,
        narration: input.narration ?? `Payment received from ${party.name}`,
        partyId: party.id,
        createdBy: ctx.userId!,
        attachments: input.attachments,
        notes: input.notes ? [{ text: input.notes, createdBy: ctx.userId, createdAt: new Date() }] : [],
        details: {
          accountId: account.id,
          accountKind: account.kind,
          accountLabel: account.label,
          chargeRuleId: charge.ruleId,
          chargeBearer: charge.bearer,
          chargeBasis: charge.basis || undefined,
        },
      },
      ctx,
      session,
    );

    return txn;
  }
}

/* -------------------------------------------------------------------------- */
/* Payment Out (§15)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Money paid to a party.
 *
 *     DR  Party              100,000     what we owe them falls
 *         CR  Bank/Cash                  100,000     money leaves
 *
 * A SELF-borne charge comes out of our account on top of the gross; a PARTY-borne charge
 * is deducted from what they receive and becomes our income.
 */
export async function createPaymentOut(
  input: CreatePaymentOutInput,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  return withTransaction(
    (session) => postPaymentOut(input, ctx, session),
    { label: "paymentOut.create" },
  );
}

/** The Payment Out posting, against a session the caller owns. See `postPaymentIn`. */
export async function postPaymentOut(
  input: CreatePaymentOutInput,
  ctx: audit.AuditContext,
  session: ClientSession,
): Promise<TransactionDoc> {
  {
    // SEQUENTIAL, NOT Promise.all. A MongoDB ClientSession carries exactly one
    // in-flight operation: issuing two at once against the same session makes the driver
    // advance the transaction number under itself, and the second lands as
    // "Given transaction number N does not match any in-progress transactions".
    // The transaction then aborts — intermittently, and only under concurrency.
    const account = await accounts.resolveAccount(input.accountId, session);
    const party = await accounts.resolveParty(input.partyId, session);

    const charge = await charges.resolveCharge(
      {
        chargeRuleId: input.chargeRuleId,
        manualCharge: input.manualCharge,
        amount: input.amount,
        transactionType: "PAYMENT_OUT",
        partyType: party.type,
      },
      session,
    );

    const lines: ledger.PostingLine[] = [];

    if (charge.amount === 0) {
      lines.push(
        { ledgerAccountId: party.ledgerAccountId, direction: "DEBIT", amount: input.amount },
        { ledgerAccountId: account.ledgerAccountId, direction: "CREDIT", amount: input.amount },
      );
    } else if (charge.bearer === "PARTY") {
      const commissionId = await ledger.systemAccountId("COMMISSION_INCOME", session);
      lines.push(
        { ledgerAccountId: party.ledgerAccountId, direction: "DEBIT", amount: input.amount },
        {
          ledgerAccountId: account.ledgerAccountId,
          direction: "CREDIT",
          amount: input.amount - charge.amount,
        },
        { ledgerAccountId: commissionId, direction: "CREDIT", amount: charge.amount },
      );
    } else {
      const chargeAccountId = await ledger.systemAccountId("BANK_CHARGES", session);
      lines.push(
        { ledgerAccountId: party.ledgerAccountId, direction: "DEBIT", amount: input.amount },
        { ledgerAccountId: chargeAccountId, direction: "DEBIT", amount: charge.amount },
        {
          ledgerAccountId: account.ledgerAccountId,
          direction: "CREDIT",
          amount: input.amount + charge.amount,
        },
      );
    }

    /**
     * Credit limit check (§12).
     *
     * Paying a party debits their account, pushing the balance UP — toward "they owe us".
     * If that crosses their limit we are effectively extending unapproved credit, so it
     * is refused here rather than discovered in an aging report next month.
     */
    if (party.creditLimit > 0) {
      const partyAccount = await LedgerAccount.findById(party.ledgerAccountId)
        .select("cachedBalance")
        .session(session);
      const wouldBe = (partyAccount?.cachedBalance ?? 0) + input.amount;
      if (wouldBe > party.creditLimit) {
        throw new CreditLimitExceededError(party.name, party.creditLimit, wouldBe);
      }
    }

    const txn = await postOrSubmit(
      {
        type: "PAYMENT_OUT",
        date: input.date,
        lines,
        grossAmount: input.amount,
        chargeAmount: charge.amount,
        /**
         * A party-borne charge is deducted from what they receive (₹49,250 leaves); a
         * charge we bear is paid ON TOP of it (₹50,750 leaves, the party still gets the
         * full ₹50,000). Both figures are already in `lines` above — this makes the header
         * agree with them instead of always claiming `gross − charge`.
         */
        netAmount: settlementNet(
          input.amount,
          charge.amount,
          chargeEffect("PAYMENT_OUT", charge.bearer),
        ),
        paymentMode: input.paymentMode,
        referenceNo: input.referenceNo,
        narration: input.narration ?? `Payment made to ${party.name}`,
        partyId: party.id,
        createdBy: ctx.userId!,
        attachments: input.attachments,
        notes: input.notes ? [{ text: input.notes, createdBy: ctx.userId, createdAt: new Date() }] : [],
        details: {
          accountId: account.id,
          accountKind: account.kind,
          accountLabel: account.label,
          chargeRuleId: charge.ruleId,
          chargeBearer: charge.bearer,
          chargeBasis: charge.basis || undefined,
        },
      },
      ctx,
      session,
    );

    return txn;
  }
}

/* -------------------------------------------------------------------------- */
/* Bank transfer (§8)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Bank A to Bank B.
 *
 *     DR  Destination        100,000
 *     DR  Bank Charges            50     when we bear the fee
 *         CR  Source                     100,050
 *
 * The destination always receives the full gross. A transfer fee is an additional debit
 * on the source, never a silent reduction of what arrives — the receiving bank statement
 * has to show ₹1,00,000 or reconciliation fails.
 */
export async function createBankTransfer(
  input: CreateBankTransferInput,
  ctx: audit.AuditContext,
): Promise<TransactionDoc> {
  if (input.sourceAccountId === input.destinationAccountId) throw new SelfTransferError();

  return withTransaction(async (session) => {
    // SEQUENTIAL, NOT Promise.all. A MongoDB ClientSession carries exactly one
    // in-flight operation: issuing two at once against the same session makes the driver
    // advance the transaction number under itself, and the second lands as
    // "Given transaction number N does not match any in-progress transactions".
    // The transaction then aborts — intermittently, and only under concurrency.
    const source = await accounts.resolveAccount(input.sourceAccountId, session);
    const destination = await accounts.resolveAccount(input.destinationAccountId, session);

    const charge = await charges.resolveCharge(
      {
        chargeRuleId: input.chargeRuleId,
        manualCharge: input.manualCharge,
        amount: input.amount,
        transactionType: "BANK_TRANSFER",
      },
      session,
    );

    const lines: ledger.PostingLine[] = [
      { ledgerAccountId: destination.ledgerAccountId, direction: "DEBIT", amount: input.amount },
    ];

    if (charge.amount > 0) {
      const chargeAccountId = await ledger.systemAccountId("BANK_CHARGES", session);
      lines.push({ ledgerAccountId: chargeAccountId, direction: "DEBIT", amount: charge.amount });
    }

    lines.push({
      ledgerAccountId: source.ledgerAccountId,
      direction: "CREDIT",
      amount: input.amount + charge.amount,
    });

    const txn = await postOrSubmit(
      {
        type: "BANK_TRANSFER",
        date: input.date,
        lines,
        grossAmount: input.amount,
        chargeAmount: charge.amount,
        // The destination always receives the full gross, so a transfer fee is money that
        // leaves the source ON TOP of it — ₹50,000 arrives, ₹50,750 left.
        netAmount: settlementNet(input.amount, charge.amount, chargeEffect("BANK_TRANSFER", "SELF")),
        paymentMode: input.paymentMode,
        referenceNo: input.referenceNo,
        narration:
          input.narration ?? `Transfer from ${source.label} to ${destination.label}`,
        createdBy: ctx.userId!,
        attachments: input.attachments,
        notes: input.notes ? [{ text: input.notes, createdBy: ctx.userId, createdAt: new Date() }] : [],
        details: {
          sourceAccountId: source.id,
          sourceAccountKind: source.kind,
          sourceLabel: source.label,
          destinationAccountId: destination.id,
          destinationAccountKind: destination.kind,
          destinationLabel: destination.label,
          chargeRuleId: charge.ruleId,
          chargeBasis: charge.basis || undefined,
        },
      },
      ctx,
      session,
    );

    return txn;
  }, { label: "bankTransfer.create" });
}

/**
 * Attach the type-specific fields after the engine has written the base document.
 *
 * `postTransaction` deliberately knows nothing about payment modes, account labels or
 * expense items — it posts balanced lines. This writes the discriminator fields onto the
 * same document, in the same session, so the pair commits or rolls back together.
 *
 * `strict: false` is required: the update runs against the base `Transaction` model, whose
 * schema does not declare the discriminator's fields.
 */

/* -------------------------------------------------------------------------- */
/* Editing a posted payment (§25, §28)                                        */
/* -------------------------------------------------------------------------- */

/** A posted payment, with the discriminator fields the edit needs to read back. */
type PostedPayment = TransactionDoc & {
  accountId?: Types.ObjectId;
  chargeRuleId?: Types.ObjectId | null;
};

/**
 * Change a posted Payment In or Payment Out.
 *
 * THE RULE, and the reason this function is shaped the way it is: a posted transaction is
 * never rewritten. What "edit" means depends on what was edited.
 *
 *   A LABEL changed — reference, narration, payment mode, a note. No balance moves, so the
 *     header is updated in place and the audit row records who changed what.
 *
 *   MONEY changed — date, amount, party, account, charge. The original is REVERSED and a
 *     corrected transaction is posted in its place, both inside one database transaction.
 *     Three documents end up on the books, all visible, all linked:
 *
 *         PAY-IN-000012   the original, now REVERSED, supersededBy the replacement
 *         REV-000003      the mirror that cancels it
 *         PAY-IN-000014   the replacement, which supersedes the original
 *
 * Why not simply update the amount? Because the balance is the sum of the entries. Editing
 * ₹50,000 to ₹45,000 in place would move a balance by ₹5,000 with nothing in the ledger to
 * explain it, and "explain this balance" — the one question this whole system exists to
 * answer — would have no answer. §62 is explicit that a correction is a posting, not an
 * overwrite.
 */
export async function editPayment(
  transactionId: string,
  input: UpdatePaymentInput,
  ctx: audit.AuditContext,
): Promise<PaymentEditResult> {
  return withTransaction(async (session) => {
    const original = (await Transaction.findById(transactionId).session(
      session,
    )) as PostedPayment | null;

    if (!original) throw new NotFoundError("Transaction", transactionId);

    if (original.type !== "PAYMENT_IN" && original.type !== "PAYMENT_OUT") {
      throw new BadRequestError(
        `${original.txnNo} is a ${TRANSACTION_TYPE_LABEL[original.type] ?? original.type}. ` +
          "Only a Payment In or Payment Out can be edited here.",
      );
    }

    /**
     * What may be edited.
     *
     * A reversed or superseded transaction is history — editing it would fork the chain
     * and leave two "current" versions of the same payment. A PENDING one has no entries
     * yet, so it is not an edit at all; that path is approve-or-reject.
     */
    if (original.status === "REVERSED") {
      throw new StateConflictError(original.status, "EDITED");
    }
    if (original.status !== "COMPLETED") {
      throw new BadRequestError(
        `${original.txnNo} is ${original.status.toLowerCase()} and has no posted entries to correct.`,
      );
    }
    if (original.reversalOf) {
      throw new BadRequestError(
        `${original.txnNo} is a reversal. Edit the transaction it cancels, not the mirror.`,
      );
    }

    /* ── What actually changed ────────────────────────────────────────────── */

    const current = {
      date: original.date,
      amount: original.grossAmount,
      partyId: original.partyId ? String(original.partyId) : undefined,
      accountId: original.accountId ? String(original.accountId) : undefined,
      chargeRuleId: original.chargeRuleId ? String(original.chargeRuleId) : undefined,
      /**
       * A manual charge is not stored as such — only the resulting amount is. So it is
       * reconstructed: a charge with no rule behind it was entered by hand. Without this
       * an edit that touched only the reference number would silently drop the charge.
       */
      manualCharge:
        !original.chargeRuleId && original.chargeAmount > 0 ? original.chargeAmount : undefined,
    };

    const next = {
      date: input.date ?? current.date,
      amount: input.amount ?? current.amount,
      partyId: input.partyId ?? current.partyId,
      accountId: input.accountId ?? current.accountId,
      chargeRuleId: input.chargeRuleId ?? current.chargeRuleId,
      manualCharge: input.manualCharge ?? current.manualCharge,
    };

    const moneyChanged = PAYMENT_MONEY_FIELDS.some((field) => {
      const before = current[field];
      const after = next[field];
      if (before instanceof Date || after instanceof Date) {
        return new Date(before as Date).getTime() !== new Date(after as Date).getTime();
      }
      return before !== after;
    });

    /* ── Labels only: update in place ─────────────────────────────────────── */

    if (!moneyChanged) {
      const before = {
        paymentMode: original.paymentMode,
        referenceNo: original.referenceNo,
        narration: original.narration,
      };

      if (input.paymentMode !== undefined) original.paymentMode = input.paymentMode;
      if (input.referenceNo !== undefined) original.referenceNo = input.referenceNo;
      if (input.narration !== undefined) original.narration = input.narration;
      if (input.notes) {
        original.notes.push({
          text: input.notes,
          createdBy: new Types.ObjectId(ctx.userId!),
          createdAt: new Date(),
        } as never);
      }
      original.updatedBy = ctx.userId ? new Types.ObjectId(ctx.userId) : undefined;
      await original.save({ session });

      await audit.record(
        ctx,
        {
          action: "UPDATE",
          entity: "Transaction",
          entityId: String(original._id),
          entityLabel: original.txnNo,
          reason: input.reason,
          oldValue: before,
          newValue: {
            paymentMode: original.paymentMode,
            referenceNo: original.referenceNo,
            narration: original.narration,
          },
        },
        session,
      );

      return {
        outcome: "UPDATED" as const,
        transaction: { id: String(original._id), txnNo: original.txnNo },
      };
    }

    /* ── Money changed: reverse, then repost ──────────────────────────────── */

    if (!next.partyId || !next.accountId) {
      throw new BadRequestError("A payment needs both a party and an account", "partyId");
    }

    const { reversal } = await reversal_.reverseWithin(
      transactionId,
      { reason: `Edited — ${input.reason}`, date: input.date ?? original.date },
      ctx,
      session,
    );

    const replacementInput = {
      date: next.date,
      partyId: next.partyId,
      accountId: next.accountId,
      amount: next.amount,
      paymentMode: input.paymentMode ?? original.paymentMode,
      referenceNo: input.referenceNo ?? original.referenceNo,
      narration: input.narration ?? original.narration,
      chargeRuleId: next.chargeRuleId,
      manualCharge: next.manualCharge,
      attachments: [],
      notes: input.notes,
    };

    const replacement =
      original.type === "PAYMENT_IN"
        ? await postPaymentIn(replacementInput as never, ctx, session)
        : await postPaymentOut(replacementInput as never, ctx, session);

    // Link the chain both ways, so either document leads to the other.
    await Transaction.updateOne(
      { _id: original._id },
      { $set: { supersededBy: replacement._id, editReason: input.reason } },
      { session },
    );
    await Transaction.updateOne(
      { _id: replacement._id },
      { $set: { supersedes: original._id, editReason: input.reason } },
      { session },
    );

    /**
     * A second audit row, distinct from the REVERSE and POST rows the engine already
     * wrote. Those record the mechanics; this records the intent — that a human corrected
     * a posted payment, which fields they changed, and why. That is the question an
     * auditor actually asks, and reconstructing it from three mechanical rows is exactly
     * the work an audit trail should have already done.
     */
    await audit.record(
      ctx,
      {
        action: "BALANCE_ADJUSTED",
        entity: "Transaction",
        entityId: String(replacement._id),
        entityLabel: `${replacement.txnNo} corrects ${original.txnNo}`,
        amount: next.amount,
        reason: input.reason,
        oldValue: {
          txnNo: original.txnNo,
          date: current.date,
          amount: current.amount,
          partyId: current.partyId,
          accountId: current.accountId,
          chargeAmount: original.chargeAmount,
        },
        newValue: {
          txnNo: replacement.txnNo,
          date: next.date,
          amount: next.amount,
          partyId: next.partyId,
          accountId: next.accountId,
          chargeAmount: replacement.chargeAmount,
        },
      },
      session,
    );

    return {
      outcome: "REPOSTED" as const,
      transaction: { id: String(replacement._id), txnNo: replacement.txnNo },
      replaced: { id: String(original._id), txnNo: original.txnNo },
      reversal: { id: String(reversal._id), txnNo: reversal.txnNo },
    };
  }, { label: "payment.edit" });
}
