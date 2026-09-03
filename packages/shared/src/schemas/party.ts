import { z } from "zod";
import { PARTY_TYPE, RECORD_STATUS, type KhataDirection } from "../enums.js";
import {
  booleanFlag,
  listQuery,
  money,
  note,
  optionalEmail,
  optionalGstin,
  optionalIndianMobile,
  optionalPan,
} from "./common.js";

/**
 * Party master (§10).
 *
 * A party is any external entity money moves to or from — customer, vendor, distributor,
 * agent, employee. They all share one ledger account and one balance, because a business
 * that is both a customer and a vendor should net to a single position rather than
 * appear twice with opposite signs.
 *
 * ORGANISATION-WIDE. A party has no branch. The same customer walks into whichever office
 * is nearest, and their balance is one number across the business — splitting the master
 * per branch would give one firm several part-balances that nobody could net without
 * adding them up by hand. The BRANCH still appears on every posting: each ledger entry
 * carries the branch that transacted, so branch books and branch reports are unaffected.
 */
export const createPartySchema = z.object({
  name: z.string().trim().min(2, "Party name is required").max(140),
  /** Optional: generated as PTY-000123 when left blank. */
  code: z
    .union([
      z
        .string()
        .trim()
        .toUpperCase()
        .min(2)
        .max(24)
        .regex(/^[A-Z0-9-]+$/, "Use letters, digits and hyphens only"),
      z.literal(""),
    ])
    .optional()
    .transform((v) => (v ? v : undefined)),

  type: z.nativeEnum(PARTY_TYPE).default("CUSTOMER"),

  mobile: optionalIndianMobile,
  altMobile: optionalIndianMobile,
  email: optionalEmail,
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z
    .union([z.string().trim().regex(/^\d{6}$/, "PIN code must be 6 digits"), z.literal("")])
    .optional()
    .transform((v) => (v ? v : undefined)),

  gstin: optionalGstin,
  pan: optionalPan,

  /**
   * Opening balance, in the Khata's own sign convention:
   *   POSITIVE — they owe us (LENA HAI)
   *   NEGATIVE — we owe them (DENA HAI)
   *
   * Posted as an OPENING_BALANCE transaction against equity, not stored as a field.
   */
  openingBalance: money.default(0),
  openingDate: z.coerce.date().optional(),

  /**
   * Credit limit as a positive amount, or 0 for no limit.
   * Checked when a payment would push their receivable higher.
   */
  creditLimit: money.default(0).refine((v) => v >= 0, "The credit limit is entered as a positive amount"),
  /** Payment terms in days, used to compute the due date and therefore the aging bucket. */
  creditDays: z.number().int().min(0).max(365).default(0),

  status: z.nativeEnum(RECORD_STATUS).default("ACTIVE"),
  notes: note(1000),
});
export type CreatePartyInput = z.infer<typeof createPartySchema>;

/**
 * The opening balance is omitted.
 *
 * It is a posted transaction, not a field, so it is corrected with an Adjustment (§25)
 * rather than by editing the master — otherwise the party's balance and the entries that
 * are supposed to explain it would disagree.
 */
export const updatePartySchema = createPartySchema
  .omit({ openingBalance: true, openingDate: true })
  .partial();
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;

export const partyQuerySchema = listQuery.extend({
  type: z.nativeEnum(PARTY_TYPE).optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
  /** Only parties who owe us, or only those we owe. Drives the receivable/payable views. */
  balance: z.enum(["all", "lena", "dena", "clear"]).default("all"),
  /** Only parties past their credit limit. */
  overLimit: booleanFlag.optional(),
});
export type PartyQuery = z.infer<typeof partyQuerySchema>;

export interface PartySummary {
  id: string;
  name: string;
  code: string;
  type: string;
  mobile?: string;
  email?: string;
  city?: string;
  gstin?: string;

  /** Signed: positive means they owe us. Derived from ledger entries. */
  balance: number;
  /** LENA / DENA / CLEAR — the Khata reading of the balance. */
  direction: KhataDirection;

  creditLimit: number;
  creditUsed: number;
  availableCredit: number;
  isOverLimit: boolean;

  status: string;
  ledgerAccountId: string;
  createdAt: string;
}

/** The header of a party's profile page (§10). */
export interface PartyProfile extends PartySummary {
  address?: string;
  state?: string;
  pincode?: string;
  pan?: string;
  altMobile?: string;
  creditDays: number;
  notes?: string;

  totalReceivable: number;
  totalPayable: number;
  totalGiven: number;
  totalTaken: number;
  totalPaymentIn: number;
  totalPaymentOut: number;
  lastTransactionAt: string | null;
  transactionCount: number;
}
