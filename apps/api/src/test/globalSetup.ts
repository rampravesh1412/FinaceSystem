import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * One in-memory MongoDB REPLICA SET for the whole test run.
 *
 * A replica set, not a standalone, for the same reason production uses one: the ledger
 * engine wraps every posting in a session transaction, and a standalone mongod cannot
 * start one. Testing against a topology that silently skips transactions would mean the
 * suite passes while the atomicity guarantee it is supposed to verify is not exercised.
 */
let replSet: MongoMemoryReplSet | undefined;

export async function setup(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });

  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = "amiri_test";
  process.env.NODE_ENV = "test";
  // `fatal`, not `error`: many suites deliberately trigger rollbacks and refusals, and
  // the engine correctly logs each one with a stack. At `error` a fully passing run
  // prints hundreds of lines of expected failures and buries any real problem.
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "fatal";
  process.env.JWT_ACCESS_SECRET = "test-access-secret-0000000000000000000000000000";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret-1111111111111111111111111111";
  process.env.COOKIE_SECURE = "false";
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
}
