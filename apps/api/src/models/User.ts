import { Schema, model, type Document, type Model, type Types } from "mongoose";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { RECORD_STATUS, type RecordStatus } from "@amiri/shared";
import { actorField, baseSchemaOptions } from "./fields.js";
import { env } from "../config/env.js";

/**
 * Argon2id parameters.
 *
 * OWASP's current baseline: 19 MiB memory, 2 iterations, 1 degree of parallelism.
 * Argon2id is chosen over bcrypt because it is memory-hard — a GPU or ASIC cannot
 * parallelise it cheaply the way it can bcrypt. `@node-rs/argon2` ships prebuilt native
 * binaries, so there is no node-gyp toolchain requirement on a developer's machine.
 */
const ARGON_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface UserDoc extends Document<Types.ObjectId> {
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  roleId: Types.ObjectId;
  branchIds: Types.ObjectId[];
  defaultBranchId?: Types.ObjectId | null;
  designation?: string;
  avatarUrl?: string;
  status: RecordStatus;

  mustChangePassword: boolean;
  passwordChangedAt?: Date;
  lastLoginAt?: Date;
  lastLoginIp?: string;

  failedLoginAttempts: number;
  lockedUntil?: Date | null;

  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;

  setPassword(plain: string): Promise<void>;
  verifyPassword(plain: string): Promise<boolean>;
  isLocked(): boolean;
  registerFailedLogin(): Promise<Date | null>;
  registerSuccessfulLogin(ip: string): Promise<void>;
}

export interface UserModel extends Model<UserDoc> {
  hashPassword(plain: string): Promise<string>;
}

const userSchema = new Schema<UserDoc, UserModel>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 160,
    },
    phone: { type: String, trim: true },

    /**
     * `select: false` — the hash is never loaded unless a query explicitly asks for it.
     *
     * This is defence in depth on top of the `toJSON` hidden-path list: even a route that
     * forgets to serialise properly and dumps the raw document cannot leak the hash,
     * because it was never in memory.
     */
    passwordHash: { type: String, required: true, select: false },

    roleId: { type: Schema.Types.ObjectId, ref: "Role", required: true, index: true },

    /**
     * The branches this user can see.
     *
     * The authorization layer turns this directly into `{ branchId: { $in: branchIds } }`.
     * An empty array for a scoped user means they see nothing — fail closed, which is the
     * correct default for a freshly created account awaiting assignment.
     */
    branchIds: [{ type: Schema.Types.ObjectId, ref: "Branch", index: true }],
    defaultBranchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },

    designation: { type: String, trim: true, maxlength: 80 },
    avatarUrl: { type: String, trim: true },

    status: {
      type: String,
      enum: Object.values(RECORD_STATUS),
      default: RECORD_STATUS.ACTIVE,
      index: true,
    },

    mustChangePassword: { type: Boolean, default: true },
    passwordChangedAt: { type: Date },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String },

    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    createdBy: actorField(),
    updatedBy: actorField(),
  },
  baseSchemaOptions(["passwordHash", "failedLoginAttempts", "lockedUntil"]),
);

userSchema.index({ name: "text", email: "text" }, { name: "user_search" });
userSchema.index({ status: 1, roleId: 1 });

/* ── Password ────────────────────────────────────────────────────────────── */

userSchema.statics.hashPassword = function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
};

userSchema.methods.setPassword = async function setPassword(plain: string): Promise<void> {
  this.passwordHash = await argonHash(plain, ARGON_OPTIONS);
  this.passwordChangedAt = new Date();
  this.failedLoginAttempts = 0;
  this.lockedUntil = null;
};

userSchema.methods.verifyPassword = async function verifyPassword(
  plain: string,
): Promise<boolean> {
  if (!this.passwordHash) return false;
  try {
    return await argonVerify(this.passwordHash, plain);
  } catch {
    // A malformed hash (hand-edited in the shell, or from a failed migration) must read
    // as "wrong password", never as an exception that reveals the account exists.
    return false;
  }
};

/* ── Lockout ─────────────────────────────────────────────────────────────── */

userSchema.methods.isLocked = function isLocked(): boolean {
  return Boolean(this.lockedUntil && this.lockedUntil.getTime() > Date.now());
};

/**
 * Record a failed sign-in; returns the lock expiry if this attempt triggered a lock.
 *
 * Uses an atomic `$inc` rather than read-modify-write so a burst of parallel guesses
 * cannot each read "attempts = 4" and all be allowed through.
 */
userSchema.methods.registerFailedLogin = async function registerFailedLogin(): Promise<Date | null> {
  const UserRef = this.constructor as UserModel;
  const attempts = this.failedLoginAttempts + 1;
  const shouldLock = attempts >= env.LOGIN_MAX_ATTEMPTS;
  const lockedUntil = shouldLock
    ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000)
    : null;

  await UserRef.updateOne(
    { _id: this._id },
    shouldLock
      ? { $set: { failedLoginAttempts: 0, lockedUntil } }
      : { $inc: { failedLoginAttempts: 1 } },
  );

  return lockedUntil;
};

userSchema.methods.registerSuccessfulLogin = async function registerSuccessfulLogin(
  ip: string,
): Promise<void> {
  const UserRef = this.constructor as UserModel;
  await UserRef.updateOne(
    { _id: this._id },
    { $set: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip } },
  );
};

export const User = model<UserDoc, UserModel>("User", userSchema);
