import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Database connection.
 *
 * Two non-obvious settings worth reading:
 *
 * `autoIndex` is on in dev and off in prod. Building indexes at boot on a large
 * `ledgerentries` collection would stall the process for minutes; production indexes are
 * created deliberately via `npm run migrate:indexes`.
 *
 * `bufferCommands: false` makes a query issued before the connection is ready fail fast
 * instead of queueing invisibly for 10 seconds and then timing out somewhere unrelated.
 *
 * NOTE — `sanitizeFilter` is deliberately NOT enabled globally.
 *
 * It looks like the obvious NoSQL-injection defence, but it applies to every filter the
 * application builds, not just the untrusted ones. It rewrites `{ _id: { $in: [...] } }`
 * into `{ _id: { $eq: { $in: [...] } } }`, which then fails to cast. That would break
 * every `$in`, `$gte`, `$or` and aggregation match in the system.
 *
 * Untrusted input is sanitised where it actually arrives instead: `stripOperators` in
 * middleware/security.ts removes `$`-prefixed and dotted keys at the HTTP boundary, and
 * every route parses its input through a Zod schema that coerces to primitives. If a
 * specific query ever does interpolate a raw user object into a filter, apply
 * `.setOptions({ sanitizeFilter: true })` to that query alone.
 */
export interface ConnectOptions {
  /**
   * Create collections and build indexes on connect. On by default, and required before
   * serving traffic — see `materialiseCollections`.
   *
   * A MIGRATION must pass `false`. Index builds are exactly what a migration is there to
   * make possible: a script that fixes duplicate keys cannot get as far as fixing them if
   * connecting already tried to build the unique index over the duplicates and threw.
   */
  prepareCollections?: boolean;
}

export async function connectDatabase(options: ConnectOptions = {}): Promise<typeof mongoose> {
  const { prepareCollections = true } = options;

  mongoose.set("strictQuery", true);
  mongoose.set("autoIndex", !env.isProd && prepareCollections);
  mongoose.set("bufferCommands", false);

  if (env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace") {
    mongoose.set("debug", (collection, method, ...args) => {
      logger.debug({ collection, method, args: args.slice(0, 2) }, "mongoose");
    });
  }

  const conn = await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DB_NAME,
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    minPoolSize: 2,
    retryWrites: true,
  });

  mongoose.connection.on("error", (err) => logger.error({ err }, "mongodb connection error"));
  mongoose.connection.on("disconnected", () => logger.warn("mongodb disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("mongodb reconnected"));

  await assertTransactionSupport();
  if (prepareCollections) await materialiseCollections();

  logger.info(
    { db: env.MONGODB_DB_NAME, host: conn.connection.host },
    "mongodb connected",
  );
  return conn;
}

/**
 * Create every collection and build every index BEFORE serving traffic.
 *
 * This is not a nicety — it is required for correctness given how the ledger posts.
 *
 * Every money movement runs in a transaction with `readConcern: "snapshot"`. If a write
 * inside that transaction is the first ever write to a collection, MongoDB has to create
 * the collection, which is a catalog change. A snapshot read cannot proceed across a
 * pending catalog change, so the server raises `SnapshotUnavailable` — and because that
 * is classified as a *transient* transaction error, the driver retries. The retry hits
 * the same wall on the next not-yet-created collection, and a perfectly valid transfer
 * fails after exhausting its retries with an error that looks like contention.
 *
 * Materialising the namespaces up front removes the catalog change from the hot path
 * entirely. It also front-loads index builds, so the first request of the day is not the
 * one that pays for them.
 */
async function materialiseCollections(): Promise<void> {
  // `mongoose.models` only holds models that have actually been imported, and
  // `connectDatabase` runs before the routes are wired. Importing the barrel here
  // registers every schema, so nothing is missed and the hot path stays clean.
  await import("../models/index.js");

  /**
   * One entry per COLLECTION, not per model.
   *
   * Transaction discriminators (PAYMENT_IN, EXPENSE, …) are separate models that all
   * share the `transactions` collection, and their indexes are declared on the base
   * schema. Preparing each of them would fire concurrent `createCollection` calls at the
   * same namespace, and the loser of that race fails with something other than the
   * NamespaceExists we expect. Deduplicating by collection name removes the race and the
   * redundant work.
   */
  const byCollection = new Map<string, (typeof mongoose.models)[string]>();
  for (const model of Object.values(mongoose.models)) {
    const name = model.collection.name;
    // Prefer the base model — it owns the schema that declares the indexes.
    if (!byCollection.has(name) || !model.baseModelName) byCollection.set(name, model);
  }

  const collections = [...byCollection.values()];
  // EVERY model, discriminators included. A discriminator declares its own indexes
  // (`sourceAccountId`, `categoryId`, …) and Mongoose builds them lazily on that model's
  // first write. Left to happen on demand, that index build lands inside a posting's
  // transaction — another catalog change, another SnapshotUnavailable retry storm.
  const allModels = Object.values(mongoose.models);

  const results = await Promise.allSettled([
    ...collections.map(async (model) => {
      try {
        await model.createCollection();
      } catch (err) {
        // NamespaceExists (48) is the expected case on every boot after the first.
        if ((err as { code?: number }).code !== 48) throw err;
      }
    }),
  ]);

  // Index builds run after the namespaces exist, and sequentially — concurrent
  // `createIndexes` against one collection is a needless source of contention at boot.
  for (const model of allModels) {
    await model.init();
  }

  const failed = results.flatMap((r, i) =>
    r.status === "rejected" ? [{ model: collections[i]!.modelName, reason: r.reason }] : [],
  );

  if (failed.length > 0) {
    for (const f of failed) logger.error({ model: f.model, err: f.reason }, "failed to prepare collection");
    throw new Error(
      `Could not prepare ${failed.length} collection(s): ${failed.map((f) => f.model).join(", ")}`,
    );
  }

  logger.debug(
    { collections: collections.length, models: allModels.length },
    "collections and indexes ready",
  );
}

/**
 * Refuse to run against a deployment that cannot do multi-document transactions.
 *
 * This is a hard failure, not a warning, and deliberately so. Every money movement in
 * this system spans several documents — the transaction header, two or more ledger
 * lines, the cached balances, the audit row. Without a session those writes are not
 * atomic, and the first crash mid-transfer leaves money that exists on one side of a
 * transfer and not the other. A ledger that can be silently corrupted is worse than an
 * application that will not boot.
 */
async function assertTransactionSupport(): Promise<void> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error("Database handle unavailable after connect");

  const info = (await admin.command({ hello: 1 })) as {
    setName?: string;
    msg?: string;
  };

  const isReplicaSet = Boolean(info.setName);
  const isMongos = info.msg === "isdbgrid";

  if (isReplicaSet || isMongos) {
    logger.info(
      { topology: isMongos ? "sharded" : `replicaSet:${info.setName}` },
      "multi-document transactions available",
    );
    return;
  }

  logger.fatal(
    "\n" +
      "  ✗ MongoDB is running as a STANDALONE server.\n" +
      "\n" +
      "    Multi-document transactions are unavailable, so no money movement can be\n" +
      "    written atomically. The API will not start against this deployment.\n" +
      "\n" +
      "    Start the bundled single-node replica set instead:\n" +
      "        npm run db:up\n" +
      "\n" +
      "    Or point MONGODB_URI at a replica set / Atlas cluster.\n",
  );
  await mongoose.disconnect();
  process.exit(1);
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close(false);
  logger.info("mongodb connection closed");
}

export { mongoose };
