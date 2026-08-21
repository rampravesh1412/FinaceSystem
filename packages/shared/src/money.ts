/**
 * Money.
 *
 * THE ONE RULE: money is an integer number of paise. Never a float, never a string that
 * gets `parseFloat`ed, never a `Decimal128` that gets `.toString()`ed into arithmetic.
 *
 *   ₹1.00        ->  100 paise
 *   ₹1,25,101.00 ->  12_510_100 paise
 *
 * Why integers and not Decimal128: `0.1 + 0.2 !== 0.3` is the obvious reason, but the
 * real one is that Decimal128 round-trips through BSON as an opaque object, so every
 * arithmetic op in Node becomes parse -> compute -> re-serialise. Integer paise are
 * exact, `$sum` in an aggregation pipeline stays exact, and the numbers are directly
 * readable in the shell when auditing.
 *
 * Headroom: Number.MAX_SAFE_INTEGER paise is ₹90,071,992,547,409.91 (~₹90 trillion).
 * Every entry point asserts the value is inside that range rather than letting a silent
 * precision loss into the ledger.
 */

/**
 * A branded integer count of paise.
 *
 * The brand is compile-time only — it erases to `number`, so a `Paise` can be handed
 * straight to Mongoose or JSON. What it buys is that a raw `number` (which might be
 * rupees, might be a percentage, might be a typo) cannot be passed where an amount is
 * expected without going through `asPaise` / `parseAmount`, both of which validate.
 */
export type Paise = number & { readonly __brand: unique symbol };

export const PAISE_PER_RUPEE = 100;

/** Largest amount representable without precision loss: ₹90,071,992,547,409.91 */
export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Assert that a raw number is a valid paise amount and brand it.
 * Use at every boundary where untyped data enters: Mongo reads, JSON bodies, imports.
 */
export function asPaise(value: number): Paise {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError(`Amount must be a finite number, received ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Amount must be a whole number of paise, received ${value}. ` +
        `Fractional paise cannot be represented — round explicitly at the point of calculation.`,
    );
  }
  if (Math.abs(value) > MAX_PAISE) {
    throw new MoneyError(`Amount ${value} exceeds the safe integer range for money.`);
  }
  return value as Paise;
}

/** Zero, as a properly branded amount. */
export const ZERO = 0 as Paise;

/**
 * Convert a rupee figure to paise.
 *
 * Only accepts values with at most 2 decimal places. `12.345` throws rather than
 * silently becoming ₹12.35 — if a caller genuinely wants rounding they must do it
 * deliberately and record why.
 */
export function rupeesToPaise(rupees: number): Paise {
  if (typeof rupees !== "number" || !Number.isFinite(rupees)) {
    throw new MoneyError(`Rupee amount must be a finite number, received ${String(rupees)}`);
  }
  // Scale then round to kill binary float representation error (e.g. 1.1 * 100 = 110.00000000000001).
  const scaled = Math.round(rupees * PAISE_PER_RUPEE);
  if (Math.abs(scaled - rupees * PAISE_PER_RUPEE) > 1e-6) {
    throw new MoneyError(
      `Rupee amount ${rupees} has more precision than paise can represent (max 2 decimal places).`,
    );
  }
  return asPaise(scaled);
}

/**
 * Parse user / import input into paise.
 *
 * Handles: "1,25,101.00", "₹1,25,101", "1234.5", "-500", " 1 000.25 ", 1234.5, "1.25e3".
 * Rejects: "", "abc", "12.345", "1,2,3.456", NaN.
 */
export function parseAmount(input: string | number | null | undefined): Paise {
  if (input === null || input === undefined || input === "") {
    throw new MoneyError("Amount is required.");
  }
  if (typeof input === "number") return rupeesToPaise(input);

  const cleaned = input
    .replace(/[₹\s,_]/g, "")
    .replace(/^\+/, "")
    .trim();

  if (cleaned === "" || cleaned === "-") throw new MoneyError("Amount is required.");
  if (!/^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(cleaned)) {
    throw new MoneyError(`"${input}" is not a valid amount.`);
  }

  // Plain decimal: split on the point so we never touch float arithmetic at all.
  const plain = /^-?\d*\.?\d+$/.test(cleaned);
  if (plain) {
    const negative = cleaned.startsWith("-");
    const [whole = "0", frac = ""] = cleaned.replace(/^-/, "").split(".");
    if (frac.length > 2) {
      throw new MoneyError(
        `"${input}" has more than 2 decimal places. Amounts are exact to the paisa.`,
      );
    }
    const paise = Number(whole) * PAISE_PER_RUPEE + Number(frac.padEnd(2, "0") || "0");
    return asPaise(negative ? -paise : paise);
  }

  // Scientific notation — rare, but shows up in Excel imports.
  return rupeesToPaise(Number(cleaned));
}

/** For charts and CSV numeric columns only. Never feed the result back into arithmetic. */
export function paiseToRupees(paise: Paise | number): number {
  return paise / PAISE_PER_RUPEE;
}

/* -------------------------------------------------------------------------- */
/* Arithmetic                                                                 */
/* -------------------------------------------------------------------------- */

export function add(...amounts: Array<Paise | number>): Paise {
  return asPaise(amounts.reduce<number>((acc, n) => acc + n, 0));
}

export function sub(a: Paise | number, b: Paise | number): Paise {
  return asPaise(a - b);
}

export function neg(a: Paise | number): Paise {
  return asPaise(-a);
}

export function abs(a: Paise | number): Paise {
  return asPaise(Math.abs(a));
}

export function sum(amounts: Array<Paise | number>): Paise {
  return add(...amounts);
}

/** Multiply by a whole-number quantity (line items: qty x unit price). */
export function multiply(amount: Paise | number, quantity: number): Paise {
  if (!Number.isInteger(quantity)) {
    throw new MoneyError(
      `Quantity must be a whole number, received ${quantity}. ` +
        `For fractional quantities compute the line total explicitly and pass it as an amount.`,
    );
  }
  return asPaise(amount * quantity);
}

export const isZero = (a: Paise | number): boolean => a === 0;
export const isPositive = (a: Paise | number): boolean => a > 0;
export const isNegative = (a: Paise | number): boolean => a < 0;

/** -1 | 0 | 1 — for sorting and threshold comparisons. */
export function compare(a: Paise | number, b: Paise | number): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const min = (...a: Array<Paise | number>): Paise => asPaise(Math.min(...a));
export const max = (...a: Array<Paise | number>): Paise => asPaise(Math.max(...a));

/* -------------------------------------------------------------------------- */
/* Rates and charges                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Basis points. 1 bp = 0.01%, so 1.75% = 175 bps.
 *
 * Charge rates are stored as integer bps rather than a float percent for the same reason
 * amounts are stored as paise: `1.75` is not exactly representable, and a distributor
 * commission that drifts by a paisa per transaction is a reconciliation nightmare.
 */
export type BasisPoints = number & { readonly __bpsBrand: unique symbol };

export const BPS_PER_PERCENT = 100;
export const BPS_DENOMINATOR = 10_000;

export function asBps(value: number): BasisPoints {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`Basis points must be a whole number, received ${value}.`);
  }
  return value as BasisPoints;
}

/** 1.75 -> 175 bps. Accepts at most 2 decimal places of percent. */
export function percentToBps(percent: number): BasisPoints {
  const bps = Math.round(percent * BPS_PER_PERCENT);
  if (Math.abs(bps - percent * BPS_PER_PERCENT) > 1e-6) {
    throw new MoneyError(
      `Percentage ${percent} is finer than 0.01% and cannot be stored exactly as basis points.`,
    );
  }
  return asBps(bps);
}

export function bpsToPercent(bps: BasisPoints | number): number {
  return bps / BPS_PER_PERCENT;
}

export type Rounding = "half-up" | "floor" | "ceil";

/**
 * Apply a basis-point rate to an amount.
 *
 *   applyRate(10_000_00, 175)  ->  17_500   (₹1,00,000 @ 1.75% = ₹1,750.00)
 *
 * The multiply is done in BigInt: `amount * bps` overflows Number.MAX_SAFE_INTEGER for
 * large amounts (₹1 crore in paise x 10000 bps is already 1e14, and it climbs fast), and
 * an overflow here would silently produce a wrong charge.
 */
export function applyRate(
  amount: Paise | number,
  bps: BasisPoints | number,
  rounding: Rounding = "half-up",
): Paise {
  const negative = amount < 0;
  const product = BigInt(Math.abs(amount)) * BigInt(bps);
  const denom = BigInt(BPS_DENOMINATOR);

  let quotient = product / denom;
  const remainder = product % denom;

  if (remainder !== 0n) {
    if (rounding === "ceil") quotient += 1n;
    else if (rounding === "half-up" && remainder * 2n >= denom) quotient += 1n;
    // "floor" keeps the truncated quotient as-is.
  }

  const result = Number(quotient);
  if (result > MAX_PAISE) throw new MoneyError("Computed charge exceeds the safe money range.");
  return asPaise(negative ? -result : result);
}

/**
 * Split an amount across weighted buckets without losing or inventing a paisa.
 *
 * Uses the largest-remainder method: floor every share, then hand the leftover paise out
 * one at a time to the buckets with the biggest fractional part. `sum(allocate(x, w))`
 * is always exactly `x`.
 *
 *   allocate(1000, [1, 1, 1]) -> [334, 333, 333]
 */
export function allocate(amount: Paise | number, weights: number[]): Paise[] {
  if (weights.length === 0) throw new MoneyError("Cannot allocate across zero buckets.");
  if (weights.some((w) => w < 0)) throw new MoneyError("Allocation weights cannot be negative.");

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) throw new MoneyError("Allocation weights must not sum to zero.");

  const negative = amount < 0;
  const target = Math.abs(amount);

  const shares = weights.map((w) => {
    const exact = (target * w) / totalWeight;
    const floored = Math.floor(exact);
    return { floored, remainder: exact - floored };
  });

  let distributed = shares.reduce((acc, s) => acc + s.floored, 0);
  const order = shares
    .map((s, i) => ({ i, remainder: s.remainder }))
    .sort((a, b) => b.remainder - a.remainder);

  let cursor = 0;
  while (distributed < target) {
    const slot = order[cursor % order.length]!;
    shares[slot.i]!.floored += 1;
    distributed += 1;
    cursor += 1;
  }

  return shares.map((s) => asPaise(negative ? -s.floored : s.floored));
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

export interface FormatOptions {
  /** Include the ₹ symbol. Default true. */
  symbol?: boolean;
  /** Show paise. Default true — accounting output should not hide the decimals. */
  decimals?: boolean;
  /** Always show a leading + or -. Default false. */
  signed?: boolean;
  /** Render negatives as (1,234.00) instead of -1,234.00, the accounting convention. */
  parens?: boolean;
}

/**
 * Format paise using the Indian 2-2-3 digit grouping.
 *
 *   formatINR(12_510_100)  ->  "₹1,25,101.00"
 *   formatINR(-95_000_000, { parens: true })  ->  "₹(9,50,000.00)"
 *
 * Implemented by hand rather than via Intl.NumberFormat("en-IN") because Intl's grouping
 * for the en-IN locale has historically differed across Node and browser ICU builds, and
 * a financial statement cannot render differently depending on where it was generated.
 */
export function formatINR(paise: Paise | number, options: FormatOptions = {}): string {
  const { symbol = true, decimals = true, signed = false, parens = false } = options;

  const negative = paise < 0;
  const value = Math.abs(Math.trunc(paise));

  const whole = Math.floor(value / PAISE_PER_RUPEE);
  const frac = value % PAISE_PER_RUPEE;

  const digits = String(whole);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }

  let out = grouped;
  if (decimals) out += "." + String(frac).padStart(2, "0");
  if (symbol) out = "₹" + out;

  if (negative) return parens ? `(${out})` : `-${out}`;
  return signed ? `+${out}` : out;
}

/**
 * Compact Indian notation for dashboard tiles where the exact paisa is noise.
 *
 *   formatCompactINR(95_000_000)     ->  "₹9.50 L"
 *   formatCompactINR(12_50_00_000_0) ->  "₹1.25 Cr"
 *
 * Always pair this with the exact value in a tooltip — a compacted figure must never be
 * the only representation of a number someone might act on.
 */
export function formatCompactINR(paise: Paise | number): string {
  const negative = paise < 0;
  const rupees = Math.abs(paise) / PAISE_PER_RUPEE;

  let out: string;
  if (rupees >= 1_00_00_000) out = `₹${(rupees / 1_00_00_000).toFixed(2)} Cr`;
  else if (rupees >= 1_00_000) out = `₹${(rupees / 1_00_000).toFixed(2)} L`;
  else if (rupees >= 1_000) out = `₹${(rupees / 1_000).toFixed(2)} K`;
  else out = formatINR(paise as Paise, { decimals: rupees % 1 !== 0 });

  return negative ? `-${out}` : out;
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitsToWords(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  const o = ONES[n % 10]!;
  return o ? `${t} ${o}` : t;
}

/**
 * Amount in words, Indian numbering. Required on printed vouchers and PDF reports.
 *
 *   amountInWords(12_510_100) -> "Rupees One Lakh Twenty Five Thousand One Hundred One Only"
 */
export function amountInWords(paise: Paise | number): string {
  const negative = paise < 0;
  const value = Math.abs(Math.trunc(paise));
  const whole = Math.floor(value / PAISE_PER_RUPEE);
  const frac = value % PAISE_PER_RUPEE;

  const parts: string[] = [];
  const units: Array<[number, string]> = [
    [1_00_00_000, "Crore"],
    [1_00_000, "Lakh"],
    [1_000, "Thousand"],
    [100, "Hundred"],
  ];

  let remaining = whole;
  for (const [divisor, label] of units) {
    const count = Math.floor(remaining / divisor);
    if (count > 0) {
      // Crores can exceed 99, so recurse for that segment only.
      const segment = divisor === 1_00_00_000 && count > 99 ? amountSegment(count) : twoDigitsToWords(count);
      parts.push(`${segment} ${label}`);
      remaining %= divisor;
    }
  }
  if (remaining > 0) parts.push(twoDigitsToWords(remaining));
  if (parts.length === 0) parts.push("Zero");

  let out = `Rupees ${parts.join(" ")}`;
  if (frac > 0) out += ` and ${twoDigitsToWords(frac)} Paise`;
  out += " Only";

  return negative ? `Minus ${out}` : out;
}

function amountSegment(n: number): string {
  const parts: string[] = [];
  let remaining = n;
  const thousand = Math.floor(remaining / 1000);
  if (thousand) {
    parts.push(`${twoDigitsToWords(thousand)} Thousand`);
    remaining %= 1000;
  }
  const hundred = Math.floor(remaining / 100);
  if (hundred) {
    parts.push(`${ONES[hundred]!} Hundred`);
    remaining %= 100;
  }
  if (remaining) parts.push(twoDigitsToWords(remaining));
  return parts.join(" ");
}
