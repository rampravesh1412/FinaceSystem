import type { ClientSession } from "mongoose";
import { applyRate, bpsToPercent, formatINR, type ChargeBreakdown } from "@amiri/shared";
import { ChargeRule, type ChargeRuleDoc } from "../models/ChargeRule.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";

/**
 * The charge engine (§18).
 *
 * Three rules, and the whole file exists to enforce them:
 *
 *   1. The gross amount is NEVER modified. `computeCharge` returns the charge; the caller
 *      records gross, charge and net as three separate figures with three separate ledger
 *      effects. Nobody has to reverse-engineer where ₹1,750 went.
 *
 *   2. Rates are integer basis points and the multiply happens in BigInt. `amount × bps`
 *      overflows `Number.MAX_SAFE_INTEGER` well within realistic amounts, and a silent
 *      overflow here would produce a wrong commission on exactly the largest, most
 *      visible transactions.
 *
 *   3. Every computed charge carries a human `basis` string — "1.75% of ₹1,00,000" — which
 *      is FROZEN onto the transaction at posting time. Editing the rule next month must
 *      not rewrite what was charged last month.
 */

export interface ComputedCharge {
  amount: number;
  bearer: "SELF" | "PARTY";
  basis: string;
  ruleId: string | null;
  ruleName: string;
}

/**
 * Apply a rule to an amount.
 *
 * Ordering matters and is deliberate: compute the base charge, then clamp to the minimum,
 * then clamp to the maximum. Applying the cap before the floor would let a maximum of
 * ₹100 and a minimum of ₹500 produce ₹100, which contradicts the rule as written.
 */
export function computeCharge(rule: ChargeRuleDoc, amount: number): ComputedCharge {
  const gross = Math.abs(amount);
  let charge = 0;
  let basis = "";

  switch (rule.type) {
    case "PERCENTAGE": {
      const bps = rule.rateBps ?? 0;
      charge = applyRate(gross, bps);
      basis = `${bpsToPercent(bps)}% of ${formatINR(gross)}`;
      break;
    }

    case "FIXED": {
      charge = rule.fixedAmount ?? 0;
      basis = `Flat ${formatINR(charge)}`;
      break;
    }

    case "TIERED": {
      // The FIRST band whose ceiling the amount falls within. Bands are validated to
      // ascend with exactly one open-ended band last, so this always matches.
      const index = rule.tiers.findIndex((t) => t.upTo === null || gross <= t.upTo);
      const tier = rule.tiers[index];

      if (!tier) {
        throw new BadRequestError(
          `The charge rule "${rule.name}" has no band covering ${formatINR(gross)}`,
        );
      }

      const label = `Band ${index + 1}`;
      if (tier.rateBps !== undefined) {
        charge = applyRate(gross, tier.rateBps);
        basis = `${label}: ${bpsToPercent(tier.rateBps)}% of ${formatINR(gross)}`;
      } else {
        charge = tier.fixedAmount ?? 0;
        basis = `${label}: flat ${formatINR(charge)}`;
      }
      break;
    }

    default:
      throw new BadRequestError(`Unknown charge type on rule "${rule.name}"`);
  }

  if (rule.minCharge > 0 && charge < rule.minCharge) {
    basis += ` — raised to the ${formatINR(rule.minCharge)} minimum`;
    charge = rule.minCharge;
  }
  if (rule.maxCharge > 0 && charge > rule.maxCharge) {
    basis += ` — capped at ${formatINR(rule.maxCharge)}`;
    charge = rule.maxCharge;
  }

  /**
   * A charge can never exceed the amount it is levied on.
   *
   * Without this, a fixed ₹500 fee on a ₹100 transfer would produce a negative net, and
   * the resulting posting would credit the destination a negative figure — which the
   * ledger would reject, but only after a confusing journey.
   */
  if (charge > gross) {
    throw new BadRequestError(
      `The charge (${formatINR(charge)}) cannot exceed the transaction amount (${formatINR(gross)})`,
      "amount",
    );
  }

  return {
    amount: charge,
    bearer: rule.bearer,
    basis,
    ruleId: String(rule._id),
    ruleName: rule.name,
  };
}

/** Resolve a rule and apply it, or return a zero charge when no rule was chosen. */
export async function resolveCharge(
  options: {
    chargeRuleId?: string | null;
    manualCharge?: number;
    amount: number;
    transactionType: string;
    partyType?: string;
  },
  session?: ClientSession,
): Promise<ComputedCharge> {
  const { chargeRuleId, manualCharge, amount } = options;

  if (chargeRuleId) {
    const rule = await ChargeRule.findById(chargeRuleId).session(session ?? null);
    if (!rule) throw new NotFoundError("Charge rule", chargeRuleId);
    if (rule.status !== "ACTIVE") {
      throw new BadRequestError(`The charge rule "${rule.name}" is not active`, "chargeRuleId");
    }

    // A rule scoped to specific transaction types must not be applied elsewhere — a
    // distributor commission silently landing on a bank transfer would be a real error.
    if (rule.appliesTo.length > 0 && !rule.appliesTo.includes(options.transactionType)) {
      throw new BadRequestError(
        `The rule "${rule.name}" does not apply to this kind of transaction`,
        "chargeRuleId",
      );
    }
    if (options.partyType && rule.partyTypes.length > 0 && !rule.partyTypes.includes(options.partyType)) {
      throw new BadRequestError(
        `The rule "${rule.name}" only applies to ${rule.partyTypes.join(", ").toLowerCase()} parties`,
        "chargeRuleId",
      );
    }

    return computeCharge(rule, amount);
  }

  if (manualCharge && manualCharge > 0) {
    if (manualCharge > Math.abs(amount)) {
      throw new BadRequestError(
        `The charge (${formatINR(manualCharge)}) cannot exceed the transaction amount (${formatINR(amount)})`,
        "manualCharge",
      );
    }
    return {
      amount: manualCharge,
      // A manual charge is assumed to be ours to bear. Making someone else's commission
      // implicit would be the kind of silent assumption §18 warns against.
      bearer: "SELF",
      basis: `Manually entered ${formatINR(manualCharge)}`,
      ruleId: null,
      ruleName: "Manual charge",
    };
  }

  return { amount: 0, bearer: "SELF", basis: "", ruleId: null, ruleName: "" };
}

/** The breakdown shown live in a form before anything is committed. */
export async function previewCharge(chargeRuleId: string, amount: number): Promise<ChargeBreakdown> {
  const rule = await ChargeRule.findById(chargeRuleId);
  if (!rule) throw new NotFoundError("Charge rule", chargeRuleId);

  const computed = computeCharge(rule, amount);
  return {
    gross: amount,
    charge: computed.amount,
    net: amount - computed.amount,
    bearer: computed.bearer,
    ruleName: computed.ruleName,
    basis: computed.basis,
  };
}
