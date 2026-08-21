import { describe, expect, it } from "vitest";
import { password as passwordSchema } from "@amiri/shared";
import { generatePassword } from "./password";

/**
 * Temporary password generation (§40).
 *
 * Used both when inviting a user and when an administrator resets a forgotten password.
 * The second is the one that matters: it is the path taken when somebody has actually lost
 * access, often over the phone, and a predictable credential there is a real weakness
 * rather than a theoretical one.
 *
 * The generator draws one character from each required class before filling the rest and
 * shuffling, so it cannot fail the complexity rule by chance — which would otherwise leave
 * an administrator working around a validation error at exactly the wrong moment.
 */
describe("generatePassword", () => {
  it("always satisfies the schema the server validates against", () => {
    // A hundred draws: a generator that fails one time in fifty would otherwise look fine
    // in a handful of manual checks and bite during a real reset.
    for (let i = 0; i < 100; i += 1) {
      const result = passwordSchema.safeParse(generatePassword());
      expect(result.success, `attempt ${i}: ${result.success ? "" : result.error.issues[0]?.message}`).toBe(true);
    }
  });

  it("includes every required character class", () => {
    for (let i = 0; i < 50; i += 1) {
      const pw = generatePassword();
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/\d/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it("does not place the guaranteed classes in fixed positions", () => {
    // Without the shuffle the first four characters would always be upper/lower/digit/
    // symbol in that order — a meaningful reduction in what an attacker has to guess.
    const firsts = new Set(Array.from({ length: 60 }, () => generatePassword()[0]));
    expect(firsts.size).toBeGreaterThan(3);
  });

  it("produces a different password every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });

  it("omits characters that are misread when a password is read aloud", () => {
    // These credentials are dictated over a phone. O/0 and l/1/I are where that goes wrong.
    const joined = Array.from({ length: 100 }, () => generatePassword()).join("");
    expect(joined).not.toMatch(/[O0lI1]/);
  });
});
