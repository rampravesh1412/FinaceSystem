import { Types, type FilterQuery } from "mongoose";
import {
  TRANSACTION_TYPE_LABEL,
  type TransactionDetail,
  type TransactionRow,
  type TransactionType,
} from "@amiri/shared";
import { AuditLog, LedgerEntry, Transaction, type TransactionDoc } from "../../models/index.js";
import { NotFoundError } from "../../lib/errors.js";
import { escapeRegex, type Paging } from "../../lib/http.js";

/**
 * Reading transactions — the list behind the DayBook and every per-type screen.
 *
 * `moneyIn` / `moneyOut` are derived here rather than stored, because whether a
 * transaction is "in" or "out" depends on the perspective the DayBook takes: a Payment In
 * is money arriving, an Expense is money leaving, and a Bank Transfer is neither (it
 * moves money between our own accounts and must not inflate either column).
 */

export interface TransactionListFilters {
  q?: string;
  type?: TransactionType;
  status?: string;
  partyId?: string;
  accountId?: string;
  paymentMode?: string;
  createdBy?: string;
  from?: Date;
  to?: Date;
  minAmount?: number;
  maxAmount?: number;
}

function buildFilter(filters: TransactionListFilters): FilterQuery<TransactionDoc> {
  const filter: FilterQuery<TransactionDoc> = {};

  if (filters.type) filter.type = filters.type;
  if (filters.status) filter.status = filters.status;
  if (filters.partyId) filter.partyId = new Types.ObjectId(filters.partyId);
  if (filters.paymentMode) filter.paymentMode = filters.paymentMode;
  if (filters.createdBy) filter.createdBy = new Types.ObjectId(filters.createdBy);

  if (filters.from || filters.to) {
    filter.date = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }

  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    filter.grossAmount = {
      ...(filters.minAmount !== undefined ? { $gte: filters.minAmount } : {}),
      ...(filters.maxAmount !== undefined ? { $lte: filters.maxAmount } : {}),
    };
  }

  /**
   * Account filter.
   *
   * Matches the DENORMALISED `accountIds` on the header, which lists every ledger account
   * the posting touched. The alternative — joining through `ledgerentries` — would be a
   * far more expensive query on the busiest screen in the application.
   */
  if (filters.accountId) {
    const id = new Types.ObjectId(filters.accountId);
    filter.$or = [{ accountIds: id }, { accountId: id }, { sourceAccountId: id }, { destinationAccountId: id }];
  }

  if (filters.q?.trim()) {
    const rx = new RegExp(escapeRegex(filters.q.trim()), "i");
    const search = [{ txnNo: rx }, { referenceNo: rx }, { narration: rx }];
    // Combine with any existing $or rather than overwriting it, or an account filter plus
    // a search term would silently drop the account constraint.
    filter.$and = filter.$or ? [{ $or: filter.$or }, { $or: search }] : [{ $or: search }];
    delete filter.$or;
  }

  return filter;
}

/** Which DayBook column a transaction belongs in (§19). */
function moneyDirection(txn: TransactionDoc): { moneyIn: number; moneyOut: number } {
  switch (txn.type) {
    case "PAYMENT_IN":
    case "INCOME":
      return { moneyIn: txn.netAmount, moneyOut: 0 };
    case "PAYMENT_OUT":
    case "EXPENSE":
      return { moneyIn: 0, moneyOut: txn.netAmount };
    // A transfer moves money between our own accounts. Counting it in either column
    // would double the day's turnover and make the DayBook totals meaningless.
    case "BANK_TRANSFER":
    case "OPENING_BALANCE":
    case "ADJUSTMENT":
    case "SETTLEMENT":
    default:
      return { moneyIn: 0, moneyOut: 0 };
  }
}

type PopulatedTxn = Omit<TransactionDoc, "partyId"> & {
  partyId: { _id: Types.ObjectId; name: string; code: string } | null;
  createdBy: { _id: Types.ObjectId; name: string } | null;
  accountLabel?: string;
  sourceLabel?: string;
  destinationLabel?: string;
};

function toRow(txn: PopulatedTxn): TransactionRow {
  const { moneyIn, moneyOut } = moneyDirection(txn as TransactionDoc);

  return {
    id: String(txn._id),
    txnNo: txn.txnNo,
    type: txn.type,
    typeLabel: TRANSACTION_TYPE_LABEL[txn.type] ?? txn.type,
    date: txn.date.toISOString(),
    party: txn.partyId
      ? { id: String(txn.partyId._id), name: txn.partyId.name, code: txn.partyId.code }
      : null,
    accountLabel:
      txn.accountLabel ??
      (txn.sourceLabel && txn.destinationLabel
        ? `${txn.sourceLabel} → ${txn.destinationLabel}`
        : "—"),
    paymentMode: txn.paymentMode ?? null,
    referenceNo: txn.referenceNo,
    narration: txn.narration,
    grossAmount: txn.grossAmount,
    chargeAmount: txn.chargeAmount,
    netAmount: txn.netAmount,
    moneyIn,
    moneyOut,
    status: txn.status,
    isReversal: Boolean(txn.reversalOf),
    reversedBy: txn.reversedBy ? String(txn.reversedBy) : null,
    reversalOf: txn.reversalOf ? String(txn.reversalOf) : null,
    supersededBy: txn.supersededBy ? String(txn.supersededBy) : null,
    supersedes: txn.supersedes ? String(txn.supersedes) : null,
    createdBy: txn.createdBy ? { id: String(txn.createdBy._id), name: txn.createdBy.name } : null,
    createdAt: txn.createdAt.toISOString(),
  };
}

export async function list(filters: TransactionListFilters, page: Paging) {
  const filter = buildFilter(filters);

  const [docs, total, totals] = await Promise.all([
    Transaction.find(filter)
      .sort(page.sort)
      .skip(page.skip)
      .limit(page.limit)
      .populate("partyId", "name code")
      .populate("createdBy", "name")
      .lean<PopulatedTxn[]>(),
    Transaction.countDocuments(filter),
    // Totals over the WHOLE filtered set. A footer summing only the visible page would be
    // actively misleading on a screen accountants use to tally a day.
    Transaction.aggregate<{ _id: string; net: number; charge: number; count: number }>([
      { $match: filter },
      { $group: { _id: "$type", net: { $sum: "$netAmount" }, charge: { $sum: "$chargeAmount" }, count: { $sum: 1 } } },
    ]),
  ]);

  let moneyIn = 0;
  let moneyOut = 0;
  let totalCharges = 0;

  for (const group of totals) {
    totalCharges += group.charge;
    if (group._id === "PAYMENT_IN" || group._id === "INCOME") moneyIn += group.net;
    if (group._id === "PAYMENT_OUT" || group._id === "EXPENSE") moneyOut += group.net;
  }

  return {
    items: docs.map(toRow),
    total,
    totals: { moneyIn, moneyOut, charges: totalCharges, net: moneyIn - moneyOut },
  };
}

/**
 * The details drawer (§46).
 *
 * Everything traceable from one screen: the ledger entries that were actually posted, the
 * audit timeline, attachments, notes, and the link to a reversal in either direction.
 */
export async function getDetail(
  id: string,
): Promise<TransactionDetail> {
  const txn = await Transaction.findOne({ _id: id })
    .populate("partyId", "name code")
    .populate("createdBy", "name")
    .populate("approvedBy", "name")
    .lean<
      PopulatedTxn & {
        approvedBy: { _id: Types.ObjectId; name: string } | null;
        items?: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
        chargeBasis?: string;
        chargeRuleId?: Types.ObjectId | null;
      }
    >();

  if (!txn) throw new NotFoundError("Transaction", id);

  const [entries, trail, reversalPair, supersededByTxn, supersedesTxn] = await Promise.all([
    LedgerEntry.find({ transactionId: txn._id })
      .populate<{ ledgerAccountId: { _id: Types.ObjectId; name: string; code: string } }>(
        "ledgerAccountId",
        "name code",
      )
      .sort({ direction: 1, _id: 1 })
      .lean(),
    AuditLog.find({ entity: "Transaction", entityId: String(txn._id) })
      .sort({ createdAt: 1 })
      .lean(),
    txn.reversedBy || txn.reversalOf
      ? Transaction.findById(txn.reversedBy ?? txn.reversalOf).select("txnNo status date").lean()
      : null,
    txn.supersededBy ? Transaction.findById(txn.supersededBy).select("txnNo").lean() : null,
    txn.supersedes ? Transaction.findById(txn.supersedes).select("txnNo").lean() : null,
  ]);

  const row = toRow(txn);

  return {
    ...row,
    entries: entries.map((e) => ({
      id: String(e._id),
      accountName: e.ledgerAccountId.name,
      accountCode: e.ledgerAccountId.code,
      direction: e.direction,
      debit: e.direction === "DEBIT" ? e.amount : 0,
      credit: e.direction === "CREDIT" ? e.amount : 0,
      runningBalance: e.runningBalance,
    })),
    attachments: (txn.attachments ?? []).map((a) => ({
      filename: a.filename,
      url: a.url,
      mimeType: a.mimeType,
      size: a.size,
    })),
    notes: (txn.notes ?? []).map((n) => ({
      text: n.text,
      createdBy: String(n.createdBy),
      createdAt: new Date(n.createdAt).toISOString(),
    })),
    timeline: trail.map((t) => ({
      action: t.action,
      at: t.createdAt.toISOString(),
      by: t.userName,
      role: t.roleName,
      reason: t.reason,
      changedFields: t.changedFields,
      oldValue: t.oldValue,
      newValue: t.newValue,
    })),
    supersededByTxn: supersededByTxn
      ? { id: String(supersededByTxn._id), txnNo: supersededByTxn.txnNo }
      : null,
    supersedesTxn: supersedesTxn
      ? { id: String(supersedesTxn._id), txnNo: supersedesTxn.txnNo }
      : null,
    items: txn.items,
    chargeRule: txn.chargeBasis
      ? { id: txn.chargeRuleId ? String(txn.chargeRuleId) : "", name: "", basis: txn.chargeBasis }
      : null,
    approvedBy: txn.approvedBy
      ? { id: String(txn.approvedBy._id), name: txn.approvedBy.name }
      : null,
    postedAt: txn.postedAt ? txn.postedAt.toISOString() : null,
    // Surfaced so the drawer can link straight to the other half of the pair.
    reversedBy: reversalPair && txn.reversedBy ? String(reversalPair._id) : row.reversedBy,
    reversalOf: reversalPair && txn.reversalOf ? String(reversalPair._id) : row.reversalOf,
  };
}
