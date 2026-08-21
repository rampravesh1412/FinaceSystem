import {
  DEFAULT_FISCAL_START_MONTH,
  type OrganisationProfile,
  type OrganisationSettings,
} from "@amiri/shared";
import { LedgerEntry, SystemSetting, User } from "../../models/index.js";
import { SETTING_KEYS } from "../../models/SystemSetting.js";
import { BadRequestError } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import * as audit from "../../services/audit.service.js";
import { invalidateOrganisationName } from "../../services/export.service.js";

/**
 * Organisation settings (§35).
 *
 * Stored as one row in the key/value `SystemSetting` collection rather than a dedicated
 * schema, because these are exactly the values that change without a deploy.
 *
 * The interesting rule here is `fiscalStartMonth`. It is not a preference — it decides
 * which fiscal year every transaction belongs to, and therefore its voucher number, which
 * period locks it, and which year-to-date column it lands in. Changing it once entries
 * exist would silently reassign posted history to different years: vouchers would collide,
 * a closed period would stop covering the transactions it closed over, and last year's
 * P&L would quietly change. So it is editable exactly until the first ledger entry, and
 * refused with an explanation after that.
 */

/**
 * What an installation looks like before anybody opens Settings.
 *
 * The name falls back to `ORG_NAME` rather than to a literal, so a deployment that never
 * touches this screen behaves exactly as it did before the screen existed — the exports
 * keep printing the configured environment name. Inventing a different default here would
 * silently rename every report the first time the code shipped.
 */
const DEFAULT_PROFILE: OrganisationProfile = {
  legalName: env.ORG_NAME,
  fiscalStartMonth: env.FISCAL_YEAR_START_MONTH || DEFAULT_FISCAL_START_MONTH,
};

export async function getProfile(): Promise<OrganisationProfile> {
  const row = await SystemSetting.findOne({ key: SETTING_KEYS.ORGANISATION }).lean();
  return { ...DEFAULT_PROFILE, ...((row?.value as Partial<OrganisationProfile>) ?? {}) };
}

/** Whether the books have anything in them yet. */
async function hasPostedEntries(): Promise<boolean> {
  return (await LedgerEntry.estimatedDocumentCount()) > 0;
}

export async function getSettings(): Promise<OrganisationSettings> {
  const [row, profile, posted] = await Promise.all([
    SystemSetting.findOne({ key: SETTING_KEYS.ORGANISATION })
      .populate<{ updatedBy: { name: string } | null }>("updatedBy", "name")
      .lean(),
    getProfile(),
    hasPostedEntries(),
  ]);

  return {
    profile,
    fiscalStartMonthEditable: !posted,
    fiscalLockReason: posted
      ? "Transactions have been posted. The fiscal year decides each one's voucher number and " +
        "which period locks it, so changing it now would reassign posted history to different years."
      : undefined,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedBy?.name ?? null,
  };
}

export async function saveProfile(
  input: OrganisationProfile,
  ctx: audit.AuditContext,
): Promise<OrganisationSettings> {
  const previous = await getProfile();

  if (input.fiscalStartMonth !== previous.fiscalStartMonth && (await hasPostedEntries())) {
    throw new BadRequestError(
      "The fiscal year cannot be changed once transactions have been posted — it decides " +
        "each transaction's voucher number and which period locks it.",
      "fiscalStartMonth",
    );
  }

  // Empty strings arrive from cleared optional inputs. Storing "" would make "has a GSTIN"
  // true for a record that has none, and the exports print whatever is stored.
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw !== undefined && raw !== "") value[key] = raw;
  }

  await SystemSetting.findOneAndUpdate(
    { key: SETTING_KEYS.ORGANISATION },
    { $set: { value, description: "Organisation profile (§35)", updatedBy: ctx.userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // So the very next export prints the new name rather than waiting out the cache.
  invalidateOrganisationName();

  await audit.record(ctx, {
    action: "SETTINGS_UPDATED",
    entity: "SystemSetting",
    entityId: SETTING_KEYS.ORGANISATION,
    entityLabel: "Organisation profile",
    oldValue: previous,
    newValue: value,
  });

  return getSettings();
}

/**
 * A read-only snapshot for the settings screen.
 *
 * Deliberately counts rather than computes: this panel answers "what is in the system",
 * not "do the books balance". The trial balance answers the second question, from entries,
 * and duplicating that here would give an operator two places to look and a chance for
 * them to disagree.
 */
export async function getSystemSummary(): Promise<{
  users: number;
  activeUsers: number;
  ledgerEntries: number;
  oldestEntry: string | null;
  newestEntry: string | null;
}> {
  const [users, activeUsers, ledgerEntries, oldest, newest] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ status: "ACTIVE" }),
    LedgerEntry.estimatedDocumentCount(),
    LedgerEntry.findOne().sort({ date: 1 }).select("date").lean(),
    LedgerEntry.findOne().sort({ date: -1 }).select("date").lean(),
  ]);

  return {
    users,
    activeUsers,
    ledgerEntries,
    oldestEntry: oldest?.date ? oldest.date.toISOString() : null,
    newestEntry: newest?.date ? newest.date.toISOString() : null,
  };
}
