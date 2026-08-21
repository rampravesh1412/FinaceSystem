import { z } from "zod";
import {
  createPartySchema, parseAmount,
  type ImportPreview, type ImportResult, type ImportRowIssue,
} from "@amiri/shared";
import { Branch, Party } from "../../models/index.js";
import { BadRequestError } from "../../lib/errors.js";
import * as parties from "../parties/party.service.js";
import * as audit from "../../services/audit.service.js";

/**
 * Import (§52).
 *
 * THE RULE: never insert an invalid row.
 *
 * Every import is two phases. `preview` validates every row and reports what would happen,
 * inserting nothing. `commit` re-validates and writes only the rows that pass. A partially
 * imported file that left half a party master behind is worse than a rejected one — the
 * operator cannot tell what landed without checking every record by hand.
 *
 * Duplicates are DETECTED, not skipped silently and not overwritten. The operator decides:
 * a repeated party code might be a genuine re-import or a data-entry slip, and only they
 * know which.
 */

/**
 * The preview and result shapes live in `@amiri/shared` because the import wizard renders
 * them field by field. Declaring them twice is how the screen ends up quietly dropping a
 * count the server started sending.
 */
export type { ImportPreview, ImportResult, ImportRowIssue } from "@amiri/shared";

/* -------------------------------------------------------------------------- */
/* Row schemas                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The party import row.
 *
 * Deliberately lenient about SHAPE and strict about VALUES: a spreadsheet exported from
 * anywhere will have stray whitespace and inconsistent casing in its headers, but an
 * amount that will not parse to exact paise is rejected outright.
 */
const partyRowSchema = z.object({
  name: z.string().trim().min(2, "Party name is required").max(140),
  code: z.string().trim().max(24).optional(),
  type: z
    .string()
    .trim()
    .toUpperCase()
    .optional()
    .transform((v) => (v && ["CUSTOMER", "VENDOR", "DISTRIBUTOR", "AGENT", "EMPLOYEE", "OTHER"].includes(v) ? v : "CUSTOMER")),
  mobile: z.string().trim().optional(),
  email: z.string().trim().optional(),
  city: z.string().trim().max(80).optional(),
  gstin: z.string().trim().optional(),
  openingBalance: z.union([z.string(), z.number()]).optional(),
  creditLimit: z.union([z.string(), z.number()]).optional(),
  creditDays: z.union([z.string(), z.number()]).optional(),
});

/** Normalise a header: "Party Name" / "party_name" / "PARTY NAME" all become "partyname". */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

const PARTY_HEADER_MAP: Record<string, string> = {
  name: "name", partyname: "name", party: "name",
  code: "code", partycode: "code",
  type: "type", partytype: "type",
  mobile: "mobile", phone: "mobile", mobileno: "mobile", contact: "mobile",
  email: "email",
  city: "city",
  gstin: "gstin", gst: "gstin",
  openingbalance: "openingBalance", opening: "openingBalance", balance: "openingBalance",
  creditlimit: "creditLimit", limit: "creditLimit",
  creditdays: "creditDays", days: "creditDays", terms: "creditDays",
};

function mapRow(raw: Record<string, unknown>, headerMap: Record<string, string>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = headerMap[normaliseKey(key)];
    if (target && value !== null && value !== undefined && String(value).trim() !== "") {
      mapped[target] = value;
    }
  }
  return mapped;
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

export async function previewParties(
  rows: Array<Record<string, unknown>>,
  branchId: string,
): Promise<ImportPreview> {
  const branch = await Branch.findById(branchId).select("code status").lean();
  if (!branch) throw new BadRequestError("That branch does not exist", "branchId");

  const issues: ImportRowIssue[] = [];
  const sample: Array<Record<string, unknown>> = [];

  // Existing codes and names, so a duplicate is reported rather than discovered on insert.
  const existing = await Party.find({ branchId }).select("code name").lean();
  const existingCodes = new Set(existing.map((p) => p.code.toUpperCase()));
  const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));

  // Duplicates WITHIN the file matter too — the same party twice in one sheet.
  const seenCodes = new Set<string>();
  const seenNames = new Set<string>();

  let valid = 0;
  let duplicates = 0;

  rows.forEach((raw, index) => {
    const rowNumber = index + 2; // +1 for zero-index, +1 for the header row
    const mapped = mapRow(raw, PARTY_HEADER_MAP);

    const parsed = partyRowSchema.safeParse(mapped);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          row: rowNumber,
          field: issue.path.join("."),
          message: issue.message,
          severity: "error",
        });
      }
      return;
    }

    const row = parsed.data;

    // Amounts are checked here so a bad figure is a row-level error the operator can fix,
    // not an exception halfway through the commit.
    let openingBalance = 0;
    let creditLimit = 0;
    try {
      if (row.openingBalance !== undefined) openingBalance = parseAmount(row.openingBalance as string);
      if (row.creditLimit !== undefined) creditLimit = parseAmount(row.creditLimit as string);
    } catch (err) {
      issues.push({
        row: rowNumber,
        field: "openingBalance",
        message: err instanceof Error ? err.message : "Amount could not be read",
        severity: "error",
      });
      return;
    }

    const code = row.code?.toUpperCase();
    const nameKey = row.name.toLowerCase();

    if (code && (existingCodes.has(code) || seenCodes.has(code))) {
      duplicates += 1;
      issues.push({
        row: rowNumber,
        field: "code",
        message: `Party code ${code} already exists — this row will be skipped`,
        severity: "warning",
      });
      return;
    }

    if (existingNames.has(nameKey) || seenNames.has(nameKey)) {
      duplicates += 1;
      issues.push({
        row: rowNumber,
        field: "name",
        // A warning, not an error: two genuinely different firms can share a name, so
        // the operator decides rather than the importer.
        message: `A party named "${row.name}" already exists in this branch — this row will be skipped`,
        severity: "warning",
      });
      return;
    }

    if (code) seenCodes.add(code);
    seenNames.add(nameKey);
    valid += 1;

    if (sample.length < 10) {
      sample.push({
        row: rowNumber,
        name: row.name,
        code: code ?? "(auto)",
        type: row.type,
        mobile: row.mobile ?? "",
        openingBalance,
        creditLimit,
      });
    }
  });

  return {
    kind: "PARTIES",
    totalRows: rows.length,
    valid,
    invalid: rows.length - valid - duplicates,
    duplicates,
    issues: issues.slice(0, 200),
    sample,
  };
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Import the valid rows.
 *
 * Each party is created through the REAL service, so it gets its ledger account and its
 * opening balance posted as a genuine double-entry transaction. Bulk-inserting party
 * documents directly would be far faster and would leave every one of them without a
 * ledger account — unusable, and the books would not balance.
 *
 * Rows are committed individually rather than in one transaction: an import of 500 parties
 * in a single Mongo transaction would exceed the 16MB oplog limit and time out. A row that
 * fails is reported and the rest proceed, which is why the preview matters — by commit
 * time the operator has already seen what will land.
 */
export async function commitParties(
  rows: Array<Record<string, unknown>>,
  branchId: string,
  ctx: audit.AuditContext,
): Promise<ImportResult> {
  const preview = await previewParties(rows, branchId);

  const existing = await Party.find({ branchId }).select("code name").lean();
  const existingCodes = new Set(existing.map((p) => p.code.toUpperCase()));
  const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));

  const issues: ImportRowIssue[] = [...preview.issues];
  let imported = 0;

  for (const [index, raw] of rows.entries()) {
    const rowNumber = index + 2;
    const parsed = partyRowSchema.safeParse(mapRow(raw, PARTY_HEADER_MAP));
    if (!parsed.success) continue;

    const row = parsed.data;
    const code = row.code?.toUpperCase();
    if (code && existingCodes.has(code)) continue;
    if (existingNames.has(row.name.toLowerCase())) continue;

    try {
      const input = createPartySchema.parse({
        name: row.name,
        code,
        type: row.type,
        branchId,
        mobile: row.mobile,
        email: row.email,
        city: row.city,
        gstin: row.gstin,
        openingBalance: row.openingBalance ?? 0,
        creditLimit: row.creditLimit ?? 0,
        creditDays: row.creditDays ? Number(row.creditDays) : 0,
        status: "ACTIVE",
      });

      await parties.createParty(input, ctx);
      imported += 1;
      if (code) existingCodes.add(code);
      existingNames.add(row.name.toLowerCase());
    } catch (err) {
      issues.push({
        row: rowNumber,
        message: err instanceof Error ? err.message : "Could not create this party",
        severity: "error",
      });
    }
  }

  await audit.recordSafe(ctx, {
    action: "IMPORT",
    entity: "Party",
    entityLabel: `${imported} of ${rows.length} rows`,
    newValue: {
      totalRows: rows.length,
      imported,
      duplicates: preview.duplicates,
      invalid: preview.invalid,
    },
  });

  return {
    ...preview,
    issues: issues.slice(0, 200),
    imported,
    skipped: rows.length - imported,
  };
}

/** A blank template with the headers the importer understands. */
export function partyTemplate(): Array<Record<string, string>> {
  return [
    {
      Name: "Sharma Traders",
      Code: "",
      Type: "CUSTOMER",
      Mobile: "9812345670",
      Email: "",
      City: "Patna",
      GSTIN: "",
      "Opening Balance": "1,25,101.00",
      "Credit Limit": "2,00,000.00",
      "Credit Days": "30",
    },
  ];
}
