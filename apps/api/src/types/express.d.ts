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
      /** Branches the user may read. Empty and irrelevant when `isSuperAdmin`. */
      branchIds: string[];
      isSuperAdmin: boolean;
      sessionId: string;
    }

    /**
     * The mandatory branch filter fragment.
     *
     * Produced by `requireBranchAccess` and spread into every branch-scoped query. For a
     * SuperAdmin it is `{}`; for anyone else `{ branchId: { $in: [...] } }`. Repositories
     * take it as a required argument so a query that forgets to scope does not compile.
     */
    interface BranchScope {
      filter: Record<string, unknown>;
      branchIds: Types.ObjectId[];
      isUnscoped: boolean;
      /** The branch selected for this request, when the caller narrowed to one. */
      activeBranchId: Types.ObjectId | null;
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
      scope?: BranchScope;
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
