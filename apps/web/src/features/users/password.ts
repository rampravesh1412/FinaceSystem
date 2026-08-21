/**
 * Temporary password generation.
 *
 * Shared by the invite form and the administrative reset, so the two cannot drift into
 * producing credentials of different strength — the reset path is the one used when
 * somebody has actually lost access, and it is the one that matters most.
 */

/**
 * A temporary password that satisfies the shared `password` schema.
 *
 * Built from `crypto.getRandomValues`, never `Math.random()` — a predictable credential
 * for a finance system is a real weakness, not a theoretical one. One character is drawn
 * from each required class first so the result cannot fail the complexity rule by chance
 * and silently produce a validation error the administrator has to work around.
 */
export function generatePassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "@#$%&*!";
  const all = upper + lower + digits + symbols;

  const pick = (set: string, n = 1) => {
    const bytes = new Uint32Array(n);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => set[b % set.length]).join("");
  };

  const chars = (pick(upper) + pick(lower) + pick(digits) + pick(symbols) + pick(all, 10)).split("");

  // Fisher–Yates, so the guaranteed classes are not always in the first four positions.
  const order = new Uint32Array(chars.length);
  crypto.getRandomValues(order);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = order[i]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join("");
}
