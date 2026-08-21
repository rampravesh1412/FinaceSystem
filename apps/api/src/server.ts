import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase } from "./config/db.js";

/**
 * Process lifecycle.
 *
 * The graceful shutdown here matters more than usual: a SIGTERM arriving mid-transfer
 * must not kill the process while a Mongo transaction is uncommitted. Closing the HTTP
 * listener first stops new work, then in-flight requests are given time to commit before
 * the database connection is released.
 */
async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, prefix: env.API_PREFIX, env: env.NODE_ENV },
      `AMIRI Finance API listening on http://localhost:${env.PORT}${env.API_PREFIX}`,
    );
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    // Force-exit backstop. If a request is genuinely stuck, exiting is better than
    // hanging forever and being SIGKILLed at an arbitrary point.
    const force = setTimeout(() => {
      logger.fatal("graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 20_000);
    force.unref();

    server.close(async (err) => {
      if (err) logger.error({ err }, "error while closing the http server");
      try {
        await disconnectDatabase();
      } catch (dbErr) {
        logger.error({ err: dbErr }, "error while closing the database connection");
      }
      clearTimeout(force);
      process.exit(err ? 1 : 0);
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "unhandled promise rejection");
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (err) => {
    // The process state is undefined after an uncaught exception, so continuing to serve
    // financial requests from it would be reckless.
    logger.fatal({ err }, "uncaught exception");
    void shutdown("uncaughtException");
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
