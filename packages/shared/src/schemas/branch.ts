import { z } from "zod";
import { RECORD_STATUS } from "../enums.js";
import {
  listQuery,
  money,
  note,
  objectId,
  optionalEmail,
  optionalIndianMobile,
} from "./common.js";

/**
 * Branch master.
 *
 * `code` is the human handle used everywhere in the AMIRI workbook (101, 102, 105 …) and
 * on every printed report, so it is unique, immutable after creation, and indexed.
 */
export const branchCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, "Branch code must be at least 2 characters")
  .max(12, "Branch code must be at most 12 characters")
  .regex(/^[A-Z0-9-]+$/, "Use letters, digits and hyphens only");

export const createBranchSchema = z.object({
  name: z.string().trim().min(2, "Branch name is required").max(120),
  code: branchCode,
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z
    .union([z.string().trim().regex(/^\d{6}$/, "PIN code must be 6 digits"), z.literal("")])
    .optional()
    .transform((v) => (v ? v : undefined)),
  phone: optionalIndianMobile,
  email: optionalEmail,
  managerId: objectId.optional(),

  /**
   * Opening balances.
   *
   * These are NOT written to a `balance` field. On create they are posted as a dated
   * OPENING_BALANCE transaction against the EQUITY account, so day-zero figures are
   * double-entry and auditable like everything else (§25, §62).
   */
  openingCash: money.default(0),
  openingBankBalance: money.default(0),
  openingDate: z.coerce.date().optional(),

  status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
  notes: note(),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

/**
 * Update omits `code` and the opening balances on purpose.
 *
 * Changing a branch code would orphan every printed report that quotes it, and an
 * opening balance is a posted transaction — it is corrected with an Adjustment, never by
 * editing a field. This is the §62 principle expressed in the type system.
 */
export const updateBranchSchema = createBranchSchema
  .omit({ code: true, openingCash: true, openingBankBalance: true, openingDate: true })
  .partial();
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

export const branchQuerySchema = listQuery.extend({
  status: z.nativeEnum(RECORD_STATUS).optional(),
});
export type BranchQuery = z.infer<typeof branchQuerySchema>;

export interface BranchSummary {
  id: string;
  name: string;
  code: string;
  city?: string;
  state?: string;
  status: string;
  manager?: { id: string; name: string };
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

/** What the branch dashboard header renders. Every figure is derived from the ledger. */
export interface BranchBalances {
  cashBalance: number;
  bankBalance: number;
  totalBalance: number;
  receivable: number;
  payable: number;
  todayIn: number;
  todayOut: number;
  todayExpense: number;
  todayProfit: number;
  pendingApprovals: number;
  unreconciledCount: number;
}
