import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
// Named import, not default: pino-http is CommonJS, and under NodeNext its default
// export resolves to the module namespace, which is not callable.
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { errorHandler, notFoundHandler, requestId } from "./middleware/error.js";
import { globalLimiter, sanitizeInput } from "./middleware/security.js";
import { apiRouter } from "./routes.js";

export function createApp(): Express {
  const app = express();

  /**
   * `trust proxy` must be set for `req.ip` to be the real client address behind nginx or
   * a load balancer. It is scoped to one hop rather than `true`: trusting every proxy in
   * the chain lets a client spoof `X-Forwarded-For` and defeat every IP-keyed rate limit.
   */
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestId);

  app.use(
    pinoHttp({
      logger,
      // Reuse the correlation id already assigned by the `requestId` middleware so the
      // access log, the error envelope and every application log line agree.
      genReqId: (req) => (req as { reqId?: string }).reqId ?? "unknown",
      autoLogging: {
        // Health checks would otherwise dominate the log volume.
        ignore: (req) => req.url === "/health" || req.url === "/ready",
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  app.use(
    helmet({
      // The API serves JSON only, so a restrictive CSP costs nothing here and blocks
      // content sniffing on any error page that does get rendered.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
      hsts: env.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  app.use(
    cors({
      // An explicit allowlist, not a reflector. `credentials: true` means the browser
      // sends the refresh cookie, and reflecting an arbitrary Origin alongside that would
      // let any site drive an authenticated session.
      origin(origin, callback) {
        if (!origin) return callback(null, true); // curl, server-to-server, health checks
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        logger.warn({ origin }, "CORS origin rejected");
        return callback(new Error("Origin not allowed by CORS"));
      },
      credentials: true,
      exposedHeaders: ["x-request-id"],
      maxAge: 86_400,
    }),
  );

  app.use(compression());
  // 1 MB is generous for JSON but small enough that a payload bomb cannot exhaust memory.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(cookieParser());
  app.use(sanitizeInput);
  app.use(globalLimiter);

  app.get("/health", (_req, res) => {
    res.json({ success: true, data: { status: "ok", uptime: process.uptime() } });
  });

  app.use(env.API_PREFIX, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
