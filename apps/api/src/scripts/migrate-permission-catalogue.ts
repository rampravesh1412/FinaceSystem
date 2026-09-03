import mongoose from "mongoose";
import { LEGACY_PERMISSION_MAP, expandLegacy, isPermission } from "@amiri/shared";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/db.js";

/**
 * Move every role onto the module.action permission catalogue.
 *
 *   npm run migrate:permission-catalogue                DRY RUN — reports, writes nothing
 *   npm run migrate:permission-catalogue -- --apply     actually do it
 *
 * The permission vocabulary changed from loose capability strings to one key per sidebar
 * entry — `finance.payment.view` became `payment_in.view` and `payment_out.view`, and the
 * five screens that shared `finance.ledger.view` each got their own. This rewrites the
 * `permissions` array on every role document accordingly.
 *
 * NOBODY LOSES ACCESS. The mapping is deliberately generous: a role that held one key
 * which now covers five screens gets all five, because it could open all five yesterday.
 * Splitting a permission must not quietly take something away — tightening is a decision
 * for a person to make on the Roles screen, where it lands in the audit log.
 *
 * Running it is not urgent. `expandLegacy` translates old strings at sign-in, so a
 * database that has not been migrated still authorises correctly; this makes it permanent
 * and gets the old strings off the Roles screen.
 *
 * It is IDEMPOTENT: a role already on the new vocabulary is left untouched.
 */

/** Writes only with `--apply`; anything else is a dry run. */
const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

interface RoleRow {
  _id: mongoose.Types.ObjectId;
  name: string;
  permissions?: string[];
  isSuperAdmin?: boolean;
}

async function run(): Promise<void> {
  // Index builds are skipped: this runs before the app has ever booted against the new
  // shape, and a half-migrated collection is not the moment to be building indexes.
  await connectDatabase({ prepareCollections: false });
  const db = mongoose.connection.db!;

  logger.info(DRY_RUN ? "DRY RUN — nothing will be written" : "APPLYING changes");

  const roles = await db.collection<RoleRow>("roles").find({}).toArray();
  logger.info({ roles: roles.length }, "roles found");

  let changed = 0;
  let unchanged = 0;

  for (const role of roles) {
    const before = role.permissions ?? [];

    /**
     * A wildcard is left exactly as it is.
     *
     * `*` already means "everything in the catalogue, whatever the catalogue currently
     * says". Expanding it into 143 literal strings would freeze that role at today's list —
     * the next module added would not reach it, and nobody would know why.
     */
    if (before.includes("*")) {
      logger.info({ role: role.name }, "holds the wildcard — left as it is");
      unchanged += 1;
      continue;
    }

    /**
     * A super admin holding an EXPLICIT list is given the wildcard.
     *
     * This is the one place the migration deliberately grants something the old strings
     * did not name, and it exists to prevent a LOSS rather than to widen anything. The
     * `isSuperAdmin` flag does not bypass `requirePermission` — only the `*` string does —
     * so a super admin whose role lists permissions one by one gets exactly what its old
     * keys translate to and nothing else. The catalogue is finer-grained than the one it
     * replaces, so that list comes up short: `parties.delete` and `daybook.export` have no
     * old equivalent to be translated FROM, and the person who is supposed to be able to
     * do everything would quietly find they could not.
     *
     * The role service already refuses to reduce this role's permissions for the same
     * reason. The wildcard states the intent that the enumeration was only approximating.
     */
    if (role.isSuperAdmin) {
      logger.warn(
        { role: role.name, was: before.length },
        "super admin role — replacing the explicit list with the wildcard so future modules are covered",
      );
      if (APPLY) {
        await db
          .collection("roles")
          .updateOne({ _id: role._id }, { $set: { permissions: ["*"], updatedAt: new Date() } });
      }
      changed += 1;
      continue;
    }

    const after = expandLegacy(before);

    const legacyHeld = before.filter((p) => !isPermission(p) && p in LEGACY_PERMISSION_MAP);
    const unknown = before.filter((p) => !isPermission(p) && !(p in LEGACY_PERMISSION_MAP) && !p.endsWith(".*"));

    if (legacyHeld.length === 0 && unknown.length === 0) {
      unchanged += 1;
      continue;
    }

    /**
     * A string nobody recognises is DROPPED, and reported.
     *
     * It granted nothing before this migration — no guard named it — so removing it takes
     * away no access. Carrying it forward would leave a permanent puzzle on the Roles
     * screen instead.
     */
    if (unknown.length > 0) {
      logger.warn({ role: role.name, unknown }, "unrecognised permissions — dropping");
    }

    const gained = after.filter((p) => !before.includes(p));

    logger.info(
      {
        role: role.name,
        was: before.length,
        now: after.length,
        translated: legacyHeld.length,
        // Not a widening: these are the new names for what the role could already do.
        sample: gained.slice(0, 6),
      },
      DRY_RUN ? "would rewrite" : "rewriting",
    );

    if (APPLY) {
      await db
        .collection("roles")
        .updateOne({ _id: role._id }, { $set: { permissions: after, updatedAt: new Date() } });
    }
    changed += 1;
  }

  logger.info({ changed, unchanged }, DRY_RUN ? "dry run complete" : "migration complete");

  if (DRY_RUN && changed > 0) {
    logger.info("re-run with `-- --apply` to write these changes");
  }

  /**
   * Sessions are NOT revoked.
   *
   * A live session resolves its permissions from the role on every request and translates
   * legacy strings on the way through, so it keeps working across the rewrite without a
   * gap. Signing the whole desk out to apply a rename nobody asked for would be the more
   * disruptive choice, not the safer one.
   */

  await disconnectDatabase();
}

run().catch((err: unknown) => {
  logger.error({ err }, "migration failed");
  process.exitCode = 1;
});
