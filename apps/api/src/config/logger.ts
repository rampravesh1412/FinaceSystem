import pino from "pino";
import { env } from "./env.js";

/**
 * Structured logging.
 *
 * Pretty and human-readable in development; newline-delimited JSON in production so it
 * can be shipped straight into a log aggregator. The redaction list is not optional —
 * an access log that captures an Authorization header or a request body containing a
 * password has turned the log store into a credential store.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "amiri-api", env: env.NODE_ENV },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.password",
      "*.newPassword",
      "*.currentPassword",
      "*.confirmPassword",
      "*.passwordHash",
      "*.refreshToken",
      "*.accessToken",
      "*.accountNumber",
      "body.password",
      "body.newPassword",
      "body.currentPassword",
    ],
    censor: "[redacted]",
  },
  ...(env.isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname,service,env",
            messageFormat: "{msg}",
          },
        },
      }),
});

export type Logger = typeof logger;
