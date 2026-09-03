import { Types } from "mongoose";
import { parseAmount } from "@amiri/shared";
import { logger } from "../config/logger.js";
import {
  BankAccount,
  CashAccount,
  ChargeRule,
  ExpenseCategory,
  IncomeHead,
  Party,
  Transaction,
} from "../models/index.js";
import * as payments from "../modules/transactions/payment.service.js";
import * as expenses from "../modules/transactions/expense.service.js";
import type { AuditContext } from "../services/audit.service.js";

/**
 * Phase 3 sample data.
 *
 * Reconstructs the 19/08/2026 DayBook described in the brief — including the ₹9,50,000
 * RAMANUJ PUNB → EDDIGO DISTRIBUTOR bank-to-bank transfer, and the itemised panel and
 * domain expenses.
 *
 * Every entry is posted THROUGH THE REAL SERVICES, so the sample books are genuine
 * double-entry and the trial balance ties. Sample data inserted straight into collections
 * would not balance, and would conceal exactly the bugs a seed exists to surface.
 */

const CHARGE_RULES = [
  {
    name: "Distributor Commission 1.75%",
    code: "DIST-175",
    description: "Commission retained on distributor collections.",
    type: "PERCENTAGE" as const,
    rateBps: 175,
    bearer: "PARTY" as const,
    appliesTo: ["PAYMENT_IN"],
    partyTypes: ["DISTRIBUTOR"],
  },
  {
    name: "RTGS Transfer Fee",
    code: "RTGS-FEE",
    description: "Flat bank charge on an RTGS transfer.",
    type: "FIXED" as const,
    fixedAmount: parseAmount("50"),
    bearer: "SELF" as const,
    appliesTo: ["BANK_TRANSFER"],
  },
  {
    name: "Tiered Settlement Fee",
    code: "SETTLE-TIER",
    description: "Falls as the settled amount rises.",
    type: "TIERED" as const,
    bearer: "SELF" as const,
    appliesTo: ["BANK_TRANSFER", "SETTLEMENT"],
    tiers: [
      { upTo: parseAmount("50,000"), fixedAmount: parseAmount("25") },
      { upTo: parseAmount("5,00,000"), rateBps: 10 },
      { upTo: null, rateBps: 5 },
    ],
    minCharge: parseAmount("10"),
    maxCharge: parseAmount("2,000"),
  },
];

export async function seedTransactions(
  ctx: AuditContext,
): Promise<void> {
  /* ── Charge rules ──────────────────────────────────────────────────────── */
  for (const rule of CHARGE_RULES) {
    if (await ChargeRule.exists({ code: rule.code })) continue;
    await ChargeRule.create({ ...rule, status: "ACTIVE", createdBy: ctx.userId });
  }
  logger.info({ count: CHARGE_RULES.length }, "charge rules ready");

  /* ── Expense and income heads ──────────────────────────────────────────── */
  for (const name of expenses.DEFAULT_EXPENSE_HEADS) {
    await expenses.ensureHead("EXPENSE", name, ctx);
  }
  for (const name of expenses.DEFAULT_INCOME_HEADS) {
    await expenses.ensureHead("INCOME", name, ctx);
  }
  logger.info(
    { expense: expenses.DEFAULT_EXPENSE_HEADS.length, income: expenses.DEFAULT_INCOME_HEADS.length },
    "expense and income heads ready",
  );

  /* ── The 19/08/2026 DayBook ────────────────────────────────────────────── */

  const dayBookDate = new Date(Date.UTC(2026, 7, 19));

  const [hdfc, icici] = await Promise.all([
    BankAccount.findOne({ accountNumber: "50100234567890" }).lean(),
    BankAccount.findOne({ accountNumber: "002105001234" }).lean(),
  ]);
  const cash = await CashAccount.findOne({ isDefault: true }).lean();
  const ramanuj = await Party.findOne({ name: "RAMANUJ PUNB" }).lean();
  const eddigo = await Party.findOne({ name: "EDDIGO DISTRIBUTOR" }).lean();
  const sharma = await Party.findOne({ name: "Sharma Traders" }).lean();
  const panelVendor = await Party.findOne({ name: "Bihar Panel Services" }).lean();

  if (!hdfc || !icici || !cash || !ramanuj || !eddigo || !sharma || !panelVendor) {
    logger.warn("master data missing — skipping sample transactions");
    return;
  }

  const id = (v: { _id: Types.ObjectId }) => String(v._id);
  const distributorRule = await ChargeRule.findOne({ code: "DIST-175" }).lean();
  const rtgsRule = await ChargeRule.findOne({ code: "RTGS-FEE" }).lean();

  const panelHead = await ExpenseCategory.findOne({ name: "Panel Expense" }).lean();
  const domainHead = await ExpenseCategory.findOne({ name: "Domain" }).lean();
  const salaryHead = await ExpenseCategory.findOne({ name: "Salary" }).lean();
  const commissionHead = await IncomeHead.findOne({ name: "Commission" }).lean();

  const base = { date: dayBookDate, attachments: [] as never[] };

  /**
   * PER-TRANSACTION idempotence, keyed on a stable reference.
   *
   * An earlier version guarded the whole block with "does any transaction exist for this
   * date". That is all-or-nothing, and it fails badly: when one entry in the middle threw,
   * the earlier ones were already committed, so the next run saw them, skipped everything,
   * and the remaining entries could never be posted. The seed became permanently
   * incomplete with no error to show for it.
   *
   * Checking each entry on its own makes the seed resumable — rerun it after fixing a
   * failure and only the missing entries are posted.
   */
  const post = async (ref: string, fn: () => Promise<unknown>): Promise<void> => {
    if (await Transaction.exists({ referenceNo: ref })) return;
    await fn();
    posted += 1;
  };

  let posted = 0;

  // 1. Payment In — a distributor collection, with the 1.75% commission retained.
  await post("NEFT2026081901", () => payments.createPaymentIn(
    {
      ...base,
      partyId: id(ramanuj),
      accountId: id(hdfc),
      amount: parseAmount("4,50,000"),
      paymentMode: "NEFT",
      referenceNo: "NEFT2026081901",
      chargeRuleId: distributorRule ? String(distributorRule._id) : undefined,
      narration: "Collection from RAMANUJ PUNB",
    } as never,
    ctx,
  ));

  // 2. Payment In — cash over the counter.
  await post("CASH2026081902", () => payments.createPaymentIn(
    {
      ...base,
      partyId: id(sharma),
      accountId: id(cash),
      amount: parseAmount("35,000"),
      paymentMode: "CASH",
      referenceNo: "CASH2026081902",
      narration: "Cash received from Sharma Traders",
    } as never,
    ctx,
  ));

  // 3. THE headline entry from the brief: ₹9,50,000 bank to bank, RTGS, ₹50 fee.
  await post("RTGS2026081907", () => payments.createBankTransfer(
    {
      ...base,
      sourceAccountId: id(hdfc),
      destinationAccountId: id(icici),
      amount: parseAmount("9,50,000"),
      paymentMode: "RTGS",
      referenceNo: "RTGS2026081907",
      chargeRuleId: rtgsRule ? String(rtgsRule._id) : undefined,
      narration: "RAMANUJ PUNB to EDDIGO DISTRIBUTOR settlement",
    } as never,
    ctx,
  ));

  // 4. Payment Out — settling a vendor.
  await post("IMPS2026081912", () => payments.createPaymentOut(
    {
      ...base,
      partyId: id(eddigo),
      accountId: id(icici),
      amount: parseAmount("2,40,000"),
      paymentMode: "IMPS",
      referenceNo: "IMPS2026081912",
      narration: "Settlement to EDDIGO DISTRIBUTOR",
    } as never,
    ctx,
  ));

  // 5. Itemised panel expense — the shape the brief's DayBook shows.
  if (panelHead) {
    await post("BPS/2026/0812", () => expenses.createExpense(
      {
        ...base,
        categoryId: String(panelHead._id),
        partyId: id(panelVendor),
        accountId: id(hdfc),
        amount: parseAmount("18,500"),
        taxAmount: parseAmount("0"),
        paymentMode: "BANK_TRANSFER",
        invoiceNo: "BPS/2026/0812",
        items: [
          { description: "Panel licence — August", quantity: 3, unitPrice: parseAmount("5,000"), amount: parseAmount("15,000") },
          { description: "Support retainer", quantity: 1, unitPrice: parseAmount("3,500"), amount: parseAmount("3,500") },
        ],
      } as never,
      ctx,
    ));
  }

  // 6. Domain and hosting, paid in cash.
  if (domainHead) {
    await post("DOM2026081903", () => expenses.createExpense(
      {
        ...base,
        categoryId: String(domainHead._id),
        accountId: id(cash),
        amount: parseAmount("2,400"),
        taxAmount: parseAmount("432"),
        paymentMode: "CASH",
        referenceNo: "DOM2026081903",
        items: [
          { description: "amirifinance.in renewal (2 yr)", quantity: 2, unitPrice: parseAmount("1,200"), amount: parseAmount("2,400") },
        ],
      } as never,
      ctx,
    ));
  }

  // 7. Salary, unpaid — booked as a payable rather than settled.
  if (salaryHead) {
    await post("SAL2026081904", () => expenses.createExpense(
      {
        ...base,
        categoryId: String(salaryHead._id),
        accountId: id(hdfc),
        amount: parseAmount("1,45,000"),
        taxAmount: parseAmount("0"),
        paymentMode: "NEFT",
        referenceNo: "SAL2026081904",
        narration: "August salaries — Boring Road",
      } as never,
      ctx,
    ));
  }

  // 8. Income that is NOT a party payment.
  if (commissionHead) {
    await post("COMM2026081905", () => expenses.createIncome(
      {
        ...base,
        headId: String(commissionHead._id),
        accountId: id(hdfc),
        amount: parseAmount("22,750"),
        paymentMode: "UPI",
        referenceNo: "COMM2026081905",
        narration: "Aggregator commission — August",
      } as never,
      ctx,
    ));
  }

  logger.info({ posted }, "sample transactions ready for 19/08/2026");

  await seedSavings(ctx);
}

/**
 * Bachat Khata members (§13).
 *
 * Opened through the real service so each account's opening balance is a genuine
 * double-entry posting — and, being a LIABILITY, is credited rather than debited.
 */
async function seedSavings(ctx: AuditContext): Promise<void> {
  const { SavingsAccount } = await import("../models/index.js");
  const savings = await import("../modules/savings/savings.service.js");

  const members = [
    { memberName: "Kamla Devi", mobile: "9876500011", interestRateBps: 650, opening: "25,000" },
    { memberName: "Ram Prasad", mobile: "9876500022", interestRateBps: 650, opening: "12,500" },
    { memberName: "Sunita Kumari", mobile: "9876500033", interestRateBps: 700, opening: "48,000" },
  ];

  let opened = 0;
  for (const member of members) {
    if (await SavingsAccount.exists({ memberName: member.memberName })) continue;
    await savings.createAccount(
      {
        memberName: member.memberName,
        mobile: member.mobile,
        interestRateBps: member.interestRateBps,
        openingBalance: parseAmount(member.opening),
        openingDate: new Date(Date.UTC(2026, 3, 1)),
      } as never,
      ctx,
    );
    opened += 1;
  }

  logger.info({ opened }, "bachat khata members ready");
}
