import { Schema, model, type Document, type Types } from "mongoose";
import { DIRECTION, type Direction, type TransactionType } from "@amiri/shared";
import { businessDateField, moneyField } from "./fields.js";

/**
 * A ledger entry — one line of one journal posting.
 *
 * IMMUTABLE AND APPEND-ONLY. This is the single most important invariant in the system.
 * Once written, an entry is never updated and never deleted. A mistake is corrected by
 * posting a reversal that cancels it, leaving both visible forever. That is what makes
 * "explain this balance" answerable: the balance is the sum of a list nobody can edit.
 *
 * `amount` is ALWAYS POSITIVE. Direction is carried by `direction`, not by a sign. Mixing
 * the two conventions is how ledgers end up double-counting: a negative credit is
 * ambiguous, a `CREDIT 500` is not.
 */
export interface LedgerEntryDoc extends Document<Types.ObjectId> {
  transactionId: Types.ObjectId;
  txnNo: string;
  transactionType: TransactionType;

  ledgerAccountId: Types.ObjectId;
  branchId: Types.ObjectId;

  date: Date;
  direction: Direction;
  amount: number;

  /**
   * The account's balance immediately after this entry, signed against its normal side.
   *
   * Stored so a statement can show a running balance column without recomputing a sum
   * over every prior entry for each row — which on a party with 20,000 entries would be
   * quadratic. Correct only when entries are read in posting order.
   */
  runningBalance: number;

  narration?: string;
  /** Names of the other accounts in the same posting: "paid to whom", at a glance. */
  contra?: string[];

  /** Set when a bank reconciliation has matched this entry to a statement line. */
  reconciledAt?: Date | null;
  reconciliationId?: Types.ObjectId | null;

  createdBy?: Types.ObjectId;
  createdAt: Date;
}

const ledgerEntrySchema = new Schema<LedgerEntryDoc>(
  {
    // Indexed below via `schema.index()`, not here — declaring both produces a duplicate
    // index and a Mongoose warning at boot.
    transactionId: { type: Schema.Types.ObjectId, ref: "Transaction", required: true },
    /** Denormalised so a statement row can show the voucher number without a join. */
    txnNo: { type: String, required: true, index: true },
    transactionType: { type: String, required: true },

    ledgerAccountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },

    date: businessDateField(true),
    direction: { type: String, enum: Object.values(DIRECTION), required: true },
    amount: moneyField({ required: true, positive: true }),
    runningBalance: moneyField({ default: 0 }),

    narration: { type: String, trim: true, maxlength: 500 },
    contra: { type: [String], default: undefined },

    reconciledAt: { type: Date, default: null },
    reconciliationId: { type: Schema.Types.ObjectId, ref: "Reconciliation", default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

/**
 * APPEND-ONLY ENFORCEMENT.
 *
 * As with AuditLog, this cannot stop a mongo shell — the durable guarantee is a database
 * role granting only `insert` and `find` on this collection. What it does guarantee is
 * that no application code path, present or future, can mutate a posted entry by
 * accident or through a generic helper.
 *
 * The one sanctioned exception is reconciliation, which sets `reconciledAt` and does not
 * touch a single financial field. It goes through `markReconciled()` below, which is the
 * only escape hatch and is deliberately narrow.
 */
const RECONCILIATION_ONLY = new Set(["reconciledAt", "reconciliationId"]);

function isReconciliationOnlyUpdate(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;
  const set = (update as { $set?: Record<string, unknown> }).$set;
  const keys = Object.keys(set ?? {});
  return keys.length > 0 && keys.every((k) => RECONCILIATION_ONLY.has(k));
}

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"] as const) {
  ledgerEntrySchema.pre(op, function guardUpdate(next) {
    if (isReconciliationOnlyUpdate(this.getUpdate())) {
      next();
      return;
    }
    next(
      new Error(
        "LedgerEntry is immutable. A posted entry cannot be edited — reverse the " +
          "transaction instead, which posts a cancelling entry and leaves both on the record.",
      ),
    );
  });
}

for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  ledgerEntrySchema.pre(op, function guardDelete(next) {
    next(
      new Error(
        "LedgerEntry is append-only. Deleting an entry would destroy the audit trail and " +
          "silently change a balance nobody could then explain.",
      ),
    );
  });
}

ledgerEntrySchema.pre("save", function guardSave(next) {
  if (!this.isNew) {
    const touched = this.modifiedPaths();
    if (touched.every((p) => RECONCILIATION_ONLY.has(p))) {
      next();
      return;
    }
    next(new Error("LedgerEntry is immutable. Reverse the transaction instead of editing it."));
    return;
  }
  next();
});

/**
 * Indexes.
 *
 * `{ ledgerAccountId, date, _id }` is the workhorse — it serves the account statement,
 * the running-balance read, the party ledger and the balance aggregation. `_id` is the
 * tiebreaker so two entries on the same date always page in a stable, reproducible order;
 * without it, page 2 of a statement can repeat a row from page 1.
 */
ledgerEntrySchema.index({ ledgerAccountId: 1, date: 1, _id: 1 });
ledgerEntrySchema.index({ branchId: 1, date: -1, _id: -1 });
ledgerEntrySchema.index({ transactionId: 1 });
ledgerEntrySchema.index({ ledgerAccountId: 1, reconciledAt: 1 }); // unreconciled lookup

export const LedgerEntry = model<LedgerEntryDoc>("LedgerEntry", ledgerEntrySchema);
