import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ParamsDictionary, Query as ParsedQs } from "express-serve-static-core";
import type { ApiSuccess, PageMeta } from "@amiri/shared";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@amiri/shared";

/**
 * Response and request helpers.
 *
 * Every controller returns through `ok`, `created` or `paginated`, so the envelope
 * described in ARCHITECTURE §8 is structurally guaranteed rather than remembered.
 */

export function ok<T>(res: Response, data: T, message?: string): Response {
  const body: ApiSuccess<T> = { success: true, data };
  if (message) body.message = message;
  return res.status(200).json(body);
}

export function created<T>(res: Response, data: T, message?: string): Response {
  const body: ApiSuccess<T> = { success: true, data };
  if (message) body.message = message;
  return res.status(201).json(body);
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}

export function paginated<T>(
  res: Response,
  items: T[],
  total: number,
  page: number,
  limit: number,
  extra?: Record<string, unknown>,
): Response {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  const meta: PageMeta & Record<string, unknown> = {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    ...extra,
  };
  const body: ApiSuccess<T[]> = { success: true, data: items, meta };
  return res.status(200).json(body);
}

/**
 * Wrap an async handler so a rejected promise reaches the error middleware.
 *
 * Express 5 forwards rejections on its own, but this stays for two reasons: it keeps the
 * behaviour explicit at each call site, and it means a handler accidentally written
 * against Express 4 semantics still cannot hang the request.
 */
export function asyncHandler<
  // These default to Express's own generic defaults rather than `unknown`. Narrowing
  // them would make the handler's `req` incompatible with any helper that takes a plain
  // `Request`, which is a friction every call site would then have to cast away.
  P = ParamsDictionary,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = ParsedQs,
>(
  fn: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response,
    next: NextFunction,
  ) => Promise<unknown>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next) => {
    void Promise.resolve(fn(req as never, res, next)).catch(next);
  };
}

/** Normalised paging inputs, clamped so a client cannot ask for 10 million rows. */
export interface Paging {
  page: number;
  limit: number;
  skip: number;
  sort: Record<string, 1 | -1>;
}

export function paging(
  query: { page?: unknown; limit?: unknown; sort?: unknown; order?: unknown },
  defaultSort: Record<string, 1 | -1> = { createdAt: -1 },
  allowedSortFields?: string[],
): Paging {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.limit) || DEFAULT_PAGE_SIZE));

  let sort = defaultSort;
  const requested = typeof query.sort === "string" ? query.sort : undefined;
  if (requested) {
    // An allowlist, not a passthrough — an arbitrary sort field lets a caller force a
    // collection scan on an unindexed path and is a cheap denial-of-service.
    const permitted = !allowedSortFields || allowedSortFields.includes(requested);
    if (permitted) {
      sort = { [requested]: query.order === "asc" ? 1 : -1 };
      // Ties must break deterministically or page 2 can repeat a row from page 1.
      if (requested !== "_id") sort._id = query.order === "asc" ? 1 : -1;
    }
  }

  return { page, limit, skip: (page - 1) * limit, sort };
}

/**
 * Escape a user-supplied string before putting it in a `$regex`.
 *
 * Without this, a search for "a(" is a syntax error and a search for
 * "(a+)+$" is a catastrophic-backtracking DoS against the database.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive "contains" filter across several fields. */
export function searchFilter(q: string | undefined, fields: string[]): Record<string, unknown> {
  if (!q || !q.trim() || fields.length === 0) return {};
  const rx = new RegExp(escapeRegex(q.trim()), "i");
  return { $or: fields.map((f) => ({ [f]: rx })) };
}

/** The client's real IP, honouring the proxy chain only when `trust proxy` is set. */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
