import { z } from "zod";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../api.js";
import { parseAmount, MAX_PAISE } from "../money.js";

/**
 * Shared Zod primitives.
 *
 * These schemas are used twice: as Express request validation and as the resolver for
 * React Hook Form. One definition means a field cannot be validated leniently on the
 * client and strictly on the server, or vice versa.
 */

export const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Must be a valid id");

/** Optional ObjectId that treats "" and "all" (the UI's filter sentinel) as absent. */
export const optionalObjectId = z
  .union([objectId, z.literal(""), z.literal("all")])
  .optional()
  .transform((v) => (v === "" || v === "all" ? undefined : v));

/**
 * A money field on the wire.
 *
 * Accepts either an integer number of paise (what the API itself emits) or a human
 * string like "1,25,101.00" (what a form or an Excel import produces), and always
 * resolves to integer paise. This is the ONLY sanctioned way an amount enters the system.
 */
export const money = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      // A plain integer is already paise; anything else is a rupee figure to parse.
      if (typeof value === "number" && Number.isInteger(value)) return value;
      return parseAmount(value) as number;
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : "Invalid amount",
      });
      return z.NEVER;
    }
  })
  .refine((v) => Math.abs(v) <= MAX_PAISE, "Amount is out of range");

/** A money field that must be strictly greater than zero — the common case for a posting. */
export const positiveMoney = money.refine((v) => v > 0, "Amount must be greater than zero");

/** A money field that may be zero (charges, adjustments that net out). */
export const nonNegativeMoney = money.refine((v) => v >= 0, "Amount cannot be negative");

/** Basis points, 0–10000 (0%–100%). */
export const basisPoints = z
  .number()
  .int("Rate must be given in whole basis points")
  .min(0, "Rate cannot be negative")
  .max(10_000, "Rate cannot exceed 100%");

/**
 * A calendar date.
 *
 * Accepts `YYYY-MM-DD` or an ISO datetime and normalises to a Date. Financial dates are
 * business dates, not instants — a payment recorded at 11pm on the 19th belongs to the
 * 19th's DayBook regardless of the server's timezone, so the API stores the date at UTC
 * midnight and the tz offset is never allowed to shift it across a boundary.
 */
export const businessDate = z
  .union([z.string(), z.date()])
  .transform((value, ctx) => {
    if (value instanceof Date) {
      return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    }
    const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!ymd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a date as YYYY-MM-DD" });
      return z.NEVER;
    }
    const [, y, m, d] = ymd;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a real date" });
      return z.NEVER;
    }
    return date;
  });

export const indianMobile = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, "Enter a 10-digit Indian mobile number");

export const optionalIndianMobile = z
  .union([indianMobile, z.literal("")])
  .optional()
  .transform((v) => (v ? v : undefined));

export const email = z.string().trim().toLowerCase().email("Enter a valid email address");

export const optionalEmail = z
  .union([email, z.literal("")])
  .optional()
  .transform((v) => (v ? v : undefined));

export const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/,
    "Enter a valid 15-character GSTIN",
  );

export const optionalGstin = z
  .union([gstin, z.literal("")])
  .optional()
  .transform((v) => (v ? v : undefined));

export const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid 10-character PAN");

export const optionalPan = z
  .union([pan, z.literal("")])
  .optional()
  .transform((v) => (v ? v : undefined));

export const ifsc = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z\d]{6}$/, "Enter a valid 11-character IFSC");

export const accountNumber = z
  .string()
  .trim()
  .regex(/^\d{6,20}$/, "Account number must be 6–20 digits");

/** Free-text note. Trimmed, capped, and empty-string-to-undefined so blanks aren't stored. */
export const note = (max = 500) =>
  z
    .string()
    .trim()
    .max(max, `Cannot exceed ${max} characters`)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * A reason string. Required for every dangerous action — reversal, adjustment, period
 * close, balance correction — and written verbatim into the audit log.
 */
export const reason = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters — this is recorded in the audit log")
  .max(1000);

/**
 * A boolean that arrives as a query-string value.
 *
 * `z.coerce.boolean()` is JS truthiness: the STRING `"false"` is truthy, so
 * `?includeInactive=false` parses as `true`. Every boolean flag in this application was
 * wrong in the same direction — a switch turned off sent `false` and the server read it as
 * on. Nothing failed loudly; the filter simply did not filter.
 *
 * This reads the words a query string actually carries. Absent stays absent, so `.optional()`
 * and `.default()` behave as written.
 */
export const booleanFlag = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(v)) return false;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  return value;
}, z.boolean());

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: z.string().trim().max(50).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  q: z.string().trim().max(200).optional(),
});

export type ListQueryInput = z.input<typeof listQuery>;
export type ListQueryParsed = z.output<typeof listQuery>;

/** A from/to window. Rejects an inverted range at the schema level, not in a controller. */
export const dateRange = z
  .object({
    from: businessDate.optional(),
    to: businessDate.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "The start date must not be after the end date",
    path: ["from"],
  });

export const attachmentInput = z.object({
  filename: z.string().trim().min(1).max(255),
  url: z.string().trim().url(),
  mimeType: z.string().trim().min(1).max(120),
  size: z.number().int().min(0).max(25 * 1024 * 1024, "Attachments are limited to 25 MB"),
});

export type AttachmentInput = z.infer<typeof attachmentInput>;
