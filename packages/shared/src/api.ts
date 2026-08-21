/**
 * The wire contract.
 *
 * Every endpoint returns one of exactly two shapes. The web client's fetch wrapper
 * unwraps them centrally, so no feature ever writes `if (res.data.data)`.
 */

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
  meta?: PageMeta & Record<string, unknown>;
}

export interface ApiFieldError {
  field: string;
  message: string;
  code?: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    details?: unknown;
    /** Correlation id, also emitted in the server log line. Shown in the UI toast so a
     *  user can quote it in a support ticket and it can be grepped straight out of logs. */
    requestId?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function isApiFailure<T>(r: ApiResponse<T>): r is ApiFailure {
  return r.success === false;
}

/**
 * Machine-readable error codes.
 *
 * The client switches on these, never on `message`. Messages are for humans and are
 * expected to change; codes are part of the contract.
 */
export const ERROR_CODES = {
  // 400 / 422
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  DUPLICATE: "DUPLICATE",

  // 401 / 403
  UNAUTHENTICATED: "UNAUTHENTICATED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_INVALID: "TOKEN_INVALID",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  FORBIDDEN: "FORBIDDEN",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  BRANCH_ACCESS_DENIED: "BRANCH_ACCESS_DENIED",

  // 404 / 409
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  STATE_CONFLICT: "STATE_CONFLICT",

  // Financial domain — these drive specific UI treatment, not just a toast
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  UNBALANCED_ENTRY: "UNBALANCED_ENTRY",
  PERIOD_CLOSED: "PERIOD_CLOSED",
  IMMUTABLE_TRANSACTION: "IMMUTABLE_TRANSACTION",
  ALREADY_REVERSED: "ALREADY_REVERSED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  CREDIT_LIMIT_EXCEEDED: "CREDIT_LIMIT_EXCEEDED",
  ACCOUNT_INACTIVE: "ACCOUNT_INACTIVE",
  SELF_TRANSFER: "SELF_TRANSFER",

  // 429 / 5xx
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/* -------------------------------------------------------------------------- */
/* Query conventions                                                          */
/* -------------------------------------------------------------------------- */

export interface ListQuery {
  page?: number;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
  q?: string;
}

/** The global financial filter set (§64). Serialised into the URL on every list view. */
export interface FinanceFilters extends ListQuery {
  from?: string;
  to?: string;
  branchId?: string;
  accountId?: string;
  bankAccountId?: string;
  partyId?: string;
  type?: string;
  paymentMode?: string;
  status?: string;
  createdBy?: string;
  minAmount?: number;
  maxAmount?: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
