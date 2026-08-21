import type { RequestHandler } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { ValidationError } from "../lib/errors.js";

/**
 * Zod request validation.
 *
 * Parsed output is written to `req.valid`, never back onto `req.body`/`req.query`. Two
 * reasons: in Express 5 `req.query` is a getter and cannot be reassigned, and keeping the
 * raw and parsed values separate makes it obvious in a handler which one is trusted.
 * Handlers read `req.valid.body`; nothing reads `req.body` directly.
 */

export interface ValidationTargets {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function formatIssues(error: ZodError): Array<{ field: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "_",
    message: issue.message,
    code: issue.code,
  }));
}

export function validate(targets: ValidationTargets): RequestHandler {
  return (req, _res, next) => {
    req.valid ??= {};

    try {
      if (targets.params) req.valid.params = targets.params.parse(req.params);
      if (targets.query) req.valid.query = targets.query.parse(req.query);
      if (targets.body) req.valid.body = targets.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = formatIssues(err);
        // Surface the first field so a simple client can highlight one input without
        // walking `details`.
        next(new ValidationError("Please correct the highlighted fields", issues, issues[0]?.field));
        return;
      }
      next(err);
    }
  };
}

/* Typed accessors — these keep the `unknown` cast in exactly one place. */

export function body<T extends ZodTypeAny>(req: { valid: { body?: unknown } }): z.infer<T> {
  return req.valid.body as z.infer<T>;
}

export function query<T extends ZodTypeAny>(req: { valid: { query?: unknown } }): z.infer<T> {
  return req.valid.query as z.infer<T>;
}

export function params<T extends ZodTypeAny>(req: { valid: { params?: unknown } }): z.infer<T> {
  return req.valid.params as z.infer<T>;
}
