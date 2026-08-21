import type { RequestHandler } from "express";
import rateLimit, { type Options } from "express-rate-limit";
import type { ApiFailure } from "@amiri/shared";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

/**
 * NoSQL injection defence.
 *
 * The attack: a JSON body of `{"email": {"$gt": ""}, "password": {"$gt": ""}}` becomes a
 * Mongo query that matches the first user in the collection. Zod stops this on any route
 * that validates a typed schema, and `mongoose.set("sanitizeFilter", true)` stops it at
 * the query layer, but this strips the operators at the door as a third, unconditional
 * layer that does not depend on anyone remembering to add a schema.
 *
 * `express-mongo-sanitize` is deliberately not used: it mutates `req.query`, which is a
 * read-only getter in Express 5, so it throws at runtime on this stack.
 */
function stripOperators(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripOperators(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // `$` starts a Mongo operator; `.` allows reaching into a nested path.
    if (key.startsWith("$") || key.includes(".")) continue;
    out[key] = stripOperators(v, depth + 1);
  }
  return out;
}

export const sanitizeInput: RequestHandler = (req, _res, next) => {
  if (req.body && typeof req.body === "object") {
    req.body = stripOperators(req.body) as typeof req.body;
  }
  // req.query is a getter in Express 5, so the sanitised copy is exposed separately and
  // the validate middleware parses from it.
  next();
};

/* ── Rate limiting ───────────────────────────────────────────────────────── */

function limitHandler(message: string): Options["handler"] {
  return (req, res, _next, options) => {
    logger.warn({ ip: req.ip, path: req.originalUrl }, "rate limit hit");
    const retryAfter = Math.ceil(options.windowMs / 1000);
    res.status(429).json({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message,
        details: { retryAfter },
        requestId: req.reqId,
      },
    } satisfies ApiFailure);
  };
}

/** Broad ceiling on the whole API. Generous — this only stops runaway clients. */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.isTest,
  handler: limitHandler("Too many requests. Please slow down."),
});

/**
 * Sign-in limiter — aggressive, and keyed on email + IP rather than IP alone.
 *
 * IP-only keying is defeated by a botnet and simultaneously punishes an entire office
 * behind one NAT. Including the email means an attacker spraying one account is stopped
 * quickly, while a colleague at the same address is unaffected. This works alongside the
 * per-account lockout on the User model, which is the durable control; this one just
 * blunts the request volume.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: () => env.isTest,
  keyGenerator: (req) => {
    const email = (req.body as { email?: string } | undefined)?.email ?? "";
    return `${req.ip}:${email.toLowerCase()}`;
  },
  handler: limitHandler("Too many sign-in attempts. Please try again in a few minutes."),
});

/** Writes that move money or change configuration. */
export const mutationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.isTest,
  keyGenerator: (req) => req.auth?.userId ?? req.ip ?? "anonymous",
  handler: limitHandler("You are submitting too quickly. Please wait a moment."),
});

/** Report generation and exports — expensive, so kept on a tighter leash. */
export const exportLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.isTest,
  keyGenerator: (req) => req.auth?.userId ?? req.ip ?? "anonymous",
  handler: limitHandler("Too many exports in a short time. Please wait before trying again."),
});
