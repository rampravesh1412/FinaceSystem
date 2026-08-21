import { Schema, model, type ClientSession, type Document } from "mongoose";

/**
 * `Document<string>` — the `_id` here is a human-readable composite key such as
 * `"PAY-IN:2026"`, not an ObjectId. Using the natural key as the primary key is what
 * makes the upsert-and-increment a single atomic operation with no lookup first.
 */
export interface CounterDoc extends Document<string> {
  _id: string;
  seq: number;
}

/**
 * Gap-free sequential numbering (§36).
 *
 * One document per {prefix, fiscal year}, incremented with a single atomic
 * `findOneAndUpdate($inc, upsert)`. Two concurrent payments cannot receive the same
 * number: the increment happens inside the database, not in application memory.
 *
 * Why not an ObjectId or a UUID for document numbers — because an accountant has to read
 * "PAY-IN-2026-000123" aloud on the phone, quote it on a cheque, and match it against a
 * bank statement. Sequence gaps also matter: in an audited book, a missing number is a
 * question that has to be answered, so the sequence must not skip.
 */
const counterSchema = new Schema<CounterDoc>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

export const Counter = model<CounterDoc>("Counter", counterSchema);

/**
 * Reserve the next number in a sequence.
 *
 * MUST be called with the same session as the transaction it is numbering. If the
 * transaction rolls back, the reservation rolls back with it and the number is reused —
 * which is what keeps the sequence gap-free.
 *
 *   nextSequence("PAY-IN", 2026, session) -> 123
 */
export async function nextSequence(
  scope: string,
  fiscalYear: number,
  session?: ClientSession,
): Promise<number> {
  const key = `${scope}:${fiscalYear}`;
  const doc = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session, setDefaultsOnInsert: true },
  ).lean();

  if (!doc) throw new Error(`Failed to reserve a sequence number for ${key}`);
  return doc.seq;
}

/** Peek without consuming. For previewing "the next voucher will be …" in a form. */
export async function peekSequence(scope: string, fiscalYear: number): Promise<number> {
  const doc = await Counter.findById(`${scope}:${fiscalYear}`).lean();
  return (doc?.seq ?? 0) + 1;
}
