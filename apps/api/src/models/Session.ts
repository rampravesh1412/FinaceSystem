import { Schema, model, type Document, type Types } from "mongoose";

/**
 * One signed-in session — one device, one browser.
 *
 * A user may hold SEVERAL at once. Signing in on a phone does not disturb the session on
 * the counter machine: each login creates its own row with its own rotation family, and
 * nothing here revokes a sibling. That is deliberate — a shared counter where the second
 * sign-in silently kicked out the first would have people quietly losing half-entered
 * vouchers.
 *
 * What DOES revoke every session at once is a change to the credential or the authority
 * behind them: a password change, or a role change. Both are handled by
 * `revokeAllSessions`, and both should take effect everywhere immediately.
 *
 * Each session lasts `JWT_REFRESH_TTL_HOURS` (six hours by default) from the moment it is
 * created, and Mongo's TTL sweep removes the row once `expiresAt` passes.
 */
export interface SessionDoc extends Document<Types.ObjectId> {
  userId: Types.ObjectId;
  /** SHA-256 of the refresh token. The token itself is never stored. */
  tokenHash: string;
  /** Rotation chain id — every refresh issues a new token in the same family. */
  familyId: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedReason?: string;
  /** Set when this token is rotated out, so replay of the old one is detectable. */
  replacedBy?: string;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /**
     * Only a hash is persisted.
     *
     * A refresh token is a bearer credential valid for days. If the sessions collection
     * leaked and held raw tokens, every live session would be hijackable. Hashing means a
     * dump is useless without the token itself, exactly as with passwords — SHA-256 is
     * sufficient here (unlike for passwords) because the token is 48 bytes of CSPRNG
     * output, so there is nothing to brute-force.
     */
    tokenHash: { type: String, required: true, unique: true },

    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String },
    replacedBy: { type: String },
    ip: { type: String },
    userAgent: { type: String, maxlength: 400 },
  },
  { timestamps: true, versionKey: false },
);

/**
 * Expired sessions are removed by MongoDB itself.
 *
 * `expireAfterSeconds: 0` means "delete once `expiresAt` is in the past". Without this
 * the collection grows without bound and every refresh scans more dead rows. The sweep
 * runs about once a minute, so a just-expired token may briefly still exist — the
 * verification path checks `expiresAt` explicitly rather than relying on the sweep.
 */
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1, revokedAt: 1 });

export const Session = model<SessionDoc>("Session", sessionSchema);
