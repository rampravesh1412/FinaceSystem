import {
  TRANSACTION_TYPE,
  chargeEffect,
  formatINR,
  settlementNet,
  type ChargeEffect,
} from "@amiri/shared";

/**
 * What a charge rule DOES, in money, in one place.
 *
 * Three screens have to describe the same arrangement: the rule list, the edit dialog, and
 * the charge dropdown on a payment. When each of them phrased it in its own words they
 * drifted, and the drift was not cosmetic — the edit dialog told an operator "₹1,01,500
 * leaves the bank" for a rule that actually moves ₹1,00,000, which is precisely the kind of
 * wrong number that gets acted on. So the wording is computed here, from the same
 * `chargeEffect` and `settlementNet` the ledger posts with, and nothing describes a charge
 * without going through this function.
 *
 * A payment out is the worked example because it is the case with three genuinely different
 * answers on the same rate, ₹3,000 apart end to end.
 */

const ONE_LAKH = 100_000_00;

export type RuleArrangement = {
  effect: ChargeEffect;
  /** Three words for a badge or a dropdown hint. */
  label: string;
  /** What leaves the funding account on a ₹1,00,000 payment out. */
  accountMoves: number;
  /** How much of the party's claim that payment discharges. */
  partyDischarged: number;
  chargeSide: "income" | "expense";
  /** A full sentence with the figures in it, for a tooltip or a preview panel. */
  explain: string;
};

export function arrangementOf(
  rule: { bearer: string; deductFromAmount?: boolean },
  chargeOn100k: number,
  gross: number = ONE_LAKH,
): RuleArrangement {
  // Old summaries predate the flag; the server's default is to take it from the amount.
  const deductFromAmount = rule.deductFromAmount !== false;
  const effect = chargeEffect(TRANSACTION_TYPE.PAYMENT_OUT, rule.bearer, deductFromAmount);

  // On a payment out the net IS what leaves the funding account, under all three
  // arrangements — which is why the ledger and this panel can share one function.
  const accountMoves = settlementNet(gross, chargeOn100k, effect);
  // Only the absorbed arrangement shortchanges the party; the other two discharge in full.
  const partyDischarged = effect === "ABSORBED" ? gross - chargeOn100k : gross;
  const chargeSide = rule.bearer === "PARTY" ? "income" : "expense";

  const label =
    rule.bearer === "PARTY"
      ? "The party"
      : deductFromAmount
        ? "Us · from the amount"
        : "Us · on top";

  const money = `On a ${formatINR(gross)} payment out, ${formatINR(accountMoves)} leaves the account`;

  const explain =
    effect === "DEDUCTED"
      ? `Our income. ${money} and their full ${formatINR(gross)} claim is discharged — the ${formatINR(chargeOn100k)} you keep is the commission.`
      : effect === "ABSORBED"
        ? `Our expense, taken out of the amount. ${money}, only ${formatINR(partyDischarged)} reaches them, and the ${formatINR(chargeOn100k)} is your cost.`
        : `Our expense, levied on top. ${money} and they receive the full ${formatINR(gross)}.`;

  return { effect, label, accountMoves, partyDischarged, chargeSide, explain };
}
