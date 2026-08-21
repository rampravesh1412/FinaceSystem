import type { ApiFailure, ApiResponse, ErrorCode, PageMeta } from "@amiri/shared";

/**
 * The HTTP client.
 *
 * Three responsibilities, all centralised so no feature has to think about them:
 *
 *   1. Unwrap the `{ success, data }` envelope, so a hook receives `T`, not a wrapper.
 *   2. Turn a failure envelope into a typed `ApiError` that a component can switch on.
 *   3. Refresh a expired access token transparently, once, and replay the request.
 *
 * The access token is held in memory only — never localStorage. A token in localStorage
 * is readable by any injected script; keeping it in a module closure means an XSS has to
 * exfiltrate it during the page's lifetime rather than simply reading it back later. The
 * durable credential is the httpOnly refresh cookie, which JavaScript cannot touch at all.
 */

const BASE = "/api/v1";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly field?: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, payload: ApiFailure["error"]) {
    super(payload.message);
    this.name = "ApiError";
    this.status = status;
    this.code = payload.code;
    this.field = payload.field;
    this.details = payload.details;
    this.requestId = payload.requestId;
  }

  /** Field-level messages, for feeding straight into React Hook Form's `setError`. */
  get fieldErrors(): Array<{ field: string; message: string }> {
    if (!Array.isArray(this.details)) return [];
    return (this.details as Array<{ field?: string; message?: string }>)
      .filter((d) => d.field && d.message)
      .map((d) => ({ field: d.field!, message: d.message! }));
  }
}

/* ── Token store ─────────────────────────────────────────────────────────── */

let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Registered by the auth provider so a hard 401 can bounce the user to sign-in. */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

/* ── Refresh coordination ────────────────────────────────────────────────── */

/**
 * A single in-flight refresh, shared by every caller.
 *
 * Without this, a dashboard that fires eight parallel queries on mount would, on an
 * expired token, trigger eight simultaneous refreshes. Because refresh tokens rotate and
 * reuse is treated as theft, the second one through would look like an attack and revoke
 * the whole session family — logging the user out for the crime of loading a page.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as ApiResponse<{ accessToken: string }>;
      if (!body.success) return false;
      accessToken = body.data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so concurrent callers all observe the same result first.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

/* ── Request ─────────────────────────────────────────────────────────────── */

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: prevents a refresh loop when the refresh itself is what failed. */
  _retried?: boolean;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

async function rawRequest<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    credentials: "same-origin",
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (res.status === 204) return { success: true, data: undefined as T };

  let body: ApiResponse<T>;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(res.status, {
      code: "INTERNAL_ERROR",
      message: `The server returned an unreadable response (HTTP ${res.status})`,
    });
  }

  if (!res.ok || body.success === false) {
    const failure = (body as ApiFailure).error ?? {
      code: "INTERNAL_ERROR" as ErrorCode,
      message: `Request failed with status ${res.status}`,
    };
    throw new ApiError(res.status, failure);
  }

  return body;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    const body = await rawRequest<T>(path, options);
    return (body as { data: T }).data;
  } catch (err) {
    const isExpired =
      err instanceof ApiError && err.status === 401 && err.code === "TOKEN_EXPIRED";

    if (isExpired && !options._retried && !path.startsWith("/auth/refresh")) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return request<T>(path, { ...options, _retried: true });
    }

    if (err instanceof ApiError && err.status === 401) {
      accessToken = null;
      onUnauthenticated?.();
    }

    throw err;
  }
}

/** A list endpoint, returning items alongside their pagination meta. */
export async function requestList<T>(
  path: string,
  options: RequestOptions = {},
): Promise<Paginated<T>> {
  const body = await rawRequest<T[]>(path, options);
  const success = body as { data: T[]; meta?: PageMeta };
  return {
    items: success.data,
    meta: success.meta ?? {
      page: 1,
      limit: success.data.length,
      total: success.data.length,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
  };
}

export const api = {
  get: <T>(path: string, o?: RequestOptions) => request<T>(path, { ...o, method: "GET" }),
  list: <T>(path: string, o?: RequestOptions) => requestList<T>(path, { ...o, method: "GET" }),
  post: <T>(path: string, body?: unknown, o?: RequestOptions) =>
    request<T>(path, { ...o, method: "POST", body }),
  put: <T>(path: string, body?: unknown, o?: RequestOptions) =>
    request<T>(path, { ...o, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, o?: RequestOptions) =>
    request<T>(path, { ...o, method: "PATCH", body }),
  del: <T>(path: string, o?: RequestOptions) => request<T>(path, { ...o, method: "DELETE" }),
  refresh: refreshAccessToken,
};

/**
 * Serialise filters into a query string, dropping empties.
 *
 * `undefined`, `""` and the UI's `"all"` sentinel are all omitted rather than sent, so a
 * cleared filter produces `/branches` and not `/branches?status=&branchId=all`, which the
 * server would have to interpret and which pollutes the shareable URL.
 */
export function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === "all") continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}
