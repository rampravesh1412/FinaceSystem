import mongoose from "mongoose";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/db.js";

/**
 * Make parties, bank accounts and cash drawers ORGANISATION-WIDE.
 *
 *   npm run migrate:global-masters                  DRY RUN — reports, writes nothing
 *   npm run migrate:global-masters -- --apply       actually do it
 *
 * These three masters used to carry a `branchId`. They no longer do — a customer, a bank
 * account and a cash drawer each belong to the business rather than to one office, and
 * splitting them per branch gave one real thing several part-balances. The branch has not
 * left the books: every ledger entry still records the branch that posted it, which is
 * where per-branch reporting reads it from.
 *
 * THE API WILL NOT BOOT UNTIL THIS HAS RUN. Party codes and drawer names used to be unique
 * only WITHIN a branch, so an existing database almost certainly holds a "Main Counter" in
 * every branch and a `PTY-00001` in each of them too. The new schema declares those unique
 * across the organisation, and Mongoose builds indexes on connect — so boot fails with
 * `E11000 duplicate key` until the collisions are resolved. Resolving them is step 1 below.
 *
 * What this does, in order:
 *
 *   1. renames colliding drawer names and party codes, keeping the oldest record's value
 *      and suffixing the others with the branch they used to belong to
 *   2. keeps exactly one default cash drawer
 *   3. drops the old per-branch indexes
 *   4. unsets `branchId` on the masters, on their ledger accounts, and on the records that
 *      hang off them (tallies, reconciliations)
 *   5. leaves `ledgerentries` and `transactions` COMPLETELY untouched
 *
 * WHY RENAME RATHER THAN REFUSE: two branches each holding a drawer called "Main Counter"
 * are two real, distinct drawers that happen to share a label, and two parties coded
 * `PTY-00001` are two distinct parties that happen to share a code. Neither is a merge —
 * no balance moves, no history is combined, only the label changes. A party's NAME is left
 * alone precisely because sameness of name might mean sameness of firm, and that IS a
 * judgement with money attached; nothing in the new schema requires names to be unique, so
 * nothing forces the question.
 *
 * It is IDEMPOTENT: running it twice is harmless.
 */

/**
 * WRITES ONLY WITH `--apply`. Anything else is a dry run.
 *
 * Deliberately this way round rather than `--dry-run`, because the safe mode has to be the
 * one you get by accident. `npm run` swallows a trailing `--dry-run` as an npm flag of its
 * own and never passes it through, so an opt-OUT of writing was a flag that could silently
 * fail to apply — and did. Requiring an explicit opt-IN cannot fail that way: a swallowed
 * `--apply` leaves you with a dry run and a puzzled look, not a migrated database.
 */
const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

/**
 * Indexes the old per-branch model created. Dropping a missing one is not an error.
 *
 * `mobile_1` is here for a different reason from the rest: the name is unchanged, but the
 * OPTIONS are. The old schema declared `index: true` on the field (non-sparse) alongside a
 * compound `{mobile, branchId}`; the new one declares a single sparse `{mobile}`. MongoDB
 * refuses to redefine an existing index under the same name with different options, so the
 * old one has to go before Mongoose can build the new one.
 */
const OBSOLETE_INDEXES: Array<{ collection: string; index: string }> = [
  { collection: "parties", index: "branchId_1_code_1" },
  { collection: "parties", index: "branchId_1_status_1_name_1" },
  { collection: "parties", index: "branchId_1_type_1" },
  { collection: "parties", index: "mobile_1_branchId_1" },
  { collection: "parties", index: "mobile_1" },
  { collection: "parties", index: "branchId_1" },
  { collection: "bankaccounts", index: "branchId_1_status_1" },
  { collection: "bankaccounts", index: "branchId_1" },
  { collection: "cashaccounts", index: "branchId_1_name_1" },
  { collection: "cashaccounts", index: "branchId_1_isDefault_1" },
  { collection: "cashaccounts", index: "branchId_1" },
  { collection: "dailycashtallies", index: "branchId_1_date_-1" },
];

const db = () => mongoose.connection.db!;

/** Branch id → code, for labelling a renamed record with where it used to live. */
async function branchCodes(): Promise<Map<string, string>> {
  const branches = await db()
    .collection("branches")
    .find({})
    .project({ _id: 1, code: 1 })
    .toArray();
  return new Map(branches.map((b) => [String(b._id), String(b.code ?? "")]));
}

/**
 * Make a field unique across a collection by renaming the losers.
 *
 * The OLDEST record keeps the original value — it is the one most likely to be referenced
 * on paperwork already printed. Everything else gets its old branch code appended, which
 * is both a stable disambiguator and the label a human would have reached for anyway:
 * "Main Counter" in branch 107 becomes "Main Counter (107)".
 */
async function deduplicate(
  collection: string,
  field: string,
  format: (value: string, suffix: string) => string,
): Promise<number> {
  const codes = await branchCodes();

  const clashes = await db()
    .collection(collection)
    .aggregate<{ _id: unknown; ids: unknown[] }>([
      { $match: { [field]: { $ne: null } } },
      { $sort: { createdAt: 1, _id: 1 } },
      { $group: { _id: `$${field}`, ids: { $push: "$_id" }, branches: { $push: "$branchId" } } },
      { $match: { $expr: { $gt: [{ $size: "$ids" }, 1] } } },
    ])
    .toArray();

  if (clashes.length === 0) {
    logger.info({ collection, field }, "no duplicates");
    return 0;
  }

  let renamed = 0;

  for (const clash of clashes) {
    // Skip the first — the oldest keeps the value it already has.
    const losers = clash.ids.slice(1);

    for (const [index, id] of losers.entries()) {
      const doc = await db().collection(collection).findOne({ _id: id as never });
      if (!doc) continue;

      // The branch it used to belong to, or a plain counter if that is already gone.
      const code = doc.branchId ? codes.get(String(doc.branchId)) : undefined;
      let next = format(String(clash._id), code || String(index + 2));

      // Vanishingly unlikely, but two branches could share a code in a broken dataset —
      // and silently writing a value that collides again would leave the API still unable
      // to boot, with the migration reporting success.
      let attempt = 1;
      while (await db().collection(collection).findOne({ [field]: next })) {
        attempt += 1;
        next = format(String(clash._id), `${code || index + 2}-${attempt}`);
      }

      logger.warn(
        { collection, field, from: clash._id, to: next, id: String(id) },
        DRY_RUN ? "would rename" : "renamed",
      );

      if (!DRY_RUN) {
        await db().collection(collection).updateOne({ _id: id as never }, { $set: { [field]: next } });
      }
      renamed += 1;
    }
  }

  return renamed;
}

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
      // A collection that does not exist yet, or an index already gone. Neither is a
      // failure — this script has to be safe to re-run.
      logger.debug({ collection, index, err }, "index not dropped");
    }
  }
}

/** Remove `branchId` from a collection, reporting how many rows still carried one. */
async function unsetBranch(collection: string): Promise<number> {
  const query = { branchId: { $exists: true, $ne: null } };

  const count = await db().collection(collection).countDocuments(query);
  if (count === 0) {
    logger.info({ collection }, "branchId already clear");
    return 0;
  }
  if (DRY_RUN) {
    logger.info({ collection, count }, "would clear branchId");
    return count;
  }

  const result = await db().collection(collection).updateMany(query, { $unset: { branchId: "" } });
  logger.info({ collection, modified: result.modifiedCount }, "branchId cleared");
  return result.modifiedCount;
}

async function main(): Promise<void> {
  /**
   * `prepareCollections: false` is REQUIRED here, and is the whole reason the option
   * exists. A normal connect builds every index declared on the schemas — including the
   * unique ones this script is about to make satisfiable. Connecting the ordinary way
   * would throw the same E11000 that stops the API booting, before a single duplicate had
   * been fixed.
   */
  await connectDatabase({ prepareCollections: false });

  logger.info(
    DRY_RUN
      ? "DRY RUN — nothing will be written. Re-run with --apply to make these changes."
      : "APPLYING — migrating to organisation-wide masters",
  );

  /* ── 1. Resolve the collisions the new unique indexes would hit ───────── */

  const drawers = await deduplicate("cashaccounts", "name", (name, suffix) => `${name} (${suffix})`);
  // Party codes are uppercase and match /^[A-Z0-9-]+$/, so the suffix joins with a hyphen.
  const parties = await deduplicate("parties", "code", (code, suffix) =>
    `${code}-${suffix}`.toUpperCase().slice(0, 24),
  );

  /* ── 2. One default drawer, not one per branch ────────────────────────── */

  const defaults = await db()
    .collection("cashaccounts")
    .find({ isDefault: true })
    .sort({ createdAt: 1, _id: 1 })
    .project({ _id: 1, name: 1 })
    .toArray();

  if (defaults.length > 1) {
    const keep = defaults[0]!;
    const clear = defaults.slice(1);
    logger.warn(
      { keeping: keep.name, clearing: clear.map((d) => d.name) },
      "several default drawers — keeping the oldest, clearing the rest",
    );
    if (!DRY_RUN) {
      await db()
        .collection("cashaccounts")
        .updateMany({ _id: { $in: clear.map((d) => d._id) } }, { $set: { isDefault: false } });
    }
  }

  /* ── 3. Drop the per-branch indexes ───────────────────────────────────── */

  await dropIndexes();

  /* ── 4. Clear the branch from the masters and what hangs off them ─────── */

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
  const ledgerFilter = { kind: { $in: ["PARTY", "BANK", "CASH"] }, branchId: { $ne: null } };
  const ledgerCount = await db().collection("ledgeraccounts").countDocuments(ledgerFilter);

  if (ledgerCount === 0) {
    logger.info("ledger accounts already organisation-wide");
  } else if (DRY_RUN) {
    logger.info({ count: ledgerCount }, "would clear branchId on party/bank/cash ledger accounts");
  } else {
    const result = await db()
      .collection("ledgeraccounts")
      .updateMany(ledgerFilter, { $set: { branchId: null } });
    logger.info({ modified: result.modifiedCount }, "ledger accounts made organisation-wide");
  }

  /* ── 5. What was deliberately NOT touched ─────────────────────────────── */

  logger.info(
    "ledgerentries and transactions were not modified — every posting keeps the branch " +
      "that made it, which is what the DayBook and every per-branch report read.",
  );

  /**
   * The new indexes are built by Mongoose on the next boot from the schema definitions, so
   * this script does not create them. Doing it here would mean two places defining the
   * same index, and they would drift.
   */
  logger.info(
    { renamedDrawers: drawers, renamedPartyCodes: parties },
    DRY_RUN
      ? "DRY RUN complete — nothing was written. Re-run with --apply to make it so."
      : "migration complete. Start the API; it will build the new indexes on boot.",
  );

  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.fatal({ err }, "migration failed — nothing further was written");
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
