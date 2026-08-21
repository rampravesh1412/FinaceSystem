/**
 * A local MongoDB replica set WITHOUT Docker.
 *
 * `npm run db:up` is the preferred path, but Docker is not installed everywhere. This
 * downloads a real mongod binary (once, cached under node_modules) and runs it as a
 * single-node replica set, which is what the ledger engine's transactions require.
 *
 * Data persists in `.mongo-data/` between runs — this is a development database, not an
 * ephemeral test fixture, so a restart must not wipe the books you were working with.
 *
 *   npm run db:local     start and keep running (Ctrl-C to stop)
 *
 * Leave it running in its own terminal, then `npm run seed` and `npm run dev` elsewhere.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(root, ".mongo-data");
mkdirSync(dbPath, { recursive: true });

// A fixed port so the URI in apps/api/.env stays valid across restarts.
const PORT = 27017;

console.log("starting mongodb replica set (this downloads mongod on first run)…");

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger", name: "rs0" },
  instanceOpts: [{ port: PORT, dbPath, storageEngine: "wiredTiger" }],
});

const uri = replSet.getUri();

console.log(`
┌──────────────────────────────────────────────────────────────────────┐
│  MongoDB replica set is up                                           │
├──────────────────────────────────────────────────────────────────────┤
│  URI    ${uri.padEnd(60)}│
│  Data   ${dbPath.slice(-60).padEnd(60)}│
│                                                                      │
│  apps/api/.env should contain:                                       │
│  MONGODB_URI=mongodb://localhost:${PORT}/?replicaSet=rs0&directConnection=true
│                                                                      │
│  Then, in another terminal:   npm run seed && npm run dev            │
│  Ctrl-C here to stop.                                                │
└──────────────────────────────────────────────────────────────────────┘
`);

const stop = async () => {
  console.log("\nstopping mongodb…");
  // `false` keeps the data directory on disk, which is the entire point of this script.
  await replSet.stop({ doCleanup: false });
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Hold the process open.
await new Promise(() => {});
