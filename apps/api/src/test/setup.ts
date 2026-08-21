import { afterAll, beforeAll } from "vitest";
import mongoose from "mongoose";

/**
 * Per-file database lifecycle.
 *
 * `globalSetup` has already published MONGODB_URI into the environment, so importing
 * `connectDatabase` here picks it up through the validated env module — the test path and
 * the production path use exactly the same connection code, including the replica-set
 * assertion.
 */
beforeAll(async () => {
  const { connectDatabase } = await import("../config/db.js");
  await connectDatabase();

  /**
   * Clear the export service's cached organisation name.
   *
   * All suites share one process, so that module-level cache survives the database being
   * dropped between files — a settings suite that renames the organisation would leave the
   * next file's exports printing a name its own fresh database has never heard of. A real
   * process starts with an empty cache; so does each file here.
   */
  const { invalidateOrganisationName } = await import("../services/export.service.js");
  invalidateOrganisationName();
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
