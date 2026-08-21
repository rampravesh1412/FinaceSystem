import mongoose, { type ClientSession } from "mongoose";
import { logger } from "../config/logger.js";
import { AppError } from "./errors.js";

/**
 * The unit of work for every money movement (§38).
 *
 * Wraps a callback in a MongoDB session transaction with the correct read/write concerns
 * for financial data:
 *
 *   readConcern "snapshot"  — every read inside the transaction sees one consistent point
 *                             in time, so a balance check cannot be invalidated by a
 *                             concurrent write between the check and the posting.
 *   writeConcern "majority" — the commit is acknowledged only once a majority of replica
 *                             set members have it, so a primary failover cannot roll back
 *                             a transfer the user was told had succeeded.
 *
 * `session.withTransaction` retries automatically on TransientTransactionError (a write
 * conflict from two concurrent postings against the same account) and on
 * UnknownTransactionCommitResult. That retry is why the callback must be idempotent:
 * it may genuinely run more than once. Do not perform side effects outside the session
 * inside it — no email, no webhook, no file write. Collect those and fire them after
 * `withTransaction` resolves.
 */

export interface UnitOfWorkOptions {
  /** Label used in logs and slow-transaction warnings. */
  label?: string;
  /** Reject rather than retry forever. Default 3. */
  maxRetries?: number;
}

export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  options: UnitOfWorkOptions = {},
): Promise<T> {
  const { label = "transaction", maxRetries = 3 } = options;
  const session = await mongoose.startSession();
  const startedAt = Date.now();
  let attempts = 0;
  /**
   * The last error the callback actually produced.
   *
   * When the retry cap is hit we rethrow THIS, not a generic "system is busy". An earlier
   * version threw its own error here and destroyed the underlying cause — which turned a
   * precise `SnapshotUnavailable` into an unactionable 503 and cost real debugging time.
   * The cap should stop the retry loop, not hide why it was looping.
   */
  let lastError: unknown;

  try {
    const result = await session.withTransaction(
      async (s) => {
        attempts += 1;
        if (attempts > maxRetries) {
          /**
           * Stop retrying with a NON-transient error.
           *
           * Rethrowing `lastError` directly does not work: a transient error still
           * carries its `TransientTransactionError` label, so the driver sees it, decides
           * the transaction is retryable, and calls this callback again — the cap never
           * caps. The loop then runs for MongoDB's full 120-second window while the
           * request hangs.
           *
           * An AppError carries no such label, so the driver aborts immediately. The
           * original is attached as `cause` and its message is quoted, so nothing about
           * the real failure is lost.
           */
          const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
          throw new AppError(
            503,
            "SERVICE_UNAVAILABLE",
            "The system is busy and could not complete this transaction. Please try again.",
            { details: { label, attempts, cause: detail }, cause: lastError },
          );
        }
        try {
          return await fn(s);
        } catch (err) {
          lastError = err;
          throw err;
        }
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority", j: true },
        readPreference: "primary",
        maxCommitTimeMS: 15_000,
      },
    );

    const ms = Date.now() - startedAt;
    if (ms > 1_000) {
      logger.warn({ label, ms, attempts }, "slow financial transaction");
    } else {
      logger.debug({ label, ms, attempts }, "financial transaction committed");
    }

    // `withTransaction` types the result as T | undefined because the callback may be
    // retried; if it committed, the value is real.
    return result as T;
  } catch (err) {
    logger.error(
      { label, attempts, ms: Date.now() - startedAt, err },
      "financial transaction rolled back",
    );
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Run inside an existing session if one was passed, otherwise open a new transaction.
 *
 * Lets a service be both a standalone operation and a step inside a larger one — for
 * example `createPaymentIn` used directly by its controller, or called by the settlement
 * service as part of a multi-payment settlement that must commit or roll back as a unit.
 */
export async function withOptionalTransaction<T>(
  session: ClientSession | undefined,
  fn: (session: ClientSession) => Promise<T>,
  options?: UnitOfWorkOptions,
): Promise<T> {
  if (session) return fn(session);
  return withTransaction(fn, options);
}

/**
 * Actions to run only after the transaction has actually committed.
 *
 * Notifications, audit fan-out to external sinks, cache invalidation — anything that
 * would be wrong to perform if the transaction later rolled back, and anything that must
 * not run twice when `withTransaction` retries.
 *
 *   const after = new AfterCommit();
 *   const txn = await withTransaction(async (s) => {
 *     after.reset();                       // retry-safe: clear on every attempt
 *     ...
 *     after.push(() => notify(userId));
 *     return doc;
 *   });
 *   await after.run();
 */
export class AfterCommit {
  private actions: Array<() => void | Promise<void>> = [];

  reset(): void {
    this.actions = [];
  }

  push(action: () => void | Promise<void>): void {
    this.actions.push(action);
  }

  async run(): Promise<void> {
    for (const action of this.actions) {
      try {
        await action();
      } catch (err) {
        // A failed notification must never surface as a failed payment — the money has
        // already moved and the client has been told so.
        logger.error({ err }, "after-commit action failed");
      }
    }
    this.reset();
  }
}
