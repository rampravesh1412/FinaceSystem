import { describe, expect, it } from "vitest";
import { booleanFlag } from "./common.js";

/**
 * Query-string booleans.
 *
 * `z.coerce.boolean()` is JS truthiness, so the STRING `"false"` parses as `true`. Every
 * boolean flag in the application was wrong in the same direction: a switch turned off sent
 * `?includeInactive=false`, the server read it as on, and the filter silently did not
 * filter. Nothing errored — the results were simply not what was asked for.
 */
describe("booleanFlag", () => {
  it('reads "false" as false — the case z.coerce.boolean() gets wrong', () => {
    expect(booleanFlag.parse("false")).toBe(false);
    expect(booleanFlag.parse("0")).toBe(false);
    expect(booleanFlag.parse("no")).toBe(false);
    expect(booleanFlag.parse("off")).toBe(false);
  });

  it("reads the affirmative words as true", () => {
    expect(booleanFlag.parse("true")).toBe(true);
    expect(booleanFlag.parse("1")).toBe(true);
    expect(booleanFlag.parse("yes")).toBe(true);
    expect(booleanFlag.parse("on")).toBe(true);
  });

  it("is case- and whitespace-insensitive, as a URL is in practice", () => {
    expect(booleanFlag.parse("FALSE")).toBe(false);
    expect(booleanFlag.parse(" True ")).toBe(true);
  });

  it("passes real booleans through, for JSON bodies", () => {
    expect(booleanFlag.parse(true)).toBe(true);
    expect(booleanFlag.parse(false)).toBe(false);
  });

  it("rejects a value that means neither, rather than guessing", () => {
    // "maybe" as true would be the same class of silent wrongness this replaces.
    expect(booleanFlag.safeParse("maybe").success).toBe(false);
  });

  it("leaves absent absent, so .optional() and .default() behave as written", () => {
    expect(booleanFlag.optional().parse(undefined)).toBeUndefined();
    expect(booleanFlag.default(false).parse(undefined)).toBe(false);
  });
});
