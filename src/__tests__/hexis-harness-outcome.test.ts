import { describe, it, expect } from "vitest";
import { classifyOutcome } from "../../scripts/hexis-harness.js";

describe("classifyOutcome", () => {
  it("both null → outcome unchanged, notes contains baseline-empty-pool", () => {
    const result = classifyOutcome({
      baselineTopId: null,
      finalTopId: null,
      baselineIds: [],
      finalIds: [],
      caseDef: {},
    });
    expect(result.outcome).toBe("unchanged");
    expect(result.notes).toContain("baseline-empty-pool");
  });

  it("baseline null + final non-null → outcome win", () => {
    const result = classifyOutcome({
      baselineTopId: null,
      finalTopId: "mem-abc",
      baselineIds: [],
      finalIds: ["mem-abc"],
      caseDef: { expectedTopId: "mem-abc" },
    });
    expect(result.outcome).toBe("win");
  });

  it("baseline non-null + final null → outcome regression", () => {
    const result = classifyOutcome({
      baselineTopId: "mem-abc",
      finalTopId: null,
      baselineIds: ["mem-abc"],
      finalIds: [],
      caseDef: { expectedTopId: "mem-abc" },
    });
    expect(result.outcome).toBe("regression");
  });

  it("both non-null different IDs with expectedAheadOf — regression when winner lost position", () => {
    const result = classifyOutcome({
      baselineTopId: "mem-loser",
      finalTopId: "mem-loser",
      baselineIds: ["mem-winner", "mem-loser"],
      finalIds: ["mem-loser", "mem-winner"],
      caseDef: { expectedAheadOf: { winner: "mem-winner", loser: "mem-loser" } },
    });
    expect(result.outcome).toBe("regression");
  });
});
