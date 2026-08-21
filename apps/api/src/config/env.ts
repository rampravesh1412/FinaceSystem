import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

/**
 * Environment validation.
 *
 * The process refuses to start on a bad or missing variable rather than discovering it
 * at 2am when the first refresh token fails to verify. Everything downstream imports the
 * frozen, typed `env` object — `process.env` is never read again anywhere in the app.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_PREFIX: z.string().default("/api/v1"),

    MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
    MONGODB_DB_NAME: z.string().default("amiri_finance"),

    /**
     * Separate secrets for access and refresh tokens.
     *
     * Sharing one secret means a leaked access token can be replayed as a refresh token.
     * 32 chars is the enforced floor; the seed script prints a generator command.
     */
    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    JWT_ACCESS_TTL: z.string().default("15m"),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

    /** Comma-separated allowlist. No wildcard in production — credentials are sent. */
    CORS_ORIGINS: z.string().default("http://localhost:5173"),
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: z.coerce.boolean().default(false),

    /** Failed logins before the account is locked, and for how long. */
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    /** Where uploaded attachments land. Local disk in dev, an S3 URL prefix in prod. */
    UPLOAD_DIR: z.string().default("./uploads"),
    PUBLIC_URL: z.string().default("http://localhost:4000"),

    /** Organisation identity, printed on every PDF report header. */
    ORG_NAME: z.string().default("AMIRI Finance"),
    ORG_CURRENCY: z.string().default("INR"),
    /** Fiscal year start month, 1-12. India runs April–March. */
    FISCAL_YEAR_START_MONTH: z.coerce.number().int().min(1).max(12).default(4),
  })
  .superRefine((v, ctx) => {
    if (v.JWT_ACCESS_SECRET === v.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_REFRESH_SECRET"],
        message: "The refresh secret must differ from the access secret",
      });
    }
    if (v.NODE_ENV === "production") {
      if (!v.COOKIE_SECURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["COOKIE_SECURE"],
          message: "COOKIE_SECURE must be true in production — the refresh cookie carries a session",
        });
      }
      if (v.CORS_ORIGINS.includes("*")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CORS_ORIGINS"],
          message: "A wildcard CORS origin is not allowed in production",
        });
      }
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`);
  console.error(
    "\n✗ Invalid environment configuration:\n" +
      lines.join("\n") +
      "\n\n  Copy apps/api/.env.example to apps/api/.env and fill it in." +
      "\n  Generate a secret with:  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n",
  );
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test",
  isDev: parsed.data.NODE_ENV === "development",
  corsOrigins: parsed.data.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
});

export type Env = typeof env;
