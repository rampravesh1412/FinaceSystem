import { Types, type FilterQuery, type PipelineStage } from "mongoose";
import {
  khataDirection,
  type CreatePartyInput,
  type PartyProfile,
  type PartySummary,
  type UpdatePartyInput,
} from "@amiri/shared";
import {
  Branch,
  LedgerAccount,
  LedgerEntry,
  Party,
  Transaction,
  nextSequence,
  type PartyDoc,
} from "../../models/index.js";
import { BadRequestError, NotFoundError, translateDuplicate } from "../../lib/errors.js";
import { escapeRegex, type Paging } from "../../lib/http.js";
import { withTransaction } from "../../lib/unitOfWork.js";
import * as ledger from "../../services/ledger.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Party master (§10) and the balance figures the Digital Khata is built on.
 *
 * The sign convention throughout, and it is the Khata's own:
 *
 *     POSITIVE  they owe us   LENA HAI
 *     NEGATIVE  we owe them   DENA HAI
 *
 * A party's ledger account is an ASSET, so a DEBIT increases what they owe us. Payment In
 * credits the party (their debt drops); Payment Out debits it (our debt to them drops
 * toward zero from a negative balance). One account, one number, both directions.
 */

export async function createParty(
  input: CreatePartyInput,
  ctx: audit.AuditContext,
): Promise<PartyDoc> {
  const branch = await Branch.findById(input.branchId).select("code name status").lean();
  if (!branch) throw new NotFoundError("Branch", input.branchId);
  if (branch.status !== "ACTIVE") throw new BadRequestError("That branch is not active", "branchId");

  return withTransaction(async (session) => {
    try {
      // Auto-numbered per branch when no code was given. Inside the session, so a rolled
      // back party does not consume a code.
      const code =
        input.code ??
        `PTY-${String(await nextSequence(`PARTY-${branch.code}`, 0, session)).padStart(5, "0")}`;

      const ledgerSeq = await nextSequence(`LEDGER-PARTY-${branch.code}`, 0, session);
      const ledgerAccount = await ledger.createLedgerAccount(
        {
          code: `PARTY-${branch.code}-${String(ledgerSeq).padStart(4, "0")}`,
          name: `${input.name} (${code})`,
          kind: "PARTY",
          branchId: input.branchId,
          refKind: "Party",
          // A party balance legitimately swings either way — they owe us, or we owe them.
          // Enforcing a floor here would block recording a genuine payable.
          enforceBalance: false,
          createdBy: ctx.userId,
        },
        session,
      );

      const [party] = await Party.create(
        [
          {
            name: input.name,
            code,
            type: input.type,
            branchId: input.branchId,
            ledgerAccountId: ledgerAccount._id,
            mobile: input.mobile,
            altMobile: input.altMobile,
            email: input.email,
            address: input.address,
            city: input.city,
            state: input.state,
            pincode: input.pincode,
            gstin: input.gstin,
            pan: input.pan,
            creditLimit: input.creditLimit,
            creditDays: input.creditDays,
            status: input.status,
            notes: input.notes,
            createdBy: ctx.userId,
          },
        ],
        { session },
      );

      if (!party) throw new Error("Party creation returned no document");

      await LedgerAccount.updateOne({ _id: ledgerAccount._id }, { $set: { refId: party._id } }, { session });

      await audit.record(
        { ...ctx, branchId: String(input.branchId) },
        {
          action: "CREATE",
          entity: "Party",
          entityId: String(party._id),
          entityLabel: `${code} — ${input.name}`,
          amount: input.openingBalance,
          newValue: {
            name: input.name,
            code,
            type: input.type,
            openingBalance: input.openingBalance,
            creditLimit: input.creditLimit,
          },
        },
        session,
      );

      await ledger.postOpeningBalance(
        {
          ledgerAccountId: ledgerAccount._id,
          branchId: input.branchId,
          amount: input.openingBalance,
          date: input.openingDate ?? new Date(),
          label: `${input.name} (${code})`,
          createdBy: ctx.userId!,
        },
        session,
        { ...ctx, branchId: String(input.branchId) },
      );

      return party;
    } catch (err) {
      const duplicate = translateDuplicate(err, "party");
      if (duplicate) throw duplicate;
      throw err;
    }
  }, { label: "party.create" });
}

export interface PartyListFilters {
  q?: string;
  type?: string;
  status?: string;
  balance: "all" | "lena" | "dena" | "clear";
  overLimit?: boolean;
  scopeFilter: Record<string, unknown>;
}

export async function listParties(
  filters: PartyListFilters,
  page: Paging,
): Promise<{ items: PartySummary[]; total: number; totals: { lena: number; dena: number } }> {
  const filter: FilterQuery<PartyDoc> = { ...filters.scopeFilter };

  if (filters.type) filter.type = filters.type;
  if (filters.status) filter.status = filters.status;
  if (filters.q?.trim()) {
    const rx = new RegExp(escapeRegex(filters.q.trim()), "i");
    filter.$or = [{ name: rx }, { code: rx }, { mobile: rx }, { gstin: rx }];
  }

  /**
   * Filtering and sorting by BALANCE requires the ledger account, which lives in another
   * collection — so this is an aggregation with a `$lookup`, not a `find`.
   *
   * The alternative, fetching every party and filtering in Node, would ship the whole
   * master to the server for a page of 25 and break entirely at ten thousand parties
   * (§69).
   */
  const pipeline: PipelineStage[] = [
    { $match: filter },
    {
      $lookup: {
        from: "ledgeraccounts",
        localField: "ledgerAccountId",
        foreignField: "_id",
        as: "ledger",
        pipeline: [{ $project: { cachedBalance: 1 } }],
      },
    },
    { $unwind: "$ledger" },
    { $addFields: { balance: "$ledger.cachedBalance" } },
  ];

  if (filters.balance === "lena") pipeline.push({ $match: { balance: { $gt: 0 } } });
  else if (filters.balance === "dena") pipeline.push({ $match: { balance: { $lt: 0 } } });
  else if (filters.balance === "clear") pipeline.push({ $match: { balance: 0 } });

  if (filters.overLimit) {
    pipeline.push({
      $match: { $expr: { $and: [{ $gt: ["$creditLimit", 0] }, { $gt: ["$balance", "$creditLimit"] }] } },
    });
  }

  // `$facet` gets the page, the count and the receivable/payable totals in ONE round trip
  // instead of three passes over the same matched set.
  const [result] = await Party.aggregate<{
    items: Array<PartyDoc & { balance: number; branch: { _id: Types.ObjectId; name: string; code: string } }>;
    count: Array<{ total: number }>;
    totals: Array<{ lena: number; dena: number }>;
  }>([
    ...pipeline,
    {
      $facet: {
        items: [
          { $sort: page.sort },
          { $skip: page.skip },
          { $limit: page.limit },
          {
            $lookup: {
              from: "branches",
              localField: "branchId",
              foreignField: "_id",
              as: "branch",
              pipeline: [{ $project: { name: 1, code: 1 } }],
            },
          },
          { $unwind: "$branch" },
        ],
        count: [{ $count: "total" }],
        totals: [
          {
            $group: {
              _id: null,
              lena: { $sum: { $cond: [{ $gt: ["$balance", 0] }, "$balance", 0] } },
              dena: { $sum: { $cond: [{ $lt: ["$balance", 0] }, { $abs: "$balance" }, 0] } },
            },
          },
        ],
      },
    },
  ]);

  const items = (result?.items ?? []).map(toPartySummary);

  return {
    items,
    total: result?.count[0]?.total ?? 0,
    totals: { lena: result?.totals[0]?.lena ?? 0, dena: result?.totals[0]?.dena ?? 0 },
  };
}

/** The row shape the list aggregation produces, and the only place it becomes a summary. */
type PartyRow = PartyDoc & {
  balance: number;
  branch: { _id: Types.ObjectId; name: string; code: string };
};

function toPartySummary(p: PartyRow): PartySummary {
  {
    // Credit used is what they owe us; a negative balance means we owe them, which
    // consumes no credit.
    const creditUsed = Math.max(0, p.balance);
    return {
      id: String(p._id),
      name: p.name,
      code: p.code,
      type: p.type,
      branch: { id: String(p.branch._id), name: p.branch.name, code: p.branch.code },
      mobile: p.mobile,
      email: p.email,
      city: p.city,
      gstin: p.gstin,
      balance: p.balance,
      direction: khataDirection(p.balance),
      creditLimit: p.creditLimit,
      creditUsed,
      availableCredit: p.creditLimit > 0 ? Math.max(0, p.creditLimit - creditUsed) : 0,
      isOverLimit: p.creditLimit > 0 && creditUsed > p.creditLimit,
      status: p.status,
      ledgerAccountId: String(p.ledgerAccountId),
      createdAt: p.createdAt.toISOString(),
    } satisfies PartySummary;
  }
}

/**
 * One party in the SAME shape the list returns.
 *
 * The create route uses this rather than returning the raw Mongoose document. A POST that
 * answers with a different shape from the GET means every client that creates-then-renders
 * has to special-case it — and the one field it was missing, `balance`, is the whole point
 * of a party that was just opened with a balance.
 */
export async function getPartySummary(id: string): Promise<PartySummary> {
  const [row] = await Party.aggregate<PartyRow>([
    { $match: { _id: new Types.ObjectId(id) } },
    {
      $lookup: {
        from: "ledgeraccounts",
        localField: "ledgerAccountId",
        foreignField: "_id",
        as: "ledger",
        pipeline: [{ $project: { cachedBalance: 1 } }],
      },
    },
    { $unwind: "$ledger" },
    { $addFields: { balance: "$ledger.cachedBalance" } },
    {
      $lookup: {
        from: "branches",
        localField: "branchId",
        foreignField: "_id",
        as: "branch",
        pipeline: [{ $project: { name: 1, code: 1 } }],
      },
    },
    { $unwind: "$branch" },
  ]);

  if (!row) throw new NotFoundError("Party", id);
  return toPartySummary(row);
}

/**
 * The party profile header (§10).
 *
 * "Total given" and "total taken" are gross turnover across the relationship — the sum of
 * every debit and every credit — while the balance is their difference. They answer
 * different questions: turnover says how much business flows through this party, the
 * balance says where they stand today.
 */
export async function getPartyProfile(
  id: string,
  scopeFilter: Record<string, unknown>,
): Promise<PartyProfile> {
  const party = await Party.findOne({ _id: id, ...scopeFilter })
    .populate<{ branchId: { _id: Types.ObjectId; name: string; code: string } }>("branchId", "name code")
    .populate<{ ledgerAccountId: { _id: Types.ObjectId; cachedBalance: number } }>(
      "ledgerAccountId",
      "cachedBalance",
    )
    .lean();

  if (!party) throw new NotFoundError("Party", id);

  const balance = party.ledgerAccountId?.cachedBalance ?? 0;

  const [turnover] = await LedgerEntry.aggregate<{
    given: number;
    taken: number;
    count: number;
    last: Date | null;
  }>([
    { $match: { ledgerAccountId: party.ledgerAccountId._id } },
    {
      $group: {
        _id: null,
        given: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] } },
        taken: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] } },
        count: { $sum: 1 },
        last: { $max: "$date" },
      },
    },
  ]);

  const [payments] = await Transaction.aggregate<{ in: number; out: number }>([
    { $match: { partyId: party._id, status: "COMPLETED" } },
    {
      $group: {
        _id: null,
        in: { $sum: { $cond: [{ $eq: ["$type", "PAYMENT_IN"] }, "$netAmount", 0] } },
        out: { $sum: { $cond: [{ $eq: ["$type", "PAYMENT_OUT"] }, "$netAmount", 0] } },
      },
    },
  ]);

  const creditUsed = Math.max(0, balance);

  return {
    id: String(party._id),
    name: party.name,
    code: party.code,
    type: party.type,
    branch: { id: String(party.branchId._id), name: party.branchId.name, code: party.branchId.code },
    mobile: party.mobile,
    altMobile: party.altMobile,
    email: party.email,
    address: party.address,
    city: party.city,
    state: party.state,
    pincode: party.pincode,
    gstin: party.gstin,
    pan: party.pan,
    notes: party.notes,

    balance,
    direction: khataDirection(balance),

    creditLimit: party.creditLimit,
    creditDays: party.creditDays,
    creditUsed,
    availableCredit: party.creditLimit > 0 ? Math.max(0, party.creditLimit - creditUsed) : 0,
    isOverLimit: party.creditLimit > 0 && creditUsed > party.creditLimit,

    // Receivable and payable are two views of ONE balance, never both non-zero. A party
    // cannot simultaneously owe us and be owed by us on the same account.
    totalReceivable: Math.max(0, balance),
    totalPayable: Math.max(0, -balance),
    totalGiven: turnover?.given ?? 0,
    totalTaken: turnover?.taken ?? 0,
    totalPaymentIn: payments?.in ?? 0,
    totalPaymentOut: payments?.out ?? 0,
    lastTransactionAt: turnover?.last ? new Date(turnover.last).toISOString() : null,
    transactionCount: turnover?.count ?? 0,

    status: party.status,
    ledgerAccountId: String(party.ledgerAccountId._id),
    createdAt: party.createdAt.toISOString(),
  };
}

export async function updateParty(
  id: string,
  input: UpdatePartyInput,
  scopeFilter: Record<string, unknown>,
  ctx: audit.AuditContext,
): Promise<PartyDoc> {
  return withTransaction(async (session) => {
    const party = await Party.findOne({ _id: id, ...scopeFilter }).session(session);
    if (!party) throw new NotFoundError("Party", id);

    const before = {
      name: party.name,
      type: party.type,
      mobile: party.mobile,
      creditLimit: party.creditLimit,
      creditDays: party.creditDays,
      status: party.status,
    };

    Object.assign(party, input, { updatedBy: ctx.userId });
    await party.save({ session });

    // Keep the ledger account's display name in step, so a renamed party does not appear
    // under its old name on every statement and trial balance.
    if (input.name) {
      await LedgerAccount.updateOne(
        { _id: party.ledgerAccountId },
        { $set: { name: `${party.name} (${party.code})` } },
        { session },
      );
    }

    await audit.record(
      { ...ctx, branchId: String(party.branchId) },
      {
        action: "UPDATE",
        entity: "Party",
        entityId: id,
        entityLabel: `${party.code} — ${party.name}`,
        oldValue: before,
        newValue: {
          name: party.name,
          type: party.type,
          mobile: party.mobile,
          creditLimit: party.creditLimit,
          creditDays: party.creditDays,
          status: party.status,
        },
      },
      session,
    );

    return party;
  }, { label: "party.update" });
}
