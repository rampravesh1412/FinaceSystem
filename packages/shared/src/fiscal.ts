/**
 * Fiscal year arithmetic.
 *
 * India runs April–March, so 19 August 2026 falls in FY 2026-27, and 19 February 2027
 * falls in the *same* fiscal year. Document numbering, period locking and every
 * year-to-date report depend on getting this right — a transaction numbered into the
 * wrong year is a gap in one sequence and a duplicate risk in another.
 *
 * The start month is configurable because the same code should serve a business on a
 * January–December year.
 */

export const DEFAULT_FISCAL_START_MONTH = 4; // April

/**
 * The fiscal year a date belongs to, identified by its STARTING calendar year.
 *
 *   fiscalYearOf(2026-08-19) -> 2026   (FY 2026-27)
 *   fiscalYearOf(2027-02-19) -> 2026   (still FY 2026-27)
 *   fiscalYearOf(2027-04-01) -> 2027   (FY 2027-28)
 */
export function fiscalYearOf(date: Date, startMonth = DEFAULT_FISCAL_START_MONTH): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month >= startMonth ? year : year - 1;
}

/** "2026-27" — the label printed on reports and vouchers. */
export function fiscalYearLabel(
  fiscalYear: number,
  startMonth = DEFAULT_FISCAL_START_MONTH,
): string {
  if (startMonth === 1) return String(fiscalYear);
  return `${fiscalYear}-${String((fiscalYear + 1) % 100).padStart(2, "0")}`;
}

export function fiscalYearRange(
  fiscalYear: number,
  startMonth = DEFAULT_FISCAL_START_MONTH,
): { start: Date; end: Date } {
  const start = new Date(Date.UTC(fiscalYear, startMonth - 1, 1));
  // The instant before the next fiscal year begins, so a `$lte` range is exact.
  const end = new Date(Date.UTC(fiscalYear + 1, startMonth - 1, 1) - 1);
  return { start, end };
}

/** UTC midnight for a date — the canonical form of a business date. */
export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The last millisecond of a business date, for an inclusive range end. */
export function endOfDay(date: Date): Date {
  return new Date(startOfDay(date).getTime() + 86_400_000 - 1);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Whole days between two business dates. Used for credit aging. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000);
}

/**
 * Format a document number: `PAY-IN-2026-000123`.
 *
 * Six digits allows a million documents per prefix per year before the width changes,
 * which keeps a printed column aligned for the life of the business.
 */
export function formatDocumentNumber(prefix: string, fiscalYear: number, sequence: number): string {
  return `${prefix}-${fiscalYear}-${String(sequence).padStart(6, "0")}`;
}
