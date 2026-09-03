import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { ledgerAccountQuerySchema, ledgerEntryQuerySchema, objectId, type LedgerAccountQuery } from "@amiri/shared";
import { asyncHandler, escapeRegex, ok, paginated, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { LedgerAccount, LedgerEntry } from "../../models/index.js";
import { NotFoundError } from "../../lib/errors.js";
import * as ledger from "../../services/ledger.service.js";

/**
 * Ledger read endpoints.
 *
 * There is intentionally NO POST here. Entries are produced by the posting engine from a
 * business transaction, in balanced sets, inside one database transaction. An endpoint
 * that wrote a single entry would be an endpoint for putting the books out of balance.
 */
export const ledgerRouter: Router = Router();

ledgerRouter.use(requireAuth);

const idParam = z.object({ id: objectId });

ledgerRouter.get(
  "/accounts",
  requirePermission("finance.ledger.view"),
  validate({ query: ledgerAccountQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as LedgerAccountQuery;
    const page = paging(query, { code: 1 }, ["code", "name", "cachedBalance"]);

    const filter: Record<string, unknown> = {};

    if (query.kind) filter.kind = query.kind;
    if (query.activeOnly) filter.cachedEntryCount = { $gt: 0 };

    /**
     * Search, server-side.
     *
     * The chart of accounts grows with the business — one row per party, per drawer, per
     * head — so a deployment with five thousand parties has five thousand accounts. A
     * picker that fetched the first page and filtered it in the browser would silently
     * offer 200 of them, and an operator searching for a party that exists would be told
     * it does not.
     *
     * The scope clause is nested under `$and` rather than replaced: overwriting `filter.$or`
     * here would replace the caller's filter rather than narrow it.
     */
    if (query.q?.trim()) {
      const rx = new RegExp(escapeRegex(query.q.trim()), "i");
      const search = [{ name: rx }, { code: rx }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: search }];
        delete filter.$or;
      } else {
        filter.$or = search;
      }
    }

    const [items, total] = await Promise.all([
      LedgerAccount.find(filter).sort(page.sort).skip(page.skip).limit(page.limit).lean(),
      LedgerAccount.countDocuments(filter),
    ]);

    return paginated(
      res,
      items.map((a) => ({
        id: String(a._id),
        code: a.code,
        name: a.name,
        kind: a.kind,
        accountClass: a.accountClass,
        balance: a.cachedBalance,
        entryCount: a.cachedEntryCount,
        isSystem: a.isSystem,
        status: a.status,
      })),
      total,
      page.page,
      page.limit,
    );
  }),
);

/**
 * The statement for one account.
 *
 * Entries come back oldest-first, because a running-balance column only reads correctly
 * in posting order — newest-first would show the balance running backwards.
 */
ledgerRouter.get(
  "/accounts/:id/entries",
  requirePermission("finance.ledger.view"),
  validate({ params: idParam, query: ledgerEntryQuerySchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const query = req.valid.query as { page: number; limit: number; from?: Date; to?: Date };

    const account = await LedgerAccount.findById(id).lean();
    if (!account) throw new NotFoundError("Ledger account", id);

    const filter: Record<string, unknown> = { ledgerAccountId: account._id };
    if (query.from || query.to) {
      filter.date = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }

    const skip = (query.page - 1) * query.limit;

    const [entries, total, opening] = await Promise.all([
      LedgerEntry.find(filter).sort({ date: 1, _id: 1 }).skip(skip).limit(query.limit).lean(),
      LedgerEntry.countDocuments(filter),
      // Balance brought forward: everything strictly before the window. Without it a
      // date-filtered statement starts from zero and every running balance is wrong.
      query.from
        ? ledger.computeBalance(account._id, { asOf: new Date(query.from.getTime() - 1) })
        : Promise.resolve({ balance: 0 }),
    ]);

    /**
     * The other side of each row, WITH ITS AMOUNTS.
     *
     * A statement row shows one figure — what moved on this account. When a charge is
     * involved that figure does not explain itself: ₹1,00,000 leaving the bank against
     * "101, Bank Charges" hides that ₹98,500 went to the party and ₹1,500 was our cost.
     * Reading the sibling lines gives the split, and doing it here — rather than storing
     * it — means every row already on the books gets the breakdown too, not just the
     * ones posted from now on.
     *
     * One extra indexed query per page, and only over the transactions on this page.
     */
    const txnIds = [...new Set(entries.map((e) => String(e.transactionId)))];
    const siblings = txnIds.length
      ? await LedgerEntry.find({ transactionId: { $in: txnIds } })
          .select("transactionId ledgerAccountId direction amount")
          .populate<{ ledgerAccountId: { _id: Types.ObjectId; name: string } }>(
            "ledgerAccountId",
            "name",
          )
          .lean()
      : [];

    const contraByTxn = new Map<string, Array<{ name: string; amount: number; direction: string }>>();
    for (const s of siblings) {
      // Compared by id, not by name: two accounts can share a name, and excluding by
      // name would drop a legitimate contra line.
      if (String(s.ledgerAccountId?._id) === String(account._id)) continue;
      const key = String(s.transactionId);
      const list = contraByTxn.get(key) ?? [];
      list.push({
        name: s.ledgerAccountId?.name ?? "—",
        amount: s.amount,
        direction: s.direction,
      });
      contraByTxn.set(key, list);
    }

    return paginated(
      res,
      entries.map((e) => ({
        id: String(e._id),
        transactionId: String(e.transactionId),
        txnNo: e.txnNo,
        transactionType: e.transactionType,
        date: e.date.toISOString(),
        direction: e.direction,
        debit: e.direction === "DEBIT" ? e.amount : 0,
        credit: e.direction === "CREDIT" ? e.amount : 0,
        runningBalance: e.runningBalance,
        narration: e.narration,
        contra: e.contra ?? [],
        contraLines: contraByTxn.get(String(e.transactionId)) ?? [],
        reconciledAt: e.reconciledAt ? e.reconciledAt.toISOString() : null,
        createdAt: e.createdAt.toISOString(),
      })),
      total,
      query.page,
      query.limit,
      {
        account: {
          id: String(account._id),
          code: account.code,
          name: account.name,
          kind: account.kind,
          accountClass: account.accountClass,
          balance: account.cachedBalance,
        },
        openingBalance: opening.balance,
      },
    );
  }),
);

/**
 * Trial balance (§34).
 *
 * Computed from entries, not from cached balances — a report whose job is to prove the
 * books tie must not be derived from the cache it is meant to validate.
 */
ledgerRouter.get(
  "/trial-balance",
  requirePermission("reports.trialBalance"),
  validate({ query: z.object({ asOf: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { asOf?: Date };

    return ok(
      res,
      await ledger.trialBalance({
        ...(query.asOf ? { asOf: query.asOf } : {}),
      }),
    );
  }),
);

/**
 * Integrity check: replay the entries and compare against the cached balance.
 *
 * Reports a discrepancy; never repairs one. Overwriting the cache would destroy the
 * evidence of whatever caused the drift (§62).
 */
ledgerRouter.get(
  "/accounts/:id/verify",
  requirePermission("finance.ledger.view"),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    return ok(res, await ledger.verifyBalance(id));
  }),
);
