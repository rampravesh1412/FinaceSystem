import { z } from "zod";
import { CHARGE_BEARER, CHARGE_TYPE, PARTY_TYPE, RECORD_STATUS, TRANSACTION_TYPE } from "../enums.js";
import {
  basisPoints,
  booleanFlag,
  listQuery,
  money,
  nonNegativeMoney,
  note,
  objectId,
  optionalObjectId,
} from "./common.js";

/**
 * Charges and commission (§18).
 *
 * Two rules govern every charge in this system:
 *
 *   1. A charge NEVER silently modifies the transaction amount. Gross, charge and net are
 *      three separate stored fields and three separate ledger effects. A distributor
 *      charged 1.75% on ₹1,00,000 sees ₹1,00,000 / ₹1,750 / ₹98,250 — not a mysterious
 *      ₹98,250 they have to reverse-engineer.
 *
 *   2. Rates are integer BASIS POINTS, never a float percent. 1.75% is `175`, exactly.
 *      A commission that drifts by a paisa per transaction is a reconciliation nightmare
 *      at month end.
 */

/* -------------------------------------------------------------------------- */
/* What a charge does to the settlement                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a charge does to the SETTLEMENT — the figure that moves through the bank or drawer.
 *
 *   DEDUCTED — the settlement shrinks.  ₹1,00,000 gross, ₹1,500 charge →   ₹98,500 moves
 *   ADDED    — the settlement grows.    ₹1,00,000 gross, ₹1,500 charge → ₹1,01,500 moves
 *   ABSORBED — the settlement is the gross, and the COUNTERPARTY takes the shortfall:
 *              ₹1,00,000 leaves the bank, ₹1,500 is eaten by the fee, and the party is
 *              credited only ₹98,500.
 *
 * All three balance. They differ in who is short of the ₹1,500 — us, nobody, or them —
 * and on a ₹1,00,000 payout the extremes are ₹3,000 apart, which is why the rule states
 * it explicitly rather than leaving it to be inferred from the bearer.
 */
export type ChargeEffect = "DEDUCTED" | "ADDED" | "ABSORBED";

/**
 * Which way a charge pushes the settlement.
 *
 * Every `netAmount` in the system comes from here, so the header, the preview and the
 * ledger entries cannot tell three different stories. It exists as one exported function
 * because it used to be assumed: `net` was computed as `gross − charge` everywhere, and a
 * payment out with a fee we bear takes MORE than the gross out of the bank, so the header
 * quoted a figure that appeared nowhere in its own posting.
 *
 * Two independent facts decide the answer, and keeping them apart is what lets all three
 * arrangements be expressed:
 *
 *   WHO THE COST FALLS ON (`bearer`)
 *     PARTY — we keep the charge, so it is our INCOME. Always DEDUCTED: the party's claim
 *             is discharged in full and we pay out less, or they settle less and we bank
 *             the same. Either way we are ₹1,500 better off.
 *     SELF  — a third party took it, so it is our EXPENSE.
 *
 *   WHETHER IT COMES OUT OF THE AMOUNT (`deductFromAmount`)
 *     Only meaningful for a SELF-borne charge on money going OUT, where both readings are
 *     genuinely available:
 *       true  — the fee is taken from the ₹1,00,000 in transit. ₹1,00,000 leaves the bank,
 *               ₹98,500 reaches the party, we expense ₹1,500. → ABSORBED
 *       false — the fee is levied separately, as a bank's NEFT charge is. ₹1,01,500 leaves
 *               the bank, the party gets their full ₹1,00,000. → ADDED
 *
 * Money coming IN has only one sensible SELF reading — the fee is taken out of what
 * reaches us, so less arrives — because "on top" would credit the party more than they
 * sent. A BANK_TRANSFER is always ADDED: the destination must receive the full gross or
 * the receiving statement will not reconcile.
 */
export function chargeEffect(
  transactionType: string,
  bearer: "SELF" | "PARTY" | string,
  deductFromAmount = true,
): ChargeEffect {
  if (bearer === "PARTY") return "DEDUCTED";

  switch (transactionType) {
    case TRANSACTION_TYPE.PAYMENT_OUT:
    case TRANSACTION_TYPE.SETTLEMENT:
      return deductFromAmount ? "ABSORBED" : "ADDED";

    // The destination receives the gross, so a fee is always extra money leaving.
    case TRANSACTION_TYPE.BANK_TRANSFER:
      return "ADDED";

    default:
      return "DEDUCTED";
  }
}

/**
 * What actually settles — the figure that must equal a real line in the posting.
 *
 * Every `netAmount` in the system is produced by this function, so the header and the
 * ledger entries below it can never tell different stories.
 */
export function settlementNet(gross: number, charge: number, effect: ChargeEffect): number {
  switch (effect) {
    case "ADDED":
      return gross + charge;
    case "ABSORBED":
      // The gross is what left the account; the counterparty is the one short of the fee.
      return gross;
    default:
      return gross - charge;
  }
}

/** One band of a tiered rate. `upTo` is inclusive; the last tier leaves it null. */
export const chargeTierSchema = z.object({
  upTo: money.nullable(),
  rateBps: basisPoints.optional(),
  fixedAmount: nonNegativeMoney.optional(),
});
export type ChargeTier = z.infer<typeof chargeTierSchema>;

export const createChargeRuleSchema = z
  .object({
    name: z.string().trim().min(2, "Name is required").max(80),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(24)
      .regex(/^[A-Z0-9_-]+$/, "Use letters, digits, hyphens and underscores"),
    description: z.string().trim().max(300).optional(),

    type: z.nativeEnum(CHARGE_TYPE),

    /** PERCENTAGE: the rate in basis points. 1.75% = 175. */
    rateBps: basisPoints.optional(),
    /** FIXED: a flat amount per transaction. */
    fixedAmount: nonNegativeMoney.optional(),
    /** TIERED: ordered bands, each with its own rate or flat amount. */
    tiers: z.array(chargeTierSchema).optional(),

    /** Floors and ceilings applied after the base calculation. 0 means "no bound". */
    minCharge: nonNegativeMoney.default(0),
    maxCharge: nonNegativeMoney.default(0),

    /**
     * Who absorbs the charge. This decides which side of the ledger it lands on:
     *   SELF  — our expense; the source pays gross + charge
     *   PARTY — our income; the party is credited gross - charge
     */
    bearer: z.nativeEnum(CHARGE_BEARER).default("SELF"),

    /**
     * Does the charge come out of the amount, or is it levied on top of it?
     *
     * Only bites on a SELF-borne charge on money going out, where both are real:
     *   true  — ₹1,00,000 leaves the bank, ₹98,500 reaches the party, ₹1,500 is our cost
     *   false — ₹1,01,500 leaves the bank, the party receives their full ₹1,00,000
     *
     * Defaults to true because that is what "a 1.5% charge on ₹1,00,000" normally means:
     * the charge is ON the amount, not extra to it. A bank's own transfer fee is the
     * exception and wants false.
     *
     * `booleanFlag` rather than `z.boolean()`: the form renders this as a select, which
     * yields the STRING "false". A strict boolean would reject it, and the rejection would
     * land on a field whose error nothing renders — the button stays enabled and the save
     * silently does nothing.
     */
    deductFromAmount: booleanFlag.default(true),

    /**
     * Which head the charge posts to.
     *
     * Omit to use the built-in accounts — `EXP-BANK-CHARGES` for a cost, `INC-COMMISSION`
     * for income. Name one of your own heads to see the charge on a line you chose in the
     * Profit & Loss, which is the difference between "Bank Charges ₹40,000" and
     * "Panel Commission ₹40,000" on a report somebody has to explain.
     *
     * It must match the side the charge lands on: an expense head for a SELF-borne charge,
     * an income head for a party-borne one. Pointing a cost at an income head would post a
     * debit to income and print a negative figure in the wrong section.
     */
    chargeAccountId: optionalObjectId,

    /** Transaction types this rule may be applied to. Empty means any. */
    appliesTo: z.array(z.nativeEnum(TRANSACTION_TYPE)).default([]),
    /** Restrict to a party type, e.g. distributor commission. Empty means any. */
    partyTypes: z.array(z.nativeEnum(PARTY_TYPE)).default([]),

    status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
    notes: note(),
  })
  .superRefine((v, ctx) => {
    // A rule that cannot compute a charge is worse than no rule — it would silently
    // produce zero on every transaction it touched.
    if (v.type === "PERCENTAGE" && v.rateBps === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rateBps"], message: "A percentage rule needs a rate" });
    }
    if (v.type === "FIXED" && v.fixedAmount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedAmount"], message: "A fixed rule needs an amount" });
    }
    if (v.type === "TIERED") {
      if (!v.tiers?.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers"], message: "A tiered rule needs at least one band" });
      } else {
        // Bands must ascend, or a lookup would match the wrong one.
        let previous = -1;
        v.tiers.forEach((tier, i) => {
          if (tier.upTo !== null && tier.upTo <= previous) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["tiers", i, "upTo"],
              message: "Each band must have a higher ceiling than the one before it",
            });
          }
          if (tier.upTo !== null) previous = tier.upTo;
        });
        // Exactly one open-ended band, and it must be last, or amounts above the highest
        // ceiling would fall through and be charged nothing.
        const openEnded = v.tiers.filter((t) => t.upTo === null);
        if (openEnded.length !== 1 || v.tiers.at(-1)!.upTo !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tiers"],
            message: "The last band must be open-ended (no ceiling) so no amount is left uncharged",
          });
        }
      }
    }
    if (v.maxCharge > 0 && v.minCharge > v.maxCharge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxCharge"],
        message: "The maximum cannot be below the minimum",
      });
    }
  });
export type CreateChargeRuleInput = z.infer<typeof createChargeRuleSchema>;

/**
 * Change a charge rule — including RETIRING it, and including who bears it.
 *
 * `code` is omitted: it is the stable handle that posted transactions and exports quote,
 * so renaming it would orphan them. Everything else is editable, because the alternative
 * turned out to be worse than any risk of editing: `finance.charges.manage` was documented
 * as "create and edit charge rules" but only creation was ever built, so a rule set to the
 * wrong bearer could not be corrected at all — the operator had to abandon it and make
 * another, and the wrong one stayed in every picker.
 *
 * Editing a rule affects FUTURE postings only. Every transaction already posted froze its
 * own `chargeAmount` and its `chargeBasis` string at the time, so last month's commission
 * cannot be rewritten by changing this month's rate. That is what makes editing safe.
 */
export const updateChargeRuleSchema = createChargeRuleSchema
  .innerType()
  .omit({ code: true })
  .partial();
export type UpdateChargeRuleInput = z.infer<typeof updateChargeRuleSchema>;

export const chargeRuleQuerySchema = listQuery.extend({
  type: z.nativeEnum(CHARGE_TYPE).optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
  appliesTo: z.nativeEnum(TRANSACTION_TYPE).optional(),
});
export type ChargeRuleQuery = z.infer<typeof chargeRuleQuerySchema>;

export interface ChargeRuleSummary {
  id: string;
  name: string;
  code: string;
  description?: string;
  type: string;
  rateBps?: number;
  fixedAmount?: number;
  tiers?: ChargeTier[];
  minCharge: number;
  maxCharge: number;
  bearer: string;
  /** See `createChargeRuleSchema`. Decides ABSORBED vs ADDED on a payment out. */
  deductFromAmount: boolean;
  /** The head the charge posts to, or null for the built-in account. */
  chargeAccount: { id: string; name: string; code: string } | null;
  appliesTo: string[];
  partyTypes: string[];
  status: string;
  /** A worked example on ₹1,00,000, so the effect of the rule is visible at a glance. */
  sampleOn100k: number;
}

/**
 * Preview a charge before committing to it — powers the live figure in the form.
 *
 * `transactionType` is what makes the preview HONEST, and it was missing.
 *
 * Whether a charge is deducted from the amount or paid on top of it depends on the bearer
 * AND the direction of the money (see `chargeEffect`). Without the type, the preview had
 * to guess, and it guessed `gross − charge` every time — so a payment out with a fee we
 * absorb showed "Net ₹98,500" on the form and then posted ₹1,01,500 out of the bank. The
 * operator was shown one number and given another, which is the worst possible failure for
 * a figure whose entire job is to be checked before committing.
 */
export const previewChargeSchema = z.object({
  chargeRuleId: objectId,
  amount: money,
  transactionType: z.nativeEnum(TRANSACTION_TYPE).optional(),
});
export type PreviewChargeInput = z.infer<typeof previewChargeSchema>;

export interface ChargeBreakdown {
  gross: number;
  charge: number;
  /**
   * WHAT WILL ACTUALLY SETTLE — the same figure the posting will carry, computed by
   * `settlementNet`. Equal to `gross − charge` or `gross + charge` depending on `effect`.
   */
  net: number;
  /**
   * Which way the charge pushed the settlement. `ADDED` means more money moves than the
   * gross, which is the case a preview must never round to "net is less".
   */
  effect: ChargeEffect;
  bearer: string;
  ruleName: string;
  /** Human explanation: "1.75% of ₹1,00,000", "Fixed ₹50", "Tier 2: 1.5%". */
  basis: string;
}
