import { z } from "zod";
import { CHARGE_BEARER, CHARGE_TYPE, PARTY_TYPE, RECORD_STATUS, TRANSACTION_TYPE } from "../enums.js";
import { basisPoints, listQuery, money, nonNegativeMoney, note, objectId } from "./common.js";

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
 * Whether a charge comes OUT of the amount or is paid ON TOP of it.
 *
 *   DEDUCTED — the settlement shrinks. ₹50,000 gross, ₹750 charge, ₹49,250 moves.
 *   ADDED    — the settlement grows.  ₹50,000 gross, ₹750 charge, ₹50,750 moves.
 */
export type ChargeEffect = "DEDUCTED" | "ADDED";

/**
 * Which way a charge pushes the settlement.
 *
 * This is the rule that `netAmount` on every transaction obeys, and it exists as one
 * exported function because it was previously assumed rather than stated: `net` was
 * computed as `gross − charge` everywhere, which is wrong for exactly the case below and
 * produced a summary figure that appeared nowhere in the posting — a ₹50,000 payment out
 * with a ₹750 fee we bear takes ₹50,750 out of the bank, and calling that ₹49,250 made the
 * header disagree with its own ledger entries.
 *
 * The counterparty bearing it (PARTY) always means DEDUCTED: they receive less, or they
 * settle less, and we keep the difference as commission.
 *
 * Us bearing it (SELF) depends on which way the money is going, because "we absorb the
 * fee" has opposite effects on our own account:
 *
 *   money coming IN  — the fee is taken out of what reaches us, so LESS arrives (DEDUCTED)
 *   money going OUT  — the fee is charged on top of what we send, so MORE leaves  (ADDED)
 */
export function chargeEffect(
  transactionType: string,
  bearer: "SELF" | "PARTY" | string,
): ChargeEffect {
  if (bearer === "PARTY") return "DEDUCTED";

  switch (transactionType) {
    case TRANSACTION_TYPE.PAYMENT_OUT:
    case TRANSACTION_TYPE.BANK_TRANSFER:
    case TRANSACTION_TYPE.SETTLEMENT:
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
  return effect === "ADDED" ? gross + charge : gross - charge;
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
  appliesTo: string[];
  partyTypes: string[];
  status: string;
  /** A worked example on ₹1,00,000, so the effect of the rule is visible at a glance. */
  sampleOn100k: number;
}

/** Preview a charge before committing to it — powers the live figure in the form. */
export const previewChargeSchema = z.object({
  chargeRuleId: objectId,
  amount: money,
});
export type PreviewChargeInput = z.infer<typeof previewChargeSchema>;

export interface ChargeBreakdown {
  gross: number;
  charge: number;
  /**
   * What settles when the charge is DEDUCTED — the counterparty's side of a party-borne
   * charge. The calculator has no transaction type, so it cannot say which way a
   * self-borne charge would push the settlement; `chargeEffect` decides that at posting
   * time, and `effect` below reports what this rule's bearer implies.
   */
  net: number;
  /** DEDUCTED for a party-borne charge; for a self-borne one it depends on the direction. */
  bearer: string;
  ruleName: string;
  /** Human explanation: "1.75% of ₹1,00,000", "Fixed ₹50", "Tier 2: 1.5%". */
  basis: string;
}
