import type { Types } from "mongoose";

declare global {
  namespace Express {
    /** The authenticated principal, resolved once per request by `requireAuth`. */
    interface AuthContext {
      userId: string;
      objectId: Types.ObjectId;
      name: string;
      email: string;
      roleId: string;
      roleName: string;
      permissions: string[];
      isSuperAdmin: boolean;
      sessionId: string;
    }

    interface Request {
      /**
       * Correlation id for this request.
       *
       * Named `reqId` rather than `id` on purpose: `pino-http` globally augments
       * `http.IncomingMessage` with `id: ReqId` (`string | number`), and Express's
       * Request extends it. Declaring our own `id: string` would collide with that and
       * force a cast at every use site. Ours is always a string.
       */
      reqId: string;
      auth?: AuthContext;
      /** Zod-parsed and coerced payloads. Handlers read these, never the raw ones. */
      valid: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
