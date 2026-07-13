import { describe, it, expect } from "vitest";
import {
  DEFAULT_ARBITRATION_CONFIG,
  deriveSubjectKey,
  type ExtractedFact,
} from "../src/domain/memory/lifecycle.js";

function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    l2: "test",
    l0: "test",
    l1: "test",
    confidence: 0.9,
    category: "events",
    tier: "working",
    tags: [],
    factKey: "events:abc123",
    ...overrides,
  };
}

describe("deriveSubjectKey", () => {
  it("joins category and l1 when both present", () => {
    expect(
      deriveSubjectKey(fact({ category: "preferences", l1: "ts-strict" })),
    ).toBe("preferences:ts-strict");
  });

  it("falls back to factKey when l1 is empty", () => {
    expect(
      deriveSubjectKey(
        fact({ category: "preferences", l1: "", factKey: "preferences:fallback" }),
      ),
    ).toBe("preferences:fallback");
  });

  it("falls back to factKey when category is falsy", () => {
    expect(
      deriveSubjectKey(
        fact({ category: "" as ExtractedFact["category"], l1: "x", factKey: "abc" }),
      ),
    ).toBe("abc");
  });

  it("returns empty string when category, l1, and factKey are all empty", () => {
    expect(
      deriveSubjectKey(
        fact({ category: "" as ExtractedFact["category"], l1: "", factKey: "" }),
      ),
    ).toBe("");
  });
});

describe("DEFAULT_ARBITRATION_CONFIG", () => {
  it("matches documented defaults", () => {
    expect(DEFAULT_ARBITRATION_CONFIG).toEqual({
      skipThreshold: 0.95,
      skipWindowHours: 24,
      mergeThreshold: 0.85,
      mergeWindowHours: 72,
      candidateLimit: 5,
      recentWriteTtlMinutes: 5,
    });
  });
});
