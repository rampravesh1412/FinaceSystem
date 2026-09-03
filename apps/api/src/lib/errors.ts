import type { ErrorCode } from "@amiri/shared";

/**
 * The application error hierarchy.
 *
 * Anything thrown that is an `AppError` is considered *expected* — a business rule said
 * no — and is rendered to the client with its code, message and status. Anything else is
 * a bug, gets logged with its stack, and is rendered as a generic 500 with a request id.
 * That split is the whole reason this file exists: it makes "never leak a stack trace"
 * a structural property rather than a habit.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly field?: string;
  readonly details?: unknown;
  /** True for errors that are part of normal operation and should not page anyone. */
  readonly expected = true;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options?: { field?: string; details?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.field = options?.field;
    this.details = options?.details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/* ── 4xx: the caller ─────────────────────────────────────────────────────── */

export class ValidationError extends AppError {
  constructor(message = "The submitted data is not valid", details?: unknown, field?: string) {
    super(422, "VALIDATION_ERROR", message, { details, field });
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, field?: string) {
    super(400, "INVALID_INPUT", message, { field });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "You are not signed in", code: ErrorCode = "UNAUTHENTICATED") {
    super(401, code, message);
  }
}

export class InvalidCredentialsError extends AppError {
  /**
   * Deliberately identical whether the email is unknown or the password is wrong.
   * Distinguishing them turns the login form into an account-enumeration oracle.
   */
  constructor() {
    super(401, "INVALID_CREDENTIALS", "Incorrect email or password");
  }
}

export class AccountLockedError extends AppError {
  constructor(until: Date) {
    super(
      423,
      "ACCOUNT_LOCKED",
      `Too many failed sign-in attempts. Try again after ${until.toLocaleTimeString("en-IN")}.`,
      { details: { lockedUntil: until.toISOString() } },
    );
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this", code: ErrorCode = "FORBIDDEN") {
    super(403, code, message);
  }
}

export class PermissionDeniedError extends AppError {
  constructor(permission: string) {
    super(403, "PERMISSION_DENIED", "You do not have permission to perform this action", {
      details: { required: permission },
    });
  }
}

export class NotFoundError extends AppError {
  constructor(entity = "Record", id?: string) {
    super(404, "NOT_FOUND", id ? `${entity} ${id} was not found` : `${entity} was not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, field?: string) {
    super(409, "CONFLICT", message, { field });
  }
}

export class DuplicateError extends AppError {
  constructor(entity: string, field: string, value: string) {
    super(409, "DUPLICATE", `A ${entity} with ${field} "${value}" already exists`, { field });
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
      details: { retryAfter: retryAfterSeconds },
    });
  }
}

/* ── Financial domain ────────────────────────────────────────────────────── */

/**
 * These carry enough structure for the UI to render something genuinely useful — the
 * available balance, the shortfall, the approver who is needed — rather than a bare
 * "operation failed" toast.
 */

export class InsufficientBalanceError extends AppError {
  constructor(accountLabel: string, availablePaise: number, requestedPaise: number) {
    super(
      422,
      "INSUFFICIENT_BALANCE",
      `${accountLabel} does not have enough balance for this transaction`,
      {
        field: "amount",
        details: {
          available: availablePaise,
          requested: requestedPaise,
          shortfall: requestedPaise - availablePaise,
        },
      },
    );
  }
}

export class UnbalancedEntryError extends AppError {
  /**
   * The last line of defence in the ledger engine. If this ever reaches a client it means
   * a posting rule produced debits and credits that do not agree, and the transaction was
   * correctly rolled back rather than written.
   */
  constructor(debitPaise: number, creditPaise: number) {
    super(
      500,
      "UNBALANCED_ENTRY",
      "The ledger entries for this transaction do not balance; nothing was posted",
      { details: { debit: debitPaise, credit: creditPaise, difference: debitPaise - creditPaise } },
    );
  }
}

export class PeriodClosedError extends AppError {
  constructor(periodLabel: string, date: Date) {
    super(
      422,
      "PERIOD_CLOSED",
      `The financial period ${periodLabel} is closed, so nothing can be posted on ${date.toISOString().slice(0, 10)}`,
      { field: "date", details: { period: periodLabel } },
    );
  }
}

export class ImmutableTransactionError extends AppError {
  constructor(txnNo: string, status: string) {
    super(
      422,
      "IMMUTABLE_TRANSACTION",
      `${txnNo} is ${status.toLowerCase()} and can no longer be edited. Post a reversal instead.`,
      { details: { txnNo, status } },
    );
  }
}

export class AlreadyReversedError extends AppError {
  constructor(txnNo: string, reversalNo: string) {
    super(422, "ALREADY_REVERSED", `${txnNo} was already reversed by ${reversalNo}`, {
      details: { txnNo, reversalNo },
    });
  }
}

export class ApprovalRequiredError extends AppError {
  constructor(tier: string, thresholdPaise: number) {
    super(
      422,
      "APPROVAL_REQUIRED",
      `This amount requires ${tier.replace("_", " ").toLowerCase()} approval before it can be posted`,
      { details: { tier, threshold: thresholdPaise } },
    );
  }
}

export class CreditLimitExceededError extends AppError {
  constructor(partyName: string, limitPaise: number, wouldBePaise: number) {
    super(422, "CREDIT_LIMIT_EXCEEDED", `This would take ${partyName} past their credit limit`, {
      field: "amount",
      details: { limit: limitPaise, wouldBe: wouldBePaise, excess: wouldBePaise - limitPaise },
    });
  }
}

export class InactiveAccountError extends AppError {
  constructor(label: string) {
    super(422, "ACCOUNT_INACTIVE", `${label} is not active and cannot be used in a transaction`);
  }
}

export class SelfTransferError extends AppError {
  constructor() {
    super(422, "SELF_TRANSFER", "The source and destination accounts must be different", {
      field: "destinationAccountId",
    });
  }
}

export class StateConflictError extends AppError {
  constructor(from: string, to: string) {
    super(
      422,
      "STATE_CONFLICT",
      `A ${from.toLowerCase()} transaction cannot move to ${to.toLowerCase()}`,
      { details: { from, to } },
    );
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** MongoServerError shape for a unique-index violation. */
interface MongoDuplicateKeyError {
  code: number;
  keyValue?: Record<string, unknown>;
}

function isMongoDuplicate(err: unknown): err is MongoDuplicateKeyError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

/**
 * Turn a driver-level duplicate-key error into a user-facing one.
 *
 * Unique indexes are the only race-safe way to enforce "this code is taken", so
 * services attempt the write and translate the failure rather than doing a check-then-write
 * that two concurrent requests can both pass.
 */
export function translateDuplicate(err: unknown, entity: string): AppError | null {
  if (!isMongoDuplicate(err)) return null;
  const key = err.keyValue ? Object.keys(err.keyValue)[0] : undefined;
  const value = key && err.keyValue ? String(err.keyValue[key]) : "";
  return new DuplicateError(entity, key ?? "value", value);
}
