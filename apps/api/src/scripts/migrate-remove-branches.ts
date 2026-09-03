import mongoose from "mongoose";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/db.js";

/**
 * Remove branches from the database.
 *
 *   npm run migrate:remove-branches                DRY RUN — reports, writes nothing
 *   npm run migrate:remove-branches -- --apply     actually do it
 *
 * The application no longer has a branch dimension: one business, one set of books, and
 * what a user may do is decided entirely by the permissions on their role. This brings an
 * existing database to that shape.
 *
 * WHAT IT DOES:
 *
 *   1. renames the `isUnscoped` flag on roles to `isSuperAdmin` — the field survives, its
 *      branch-shaped name does not
 *   2. clears `branchIds` / `defaultBranchId` from users
 *   3. drops the branch-keyed indexes, which would otherwise be rebuilt over a field
 *      nothing reads
 *   4. drops the `branches` collection
 *
 * WHAT IT DELIBERATELY DOES NOT DO — and this is the important part:
 *
 * It does NOT strip `branchId` from `ledgerentries` or `transactions`. Those collections
 * are the audit trail. The field is inert once the code stops reading it — Mongoose in
 * strict mode ignores an undeclared path — so leaving it costs a few bytes a row and buys
 * back the only record of which office posted what. Deleting it would be irreversible and
 * would answer no question anybody has.
 *
 * That means this migration is REVERSIBLE for the ledger: restore the branch code, restore
 * the `branches` collection from a backup, and the postings still name their branch.
 *
 * It is IDEMPOTENT: running it twice is harmless.
 */

/** Writes only with `--apply`; anything else is a dry run. */
const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

/** Indexes keyed on a branch. Dropping a missing one is not an error. */
const OBSOLETE_INDEXES: Array<{ collection: string; index: string }> = [
  { collection: "users", index: "branchIds_1" },
  { collection: "transactions", index: "branchId_1_date_-1__id_-1" },
  { collection: "transactions", index: "branchId_1_status_1_date_-1" },
  { collection: "transactions", index: "branchId_1_type_1_date_-1" },
  { collection: "transactions", index: "branchId_1" },
  { collection: "ledgerentries", index: "branchId_1_date_-1__id_-1" },
  { collection: "ledgeraccounts", index: "branchId_1_kind_1_status_1" },
  { collection: "ledgeraccounts", index: "branchId_1" },
  { collection: "savingsaccounts", index: "branchId_1_status_1_memberName_1" },
  { collection: "savingsaccounts", index: "branchId_1" },
  { collection: "settlements", index: "branchId_1_date_-1" },
  { collection: "settlements", index: "branchId_1_status_1_date_-1" },
  { collection: "settlements", index: "branchId_1" },
  { collection: "auditlogs", index: "branchId_1_createdAt_-1" },
  { collection: "auditlogs", index: "branchId_1" },
  { collection: "chargerules", index: "branchId_1" },
  { collection: "dailycashtallies", index: "branchId_1_date_-1" },
  { collection: "reconciliations", index: "branchId_1" },
];

/**
 * Collections whose `branchId` is a dead master reference rather than a record of what
 * happened. Safe to clear; `ledgerentries` and `transactions` are deliberately absent.
 */
const CLEAR_BRANCH_FROM = [
  "ledgeraccounts",
  "savingsaccounts",
  "settlements",
  "chargerules",
  "auditlogs",
  "dailycashtallies",
  "reconciliations",
  "notifications",
];

const db = () => mongoose.connection.db!;

async function dropIndexes(): Promise<void> {
  for (const { collection, index } of OBSOLETE_INDEXES) {
    try {
      if (!(await db().collection(collection).indexExists(index))) continue;
      if (DRY_RUN) {
        logger.info({ collection, index }, "would drop index");
        continue;
      }
      await db().collection(collection).dropIndex(index);
      logger.info({ collection, index }, "index dropped");
    } catch (err) {
      logger.debug({ collection, index, err }, "index not dropped");
    }
  }
}

async function unsetFields(collection: string, fields: string[]): Promise<number> {
  const query = { $or: fields.map((f) => ({ [f]: { $exists: true } })) };
  const count = await db().collection(collection).countDocuments(query);

  if (count === 0) {
    logger.info({ collection }, "already clear");
    return 0;
  }
  if (DRY_RUN) {
    logger.info({ collection, count, fields }, "would clear fields");
    return count;
  }

  const result = await db()
    .collection(collection)
    .updateMany(query, { $unset: Object.fromEntries(fields.map((f) => [f, ""])) });
  logger.info({ collection, modified: result.modifiedCount, fields }, "fields cleared");
  return result.modifiedCount;
}

async function main(): Promise<void> {
  // No index building on connect — see `migrate-global-masters.ts` for why a migration
  // must never let the schema's indexes be built before it has run.
  await connectDatabase({ prepareCollections: false });

  logger.info(
    DRY_RUN
      ? "DRY RUN — nothing will be written. Re-run with --apply to make these changes."
      : "APPLYING — removing branches",
  );

  /* ── 1. isUnscoped → isSuperAdmin ─────────────────────────────────────── */

  const toRename = await db().collection("roles").countDocuments({ isUnscoped: { $exists: true } });
  if (toRename === 0) {
    logger.info("roles already use isSuperAdmin");
  } else if (DRY_RUN) {
    logger.info({ count: toRename }, "would rename roles.isUnscoped to isSuperAdmin");
  } else {
    const result = await db()
      .collection("roles")
      .updateMany({ isUnscoped: { $exists: true } }, { $rename: { isUnscoped: "isSuperAdmin" } });
    logger.info({ modified: result.modifiedCount }, "roles.isUnscoped renamed to isSuperAdmin");
  }

  /* ── 2. Users lose their assignment ───────────────────────────────────── */

  await unsetFields("users", ["branchIds", "defaultBranchId"]);

  /* ── 3. Masters and operational records lose their branch ─────────────── */

  for (const collection of CLEAR_BRANCH_FROM) {
    await unsetFields(collection, ["branchId"]);
  }

  /* ── 4. Indexes, then the collection itself ───────────────────────────── */

  await dropIndexes();

  const branchCount = await db()
    .collection("branches")
    .countDocuments({})
    .catch(() => 0);

  if (branchCount === 0) {
    logger.info("no branches collection to drop");
  } else if (DRY_RUN) {
    logger.warn({ count: branchCount }, "would DROP the branches collection");
  } else {
    await db().collection("branches").drop();
    logger.warn({ dropped: branchCount }, "branches collection dropped");
  }

  /* ── What survives ────────────────────────────────────────────────────── */

  const entries = await db().collection("ledgerentries").countDocuments({ branchId: { $ne: null } });
  const txns = await db().collection("transactions").countDocuments({ branchId: { $ne: null } });

  logger.info(
    { ledgerentries: entries, transactions: txns },
    "postings keep their branchId — inert to the application, and the only surviving record " +
      "of which office made each entry. Nothing reads it; nothing has destroyed it either.",
  );

  logger.info(
    DRY_RUN
      ? "DRY RUN complete — nothing was written. Re-run with --apply to make it so."
      : "migration complete. Restart the API so the new indexes are built.",
  );

  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.fatal({ err }, "migration failed — nothing further was written");
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
