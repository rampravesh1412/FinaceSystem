import crypto from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import type { ApiFailure } from "@amiri/shared";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { AppError, NotFoundError, ValidationError, translateDuplicate } from "../lib/errors.js";

/** Attach a correlation id to every request; it is echoed on errors and in every log line. */
export const requestId: RequestHandler = (req, res, next) => {
  req.reqId = req.get("x-request-id") ?? crypto.randomUUID();
  req.valid ??= {};
  res.setHeader("x-request-id", req.reqId);
  next();
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl}`));
};

/**
 * The single terminal error handler (§56).
 *
 * Everything that can go wrong lands here and leaves as the documented failure envelope.
 * The critical property: an unrecognised error is logged in full, with its stack, and
 * returned as a bare 500 carrying only a request id. A stack trace, a Mongo error string
 * or a driver message never crosses the wire — those leak collection names, index shapes
 * and file paths, which is reconnaissance handed to an attacker for free.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestIdValue = req.reqId;

  // ── Expected: a business rule declined ────────────────────────────────────
  if (err instanceof AppError) {
    logger.info(
      { requestId: requestIdValue, code: err.code, status: err.status, path: req.originalUrl },
      err.message,
    );
    const body: ApiFailure = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.field ? { field: err.field } : {}),
        ...(err.details !== undefined ? { details: err.details } : {}),
        requestId: requestIdValue,
      },
    };
    res.status(err.status).json(body);
    return;
  }

  // ── Zod, if a schema was parsed outside the validate middleware ───────────
  if (err instanceof ZodError) {
    const wrapped = new ValidationError(
      "Please correct the highlighted fields",
      err.issues.map((i) => ({ field: i.path.join("."), message: i.message, code: i.code })),
    );
    res.status(wrapped.status).json({
      success: false,
      error: {
        code: wrapped.code,
        message: wrapped.message,
        details: wrapped.details,
        requestId: requestIdValue,
      },
    } satisfies ApiFailure);
    return;
  }

  // ── Mongoose document validation ──────────────────────────────────────────
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.entries(err.errors).map(([field, e]) => ({
      field,
      message: e.message,
      code: "invalid",
    }));
    res.status(422).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Please correct the highlighted fields",
        field: details[0]?.field,
        details,
        requestId: requestIdValue,
      },
    } satisfies ApiFailure);
    return;
  }

  // ── A malformed ObjectId in the path is a 404, not a 500 ──────────────────
  if (err instanceof mongoose.Error.CastError) {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "That record was not found", requestId: requestIdValue },
    } satisfies ApiFailure);
    return;
  }

  // ── Unique index violation ────────────────────────────────────────────────
  const duplicate = translateDuplicate(err, "record");
  if (duplicate) {
    res.status(duplicate.status).json({
      success: false,
      error: {
        code: duplicate.code,
        message: duplicate.message,
        field: duplicate.field,
        requestId: requestIdValue,
      },
    } satisfies ApiFailure);
    return;
  }

  // ── Malformed JSON body ───────────────────────────────────────────────────
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({
      success: false,
      error: {
        code: "INVALID_INPUT",
        message: "The request body is not valid JSON",
        requestId: requestIdValue,
      },
    } satisfies ApiFailure);
    return;
  }

  // ── Unexpected: a bug ─────────────────────────────────────────────────────
  logger.error(
    {
      requestId: requestIdValue,
      err,
      path: req.originalUrl,
      method: req.method,
      userId: req.auth?.userId,
    },
    "unhandled error",
  );

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong at our end. Quote the reference below if you contact support.",
      // The real error is exposed in development only, and never in production.
      ...(env.isProd ? {} : { details: { message: (err as Error)?.message, stack: (err as Error)?.stack } }),
      requestId: requestIdValue,
    },
  } satisfies ApiFailure);
};
