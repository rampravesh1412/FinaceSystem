import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import {
  TRANSACTION_TYPE_LABEL,
  booleanFlag,
  formatINR,
  objectId,
  type PnLLine,
  type TransactionRow,
} from "@amiri/shared";
import { asyncHandler, escapeRegex, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { exportLimiter } from "../../middleware/security.js";
import { BadRequestError } from "../../lib/errors.js";
import { AuditLog, LedgerAccount, LedgerEntry } from "../../models/index.js";
import * as audit from "../../services/audit.service.js";
import * as exporter from "../../services/export.service.js";
import * as reports from "../../services/reports.service.js";
import * as listing from "../transactions/transaction.service.js";

/**
 * Export routes (§53, §54).
 *
 * Every export is AUDITED. §26 lists EXPORT as an auditable action for a reason: taking a
 * copy of the books out of the system is exactly the event you want a record of, and it is
 * the one action that leaves no other trace.
 *
 * The row cap is deliberate and is REPORTED rather than silently applied — an export that
 * quietly stops at 10,000 rows looks complete and is not.
 */
export const exportRouter: Router = Router();

exportRouter.use(requireAuth);

const MAX_ROWS = 20_000;

const formatSchema = z.object({ format: z.enum(["csv", "xlsx", "pdf"]).default("csv") });

const rangeSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  format: z.enum(["csv", "xlsx", "pdf"]).default("csv"),
});

/* ── DayBook (§19) ───────────────────────────────────────────────────────── */

exportRouter.get(
  "/daybook",
  requirePermission("daybook.export"),
  exportLimiter,
  validate({ query: rangeSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as z.infer<typeof rangeSchema>;

    const { items, totals, total } = await listing.list(
      { from: query.from, to: query.to },
      { ...paging({ limit: MAX_ROWS }, { date: -1, _id: -1 }), limit: MAX_ROWS },
    );

    await audit.recordSafe(audit.auditContextFrom(req), {
      action: "EXPORT",
      entity: "DayBook",
      entityLabel: `${items.length} of ${total} rows as ${query.format.toUpperCase()}`,
      newValue: { from: query.from, to: query.to, rows: items.length, total },
    });

    await exporter.sendExport<TransactionRow>(res, query.format, {
      filename: "daybook",
      title: "DayBook",
      subtitle: total > items.length ? `Showing the first ${items.length} of ${total} transactions` : undefined,
      columns: [
        { key: "date", header: "Date", width: 70, value: (r) => new Date(r.date).toLocaleDateString("en-IN") },
        { key: "txnNo", header: "Voucher No", width: 110, value: (r) => r.txnNo },
        { key: "type", header: "Type", width: 80, value: (r) => r.typeLabel },
        { key: "name", header: "Name", width: 130, value: (r) => r.party?.name ?? r.accountLabel },
        { key: "account", header: "Account", width: 130, value: (r) => r.accountLabel },
        { key: "mode", header: "Payment Type", width: 80, value: (r) => r.paymentMode ?? "" },
        { key: "reference", header: "Reference No", width: 90, value: (r) => r.referenceNo ?? "" },
        { key: "total", header: "Total", type: "money", width: 90, value: (r) => r.grossAmount, total: true },
        { key: "moneyIn", header: "Money In", type: "money", width: 90, value: (r) => r.moneyIn || null, total: true },
        { key: "moneyOut", header: "Money Out", type: "money", width: 90, value: (r) => r.moneyOut || null, total: true },
        { key: "charges", header: "Charges", type: "money", width: 80, value: (r) => r.chargeAmount || null, total: true },
        { key: "description", header: "Description", width: 150, value: (r) => r.narration ?? "" },
        { key: "createdBy", header: "Created By", width: 90, value: (r) => r.createdBy?.name ?? "" },
        { key: "status", header: "Status", width: 70, value: (r) => r.status },
      ],
      rows: items,
      meta: await exporter.exportMeta({
        from: query.from,
        to: query.to,
        generatedBy: req.auth!.name,
      }),
      summary: [
        { label: "Money In", value: formatINR(totals.moneyIn) },
        { label: "Money Out", value: formatINR(totals.moneyOut) },
        { label: "Charges", value: formatINR(totals.charges) },
        { label: "Net movement", value: formatINR(totals.net), emphasis: true },
      ],
    });
  }),
);

/* ── Profit & Loss ───────────────────────────────────────────────────────── */

exportRouter.get(
  "/profit-loss",
  requirePermission("profit_loss.export"),
  exportLimiter,
  validate({ query: rangeSchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as z.infer<typeof rangeSchema>;

    const pnl = await reports.profitAndLoss({ from: query.from, to: query.to });

    // Income and expenses in one table with a section column — a spreadsheet the
    // recipient can pivot beats two tables they have to stitch together.
    const rows = [
      ...pnl.income.map((l) => ({ ...l, section: "Income" })),
      ...pnl.expenses.map((l) => ({ ...l, section: "Expense" })),
    ];

    await audit.recordSafe(audit.auditContextFrom(req), {
      action: "EXPORT",
      entity: "ProfitAndLoss",
      entityLabel: `${query.from.toISOString().slice(0, 10)} to ${query.to.toISOString().slice(0, 10)}`,
      amount: pnl.netProfit,
    });

    await exporter.sendExport<PnLLine & { section: string }>(res, query.format, {
      filename: "profit-and-loss",
      title: "Profit & Loss",
      columns: [
        { key: "section", header: "Section", width: 80, value: (r) => r.section },
        { key: "code", header: "Code", width: 90, value: (r) => r.code },
        { key: "name", header: "Head", width: 200, value: (r) => r.name },
        { key: "amount", header: "Amount", type: "money", width: 110, value: (r) => r.amount },
        { key: "share", header: "Share %", width: 70, align: "right", value: (r) => r.share.toFixed(1) },
      ],
      rows,
      meta: await exporter.exportMeta({
        from: query.from,
        to: query.to,
        generatedBy: req.auth!.name,
      }),
      summary: [
        { label: "Total income", value: formatINR(pnl.totalIncome) },
        { label: "Total expenses", value: formatINR(pnl.totalExpenses) },
        { label: "  of which charges", value: formatINR(pnl.totalCharges) },
        { label: "NET PROFIT", value: formatINR(pnl.netProfit), emphasis: true },
        { label: "Margin", value: pnl.margin === null ? "—" : `${pnl.margin.toFixed(1)}%` },
        // Reported alongside, labelled as the different question it is (§21).
        {
          label: "Cash movement (NOT profit — different question)",
          value: formatINR(pnl.cashMovement),
        },
      ],
    });
  }),
);

/* ── Balance Sheet ───────────────────────────────────────────────────────── */

exportRouter.get(
  "/balance-sheet",
  requirePermission("balance_sheet.export"),
  exportLimiter,
  validate({ query: z.object({ asOf: z.coerce.date().optional() }).merge(formatSchema) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { asOf?: Date; format: exporter.ExportFormat };
    const asOf = query.asOf ?? new Date();

    const sheet = await reports.balanceSheet({ asOf });

    const rows = [
      ...sheet.assets.map((l) => ({ ...l, section: "Asset" })),
      ...sheet.liabilities.map((l) => ({ ...l, section: "Liability" })),
      ...sheet.equity.map((l) => ({ ...l, section: "Equity" })),
      {
        section: "Equity",
        ledgerAccountId: "retained",
        code: "RETAINED",
        name: "Retained earnings (income less expenses to date)",
        kind: "EQUITY" as const,
        amount: sheet.retainedEarnings,
      },
    ];

    await audit.recordSafe(audit.auditContextFrom(req), {
      action: "EXPORT",
      entity: "BalanceSheet",
      entityLabel: asOf.toISOString().slice(0, 10),
    });

    await exporter.sendExport(res, query.format, {
      filename: "balance-sheet",
      title: "Balance Sheet",
      columns: [
        { key: "section", header: "Section", width: 90, value: (r) => r.section },
        { key: "code", header: "Code", width: 100, value: (r) => r.code },
        { key: "name", header: "Account", width: 240, value: (r) => r.name },
        { key: "amount", header: "Amount", type: "money", width: 120, value: (r) => r.amount },
      ],
      rows,
      meta: await exporter.exportMeta({
        asOf,
        generatedBy: req.auth!.name,
      }),
      summary: [
        { label: "Total assets", value: formatINR(sheet.totalAssets) },
        { label: "Total liabilities", value: formatINR(sheet.totalLiabilities) },
        { label: "Total equity", value: formatINR(sheet.totalEquity) },
        {
          // Stated on the export exactly as on screen — a balance sheet that quietly
          // forced itself to balance would be worthless.
          label: sheet.balances ? "Difference (balances)" : "DIFFERENCE — DOES NOT BALANCE",
          value: formatINR(sheet.difference),
          emphasis: true,
        },
      ],
    });
  }),
);

/* ── Trial balance ───────────────────────────────────────────────────────── */

exportRouter.get(
  "/trial-balance",
  requirePermission("trial_balance.export"),
  exportLimiter,
  validate({ query: z.object({ asOf: z.coerce.date().optional() }).merge(formatSchema) }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as { asOf?: Date; format: exporter.ExportFormat };

    const { trialBalance } = await import("../../services/ledger.service.js");
    const tb = await trialBalance({ ...(query.asOf ? { asOf: query.asOf } : {}) });

    await audit.recordSafe(audit.auditContextFrom(req), { action: "EXPORT", entity: "TrialBalance" });

    await exporter.sendExport(res, query.format, {
      filename: "trial-balance",
      title: "Trial Balance",
      columns: [
        { key: "code", header: "Code", width: 110, value: (r) => r.code },
        { key: "name", header: "Account", width: 240, value: (r) => r.name },
        { key: "kind", header: "Kind", width: 80, value: (r) => r.kind },
        { key: "debit", header: "Debit", type: "money", width: 110, value: (r) => r.debit || null, total: true },
        { key: "credit", header: "Credit", type: "money", width: 110, value: (r) => r.credit || null, total: true },
      ],
      rows: tb.rows,
      meta: await exporter.exportMeta({
        asOf: query.asOf ?? new Date(),
        generatedBy: req.auth!.name,
      }),
      summary: [
        {
          label: tb.difference === 0 ? "Difference (the books tie)" : "DIFFERENCE — OUT OF BALANCE",
          value: formatINR(tb.difference),
          emphasis: true,
        },
      ],
    });
  }),
);

/* ── Ledger statement — the Cash Book, Bank Book and Party Ledger (§34) ──── */

exportRouter.get(
  "/ledger/:accountId",
  requirePermission("general_ledger.export"),
  exportLimiter,
  validate({ params: z.object({ accountId: objectId }), query: rangeSchema.partial({ from: true, to: true }) }),
  asyncHandler(async (req, res) => {
    const { accountId } = req.valid.params as { accountId: string };
    const query = req.valid.query as { from?: Date; to?: Date; format: exporter.ExportFormat };

    const account = await LedgerAccount.findById(accountId).lean();
    if (!account) throw new BadRequestError("That ledger account does not exist");

    const filter: Record<string, unknown> = { ledgerAccountId: account._id };
    if (query.from || query.to) {
      filter.date = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
    }

    const entries = await LedgerEntry.find(filter).sort({ date: 1, _id: 1 }).limit(MAX_ROWS).lean();

    /**
     * The Contra column carries the AMOUNTS, exactly as the on-screen statement does.
     *
     * An exported bank statement whose contra reads "101, Bank Charges" against a
     * ₹1,00,000 credit sends the reader off to reconstruct the ₹98,500/₹1,500 split by
     * hand — the same subtraction that gets done wrong on screen, now in a spreadsheet
     * where nobody can check it against the ledger.
     */
    const txnIds = [...new Set(entries.map((e) => String(e.transactionId)))];
    const siblings = txnIds.length
      ? await LedgerEntry.find({ transactionId: { $in: txnIds } })
          .select("transactionId ledgerAccountId amount")
          .populate<{ ledgerAccountId: { _id: Types.ObjectId; name: string } }>(
            "ledgerAccountId",
            "name",
          )
          .lean()
      : [];

    const contraByTxn = new Map<string, string[]>();
    for (const s of siblings) {
      if (String(s.ledgerAccountId?._id) === String(account._id)) continue;
      const key = String(s.transactionId);
      const list = contraByTxn.get(key) ?? [];
      list.push(`${s.ledgerAccountId?.name ?? "—"} ${formatINR(s.amount)}`);
      contraByTxn.set(key, list);
    }

    await audit.recordSafe(audit.auditContextFrom(req), {
      action: "EXPORT",
      entity: "LedgerAccount",
      entityId: accountId,
      entityLabel: account.name,
      newValue: { rows: entries.length },
    });

    await exporter.sendExport(res, query.format, {
      filename: `ledger-${account.code.toLowerCase()}`,
      title: `Ledger — ${account.name}`,
      subtitle: account.code,
      columns: [
        { key: "date", header: "Date", width: 80, value: (r) => r.date.toLocaleDateString("en-IN") },
        { key: "txnNo", header: "Voucher No", width: 120, value: (r) => r.txnNo },
        { key: "type", header: "Type", width: 90, value: (r) => TRANSACTION_TYPE_LABEL[r.transactionType] ?? r.transactionType },
        { key: "narration", header: "Description", width: 220, value: (r) => r.narration ?? "" },
        { key: "contra", header: "Contra", width: 200, value: (r) => (contraByTxn.get(String(r.transactionId)) ?? r.contra ?? []).join(" · ") },
        { key: "debit", header: "Debit", type: "money", width: 100, value: (r) => (r.direction === "DEBIT" ? r.amount : null), total: true },
        { key: "credit", header: "Credit", type: "money", width: 100, value: (r) => (r.direction === "CREDIT" ? r.amount : null), total: true },
        { key: "balance", header: "Balance", type: "money", width: 110, value: (r) => r.runningBalance },
      ],
      rows: entries,
      meta: await exporter.exportMeta({
        from: query.from,
        to: query.to,
        generatedBy: req.auth!.name,
      }),
      summary: [{ label: "Closing balance", value: formatINR(account.cachedBalance), emphasis: true }],
    });
  }),
);

/* ── Audit log ───────────────────────────────────────────────────────────── */

exportRouter.get(
  "/audit",
  requirePermission("audit.export"),
  exportLimiter,
  /**
   * The screen's filters are accepted here as well, and they mean the same thing.
   *
   * An export button that silently dropped the active filter would hand the operator a
   * different report under the same name — they filtered to failed sign-ins, downloaded
   * it, and got ten thousand unrelated rows. Whatever is on screen is what comes out.
   */
  validate({
    query: rangeSchema.partial({ from: true, to: true }).extend({
      action: z.string().trim().max(40).optional(),
      entity: z.string().trim().max(60).optional(),
      failuresOnly: booleanFlag.optional(),
      q: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as {
      from?: Date;
      to?: Date;
      action?: string;
      entity?: string;
      failuresOnly?: boolean;
      q?: string;
      format: exporter.ExportFormat;
    };

    const filter: Record<string, unknown> = {};

    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: new Date(query.to.getTime() + 86_399_999) } : {}),
      };
    }
    if (query.action) filter.action = query.action;
    if (query.entity) filter.entity = query.entity;
    if (query.failuresOnly) filter.success = false;

    if (query.q) {
      // Same fields the list screen searches, so the two agree on what a hit is.
      const rx = new RegExp(escapeRegex(query.q), "i");
      const search = [{ userName: rx }, { entityLabel: rx }, { reason: rx }, { entity: rx }];
      filter.$and = filter.$or ? [{ $or: filter.$or }, { $or: search }] : [{ $or: search }];
      delete filter.$or;
    }

    const rows = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(MAX_ROWS).lean();

    // Exporting the audit log is itself audited. Recursive, and correct: taking a copy of
    // the trail out of the system is precisely the event the trail should record.
    await audit.recordSafe(audit.auditContextFrom(req), {
      action: "EXPORT",
      entity: "AuditLog",
      entityLabel: `${rows.length} entries`,
    });

    await exporter.sendExport(res, query.format, {
      filename: "audit-log",
      title: "Audit Log",
      columns: [
        { key: "at", header: "When", width: 130, value: (r) => r.createdAt.toLocaleString("en-IN") },
        { key: "action", header: "Action", width: 110, value: (r) => r.action },
        { key: "entity", header: "Record Type", width: 100, value: (r) => r.entity },
        { key: "label", header: "Record", width: 180, value: (r) => r.entityLabel ?? r.entityId ?? "" },
        { key: "user", header: "User", width: 120, value: (r) => r.userName },
        { key: "role", header: "Role", width: 100, value: (r) => r.roleName ?? "" },
        { key: "amount", header: "Amount", type: "money", width: 100, value: (r) => r.amount ?? null },
        { key: "reason", header: "Reason", width: 200, value: (r) => r.reason ?? "" },
        { key: "ip", header: "IP", width: 90, value: (r) => r.ip ?? "" },
        { key: "success", header: "Result", width: 70, value: (r) => (r.success ? "OK" : "FAILED") },
      ],
      rows,
      meta: await exporter.exportMeta({
        from: query.from,
        to: query.to,
        generatedBy: req.auth!.name,
        // §54: the filters are printed on the export, so a file that landed in an inbox
        // still says which slice of the trail it is.
        filters: {
          Rows: String(rows.length),
          ...(query.action ? { Action: query.action } : {}),
          ...(query.entity ? { "Record type": query.entity } : {}),
          ...(query.failuresOnly ? { Showing: "Failed actions only" } : {}),
          ...(query.q ? { Search: query.q } : {}),
        },
      }),
    });
  }),
);
