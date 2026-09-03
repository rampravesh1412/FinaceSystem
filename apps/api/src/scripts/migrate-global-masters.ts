import mongoose from "mongoose";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/db.js";

/**
 * Make parties, bank accounts and cash drawers ORGANISATION-WIDE.
 *
 *   npx tsx src/scripts/migrate-global-masters.ts --dry-run
 *   npx tsx src/scripts/migrate-global-masters.ts
 *
 * These three masters used to carry a `branchId`. They no longer do — a customer, a bank
 * account and a cash drawer each belong to the business rather than to one office, and
 * splitting them per branch gave one real thing several part-balances. The branch has not
 * left the books: every ledger entry still records the branch that posted it, which is
 * where per-branch reporting reads it from.
 *
 * This script brings an existing database to that shape. It does FOUR things:
 *
 *   1. drops the branch-scoped unique indexes, which would otherwise keep enforcing
 *      per-branch uniqueness and reject a genuinely global one
 *   2. reports any duplicate that would break the new global unique indexes, and STOPS
 *      without changing anything if it finds one
 *   3. unsets `branchId` on the masters and on their ledger accounts
 *   4. leaves `ledgerentries` and `transactions` completely untouched
 *
 * WHY STEP 2 MATTERS: two branches could each hold a party coded PTY-00001, or a drawer
 * named "Main Counter". Those collide the moment the code is unique across the
 * organisation. The script will not guess which one to rename — it prints them and exits,
 * because merging two parties' histories is a decision with money attached.
 *
 * It is IDEMPOTENT: running it twice is harmless, and running it on an already-migrated
 * database does nothing.
 */

const DRY_RUN = process.argv.includes("--dry-run");

/** Indexes the old per-branch model created. Dropping a missing one is not an error. */
const OBSOLETE_INDEXES: Array<{ collection: string; index: string }> = [
  { collection: "parties", index: "branchId_1_code_1" },
  { collection: "parties", index: "branchId_1_status_1_name_1" },
  { collection: "parties", index: "branchId_1_type_1" },
  { collection: "parties", index: "mobile_1_branchId_1" },
  { collection: "parties", index: "branchId_1" },
  { collection: "bankaccounts", index: "branchId_1_status_1" },
  { collection: "bankaccounts", index: "branchId_1" },
  { collection: "cashaccounts", index: "branchId_1_name_1" },
  { collection: "cashaccounts", index: "branchId_1_isDefault_1" },
  { collection: "cashaccounts", index: "branchId_1" },
  { collection: "dailycashtallies", index: "branchId_1_date_-1" },
];

interface Duplicate {
  collection: string;
  field: string;
  value: unknown;
  count: number;
}

/** Values that appear more than once once the branch is taken out of the key. */
async function findDuplicates(collection: string, field: string): Promise<Duplicate[]> {
  const db = mongoose.connection.db!;
  const rows = await db
    .collection(collection)
    .aggregate<{ _id: unknown; count: number }>([
      { $match: { [field]: { $ne: null } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();

  return rows.map((r) => ({ collection, field, value: r._id, count: r.count }));
}

async function dropIndexes(): Promise<void> {
  const db = mongoose.connection.db!;

  for (const { collection, index } of OBSOLETE_INDEXES) {
    try {
      const exists = await db.collection(collection).indexExists(index);
      if (!exists) continue;
      if (DRY_RUN) {
        logger.info({ collection, index }, "would drop index");
        continue;
      }
      await db.collection(collection).dropIndex(index);
      logger.info({ collection, index }, "index dropped");
    } catch (err) {
      // A collection that does not exist yet, or an index already gone. Neither is a
      // failure — this script has to be safe to re-run.
      logger.debug({ collection, index, err }, "index not dropped");
    }
  }
}

/** Remove `branchId` from a collection, reporting how many rows still carried one. */
async function unsetBranch(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
  const db = mongoose.connection.db!;
  const query = { ...filter, branchId: { $exists: true, $ne: null } };

  const count = await db.collection(collection).countDocuments(query);
  if (count === 0 || DRY_RUN) {
    logger.info({ collection, count }, DRY_RUN ? "would clear branchId" : "nothing to clear");
    return count;
  }

  const result = await db.collection(collection).updateMany(query, { $unset: { branchId: "" } });
  logger.info({ collection, modified: result.modifiedCount }, "branchId cleared");
  return result.modifiedCount;
}

async function main(): Promise<void> {
  await connectDatabase();

  logger.info(DRY_RUN ? "DRY RUN — nothing will be written" : "migrating to organisation-wide masters");

  /* ── 1. Would anything collide? ───────────────────────────────────────── */

  const duplicates = [
    ...(await findDuplicates("parties", "code")),
    ...(await findDuplicates("cashaccounts", "name")),
  ];

  if (duplicates.length > 0) {
    logger.error(
      { duplicates },
      "REFUSING TO MIGRATE: these values are only unique per branch and would collide once " +
        "the masters are organisation-wide. Rename or merge them first — the script will not " +
        "choose for you, because merging two parties merges their money.",
    );
    for (const d of duplicates) {
      logger.error(`  ${d.collection}.${d.field} = ${String(d.value)} appears ${d.count} times`);
    }
    await disconnectDatabase();
    process.exit(1);
  }

  /**
   * More than one drawer may currently be flagged `isDefault` — the old rule was one per
   * branch, the new one is one overall. Keeping the oldest is arbitrary but stable, and a
   * default drawer only decides where an unspecified cash receipt lands.
   */
  const db = mongoose.connection.db!;
  const defaults = await db
    .collection("cashaccounts")
    .find({ isDefault: true })
    .sort({ createdAt: 1 })
    .project({ _id: 1, name: 1 })
    .toArray();

  if (defaults.length > 1) {
    const keep = defaults[0]!;
    const clear = defaults.slice(1).map((d) => d._id);
    logger.warn(
      { keeping: keep.name, clearing: defaults.slice(1).map((d) => d.name) },
      "several default drawers — keeping the oldest, clearing the rest",
    );
    if (!DRY_RUN) {
      await db
        .collection("cashaccounts")
        .updateMany({ _id: { $in: clear } }, { $set: { isDefault: false } });
    }
  }

  /* ── 2. Drop the per-branch indexes ───────────────────────────────────── */

  await dropIndexes();

  /* ── 3. Clear the branch from the masters and their ledger accounts ───── */

  await unsetBranch("parties");
  await unsetBranch("bankaccounts");
  await unsetBranch("cashaccounts");
  await unsetBranch("dailycashtallies");
  await unsetBranch("reconciliations");

  /**
   * The ledger accounts for those masters become organisation-wide too — `branchId: null`
   * is the shape the chart of accounts already used for equity and suspense.
   *
   * Only PARTY, BANK and CASH kinds. Expense and income heads keep whatever branch they
   * had, because this migration is not about them.
   */
  const ledgerFilter = { kind: { $in: ["PARTY", "BANK", "CASH"] } };
  const ledgerCount = await db
    .collection("ledgeraccounts")
    .countDocuments({ ...ledgerFilter, branchId: { $ne: null } });

  if (DRY_RUN) {
    logger.info({ count: ledgerCount }, "would clear branchId on party/bank/cash ledger accounts");
  } else if (ledgerCount > 0) {
    const result = await db
      .collection("ledgeraccounts")
      .updateMany({ ...ledgerFilter, branchId: { $ne: null } }, { $set: { branchId: null } });
    logger.info({ modified: result.modifiedCount }, "ledger accounts made organisation-wide");
  }

  /* ── 4. What was deliberately NOT touched ─────────────────────────────── */

  logger.info(
    "ledgerentries and transactions were not modified — every posting keeps the branch that " +
      "made it, which is what the DayBook and every per-branch report read.",
  );

  /**
   * The new indexes are built by Mongoose on the next boot from the schema definitions, so
   * this script does not create them. Doing it here would mean two places defining the
   * same index, and they would drift.
   */
  logger.info(
    DRY_RUN
      ? "DRY RUN complete — re-run without --dry-run to apply"
      : "migration complete. Restart the API so the new indexes are built.",
  );

  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.fatal({ err }, "migration failed — nothing further was written");
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
