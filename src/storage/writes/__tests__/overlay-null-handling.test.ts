import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildOverlayKey,
  decideOverlayOutcome,
  shouldEngageOverlay,
} from "../overlay-supersession.js";

describe("overlay null-handling — (factKey, continuitySubjectKey) bypass rules", () => {
  it("both-null rows skip overlay entirely (engageOverlay false; row writes straight to durable store)", () => {
    expect(shouldEngageOverlay(null, null)).toBe(false);
    expect(shouldEngageOverlay(undefined, undefined)).toBe(false);
    expect(buildOverlayKey(null, null)).toBeNull();
    expect(buildOverlayKey(undefined, undefined)).toBeNull();

    // Decision on the both-null path returns 'create' with explicit bypass reason —
    // the caller MUST route through the arbitrator, not through any overlay dedupe.
    const decision = decideOverlayOutcome({
      factKey: null,
      continuitySubjectKey: null,
      existing: { id: "mem-1", text: "any prior memory" },
      incomingText: "incoming text",
    });
    expect(decision.outcome).toBe("create");
    expect(decision.reason).toContain("overlay disengaged");
  });

  it("either-null rows treated as distinct — no overlay dedupe", () => {
    expect(shouldEngageOverlay(null, "subject-1")).toBe(false);
    expect(shouldEngageOverlay("fact-1", null)).toBe(false);
    expect(shouldEngageOverlay(undefined, "subject-1")).toBe(false);
    expect(shouldEngageOverlay("fact-1", undefined)).toBe(false);
  });

  it("both-non-null rows engage overlay (lock + dedupe normally)", () => {
    expect(shouldEngageOverlay("fact-1", "subject-1")).toBe(true);
    const decision = decideOverlayOutcome({
      factKey: "fact-1",
      continuitySubjectKey: "subject-1",
      existing: { id: "mem-1", text: "Use VS Code" },
      incomingText: "Use VS Code",
    });
    expect(decision.outcome).toBe("skip");
  });

  it("empty-string-after-trim treated as absent per ADR 0006 (whitespace-only collapses to absent)", () => {
    expect(shouldEngageOverlay("", "subject-1")).toBe(false);
    expect(shouldEngageOverlay("   ", "subject-1")).toBe(false);
    expect(shouldEngageOverlay("fact-1", "")).toBe(false);
    expect(shouldEngageOverlay("fact-1", "\t\n")).toBe(false);
    expect(shouldEngageOverlay("", "")).toBe(false);
    expect(buildOverlayKey("   ", "   ")).toBeNull();
  });

  it("explicit cross-product corpus — 5×5 = 25 cases (≥9 required)", () => {
    const variants: Array<[string, string | null | undefined]> = [
      ["null", null],
      ["undefined", undefined],
      ["empty", ""],
      ["whitespace", "   "],
      ["present", "populated-value"],
    ];
    let cases = 0;
    for (const [labelF, f] of variants) {
      for (const [labelC, c] of variants) {
        const expected = labelF === "present" && labelC === "present";
        expect(
          shouldEngageOverlay(f, c),
          `factKey=${labelF}, continuitySubjectKey=${labelC}`,
        ).toBe(expected);
        cases++;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(9);
  });

  it("fast-check property: any combination with an absent field disengages overlay", () => {
    const absentishField = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(""),
      fc.constant("   "),
      fc.constant("\t\n "),
    );
    const presentField = fc
      .string({ minLength: 1, maxLength: 32 })
      .filter((s) => s.trim().length > 0);

    fc.assert(
      fc.property(
        fc.oneof(absentishField, presentField),
        fc.oneof(absentishField, presentField),
        (factKey, continuitySubjectKey) => {
          const fIsPresent =
            typeof factKey === "string" && factKey.trim().length > 0;
          const cIsPresent =
            typeof continuitySubjectKey === "string" &&
            continuitySubjectKey.trim().length > 0;
          const expected = fIsPresent && cIsPresent;
          return shouldEngageOverlay(factKey, continuitySubjectKey) === expected;
        },
      ),
      { numRuns: 200 },
    );
  });
});
