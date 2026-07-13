// Property-based collision test for the canonical-absent sentinel encoding.
//
// Asserts: for any value T drawn from the generator families specified in
// ADR 0006, boundaryHash([[present, value]]) NEVER equals
// boundaryHash([[absent]]). This proves the discriminant byte (0x01 vs 0x00)
// is sufficient to distinguish any present-field from an absent-field, even
// when the value contains Unicode whitespace, zero-width characters, or
// control characters that could have been confused with a sentinel string.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { boundaryHash } from "../src/domain/memory/boundary.js";

// Pre-compute the absent hash once; every property assertion compares against it.
const ABSENT_HASH = boundaryHash([[false]]);

// --- Generator families (ADR 0006 section arch1.01.7) ---

// Unicode whitespace block: U+0009, U+000A, U+0020, U+00A0, U+2000-U+200A,
// U+202F, U+205F, U+3000.
const unicodeWhitespaceCodePoints: string[] = [
  "\u0009", // TAB
  "\u000A", // LF
  "\u0020", // SPACE
  "\u00A0", // NO-BREAK SPACE
  "\u2000", // EN QUAD
  "\u2001", // EM QUAD
  "\u2002", // EN SPACE
  "\u2003", // EM SPACE
  "\u2004", // THREE-PER-EM SPACE
  "\u2005", // FOUR-PER-EM SPACE
  "\u2006", // SIX-PER-EM SPACE
  "\u2007", // FIGURE SPACE
  "\u2008", // PUNCTUATION SPACE
  "\u2009", // THIN SPACE
  "\u200A", // HAIR SPACE
  "\u202F", // NARROW NO-BREAK SPACE
  "\u205F", // MEDIUM MATHEMATICAL SPACE
  "\u3000", // IDEOGRAPHIC SPACE
];

// Zero-width characters: U+200B, U+200C, U+200D, U+FEFF, U+2060.
const zeroWidthCodePoints: string[] = [
  "\u200B", // ZERO WIDTH SPACE
  "\u200C", // ZERO WIDTH NON-JOINER
  "\u200D", // ZERO WIDTH JOINER
  "\uFEFF", // ZERO WIDTH NO-BREAK SPACE / BOM
  "\u2060", // WORD JOINER
];

// Control characters: U+0000-U+001F and U+007F.
const controlCodePoints: string[] = [
  ...Array.from({ length: 32 }, (_, i) => String.fromCodePoint(i)), // U+0000-U+001F
  "\u007F", // DEL
];

function stringOfChars(chars: string[]): fc.Arbitrary<string> {
  // fc.constantFrom picks uniformly from the given characters; fc.string builds
  // arbitrary-length sequences of them.
  const charArb: fc.Arbitrary<string> = fc.constantFrom(...chars);
  return fc.string({ unit: charArb, minLength: 0, maxLength: 20 });
}

// Property helper: asserts that hashing a single present-field with the given
// value never produces the same digest as the absent sentinel.
function assertNeverCollidesWithAbsent(arb: fc.Arbitrary<string>): void {
  fc.assert(
    fc.property(arb, (value) => {
      const presentHash = boundaryHash([[true, value]]);
      expect(presentHash).not.toBe(ABSENT_HASH);
    }),
    { numRuns: 100 },
  );
}

describe("boundaryHash — sentinel collision properties", () => {
  it("Unicode whitespace values never collide with [absent]", () => {
    assertNeverCollidesWithAbsent(stringOfChars(unicodeWhitespaceCodePoints));
  });

  it("zero-width character values never collide with [absent]", () => {
    assertNeverCollidesWithAbsent(stringOfChars(zeroWidthCodePoints));
  });

  it("control character values never collide with [absent]", () => {
    assertNeverCollidesWithAbsent(stringOfChars(controlCodePoints));
  });

  // Extra: empty string — the most common sentinel candidate — must not collide.
  it("empty string as present value never collides with [absent]", () => {
    const presentHash = boundaryHash([[true, ""]]);
    expect(presentHash).not.toBe(ABSENT_HASH);
  });
});

describe("boundaryHash — absent sentinel stability", () => {
  it("returns the same digest on repeated calls with [absent]", () => {
    const h1 = boundaryHash([[false]]);
    const h2 = boundaryHash([[false]]);
    const h3 = boundaryHash([[false]]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    // Must be a valid 64-char sha256 hex string.
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("absent digest is stable against separate CanonicalField tuple constructions", () => {
    const absent1: readonly [present: false] = [false];
    const absent2: readonly [present: false] = [false];
    expect(boundaryHash([absent1])).toBe(boundaryHash([absent2]));
  });
});
