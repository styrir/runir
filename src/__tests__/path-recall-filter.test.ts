import { describe, it, expect, afterEach } from "vitest";
import {
  resolvePathRecallFilter,
  applyPathScorePenalty,
  PATH_NULL_PENALTY,
} from "../recall/query/scope-predicate.js";
import { selectPathScopedTopK } from "../recall/selection/recall-selection.js";
import type { SearchHit } from "../domain/memory/types.js";

const makeHit = (id: string, score: number, path?: string): SearchHit => ({
  id,
  text: `memory ${id}`,
  score,
  path,
});

describe("resolvePathRecallFilter", () => {
  it("with path: WHERE clause includes strict match AND NONE", () => {
    const result = resolvePathRecallFilter("/Users/brooks/Code/runir");
    expect(result.whereClause).toBe(
      "AND (payload.path = $recallPath OR payload.path = NONE)",
    );
    expect(result.vars).toEqual({ recallPath: "/Users/brooks/Code/runir" });
  });

  it("without path: returns empty filter", () => {
    const result = resolvePathRecallFilter(undefined);
    expect(result.whereClause).toBe("");
    expect(result.vars).toEqual({});
  });

  it("with empty string: returns empty filter", () => {
    const result = resolvePathRecallFilter("" as any);
    expect(result.whereClause).toBe("");
    expect(result.vars).toEqual({});
  });
});

describe("applyPathScorePenalty", () => {
  it("null-path hits get score × PATH_NULL_PENALTY (0.70)", () => {
    const hits: SearchHit[] = [
      makeHit("a", 0.9, "/Users/brooks/Code/runir"),
      makeHit("b", 0.8), // no path → should be penalized
    ];
    const result = applyPathScorePenalty(hits, "/Users/brooks/Code/runir");
    expect(result[0].score).toBeCloseTo(0.9); // unchanged
    expect(result[1].score).toBeCloseTo(0.8 * PATH_NULL_PENALTY);
  });

  it("path-matched hits remain unchanged", () => {
    const hits: SearchHit[] = [
      makeHit("a", 0.95, "/Users/brooks/Code/runir"),
    ];
    const result = applyPathScorePenalty(hits, "/Users/brooks/Code/runir");
    expect(result[0].score).toBeCloseTo(0.95);
    expect(result[0].path).toBe("/Users/brooks/Code/runir");
  });

  it("no requestedPath → no penalty on any hit", () => {
    const hits: SearchHit[] = [
      makeHit("a", 0.9),
      makeHit("b", 0.8, "/some/path"),
    ];
    const result = applyPathScorePenalty(hits, undefined);
    expect(result[0].score).toBeCloseTo(0.9);
    expect(result[1].score).toBeCloseTo(0.8);
    // result is the same reference (no mapping)
    expect(result).toBe(hits);
  });

  it("respects RUNIR_NULL_PATH_PENALTY env var", async () => {
    // Dynamically re-import to pick up a different env var value is not possible
    // in vitest without isolation. Instead, test that PATH_NULL_PENALTY is read
    // from process.env at module load time (the default is 0.70 when env not set).
    // We verify the constant itself equals the env var value (or default).
    const envVal = process.env.RUNIR_NULL_PATH_PENALTY;
    if (envVal) {
      expect(PATH_NULL_PENALTY).toBeCloseTo(parseFloat(envVal));
    } else {
      expect(PATH_NULL_PENALTY).toBeCloseTo(0.70);
    }
  });

  it("PATH_NULL_PENALTY default is 0.70", () => {
    // Ensure the module-level constant defaults correctly
    const expected = parseFloat(process.env.RUNIR_NULL_PATH_PENALTY ?? "0.70");
    expect(PATH_NULL_PENALTY).toBeCloseTo(expected);
  });
});

// ── MIM-69 Task 7: selectPathScopedTopK ─────────────────────────────────────

describe("selectPathScopedTopK (MIM-69)", () => {
  const P = "/Users/brooks/Code/runir";

  it("5 exact-path hits → 0 null-path hits selected", () => {
    const hits = [
      makeHit("e1", 0.9, P), makeHit("e2", 0.85, P), makeHit("e3", 0.8, P),
      makeHit("e4", 0.75, P), makeHit("e5", 0.7, P),
      makeHit("n1", 0.95), makeHit("n2", 0.88),
    ];
    const { selected } = selectPathScopedTopK(hits, P, 5);
    expect(selected).toHaveLength(5);
    expect(selected.every((h) => h.path === P)).toBe(true);
  });

  it("3 exact-path + 4 null-path, topK=5 → 3 exact + 1 null-path (exact >= ceil(5/2), strict cap)", () => {
    const hits = [
      makeHit("e1", 0.9, P), makeHit("e2", 0.85, P), makeHit("e3", 0.8, P),
      makeHit("n1", 0.95), makeHit("n2", 0.88), makeHit("n3", 0.7), makeHit("n4", 0.6),
    ];
    const { selected, nullPathIds } = selectPathScopedTopK(hits, P, 5);
    expect(selected).toHaveLength(4); // 3 exact + 1 null (strict cap, exact >= ceil(5/2)=3)
    const exactCount = selected.filter((h) => h.path === P).length;
    const nullCount = selected.filter((h) => !h.path).length;
    expect(exactCount).toBe(3);
    expect(nullCount).toBe(1);
    expect(nullPathIds.size).toBe(1);
  });

  it("0 exact-path + 5 null-path, topK=5 → 5 null-path (adaptive: sparse exact-path fills remaining)", () => {
    const hits = [
      makeHit("n1", 0.95), makeHit("n2", 0.88), makeHit("n3", 0.8),
      makeHit("n4", 0.7), makeHit("n5", 0.6),
    ];
    const { selected, nullPathIds } = selectPathScopedTopK(hits, P, 5);
    expect(selected).toHaveLength(5); // adaptive: 0 exact, cap = topK - 0 = 5
    expect(nullPathIds.size).toBe(5);
  });

  it("2 exact-path + 5 null-path, topK=5 → 2 exact + 3 null-path (adaptive: exact < ceil(5/2))", () => {
    const hits = [
      makeHit("e1", 0.9, P), makeHit("e2", 0.85, P),
      makeHit("n1", 0.95), makeHit("n2", 0.88), makeHit("n3", 0.8),
      makeHit("n4", 0.7), makeHit("n5", 0.6),
    ];
    const { selected, nullPathIds } = selectPathScopedTopK(hits, P, 5);
    expect(selected).toHaveLength(5); // 2 exact + 3 null (adaptive cap = 5-2=3)
    const exactCount = selected.filter((h) => h.path === P).length;
    const nullCount = selected.filter((h) => !h.path).length;
    expect(exactCount).toBe(2);
    expect(nullCount).toBe(3);
    expect(nullPathIds.size).toBe(3);
  });

  it("5 exact-path + 5 null-path, topK=5 → 5 exact + 0 null-path (plentiful exact fills topK)", () => {
    const hits = [
      makeHit("e1", 0.9, P), makeHit("e2", 0.85, P), makeHit("e3", 0.8, P),
      makeHit("e4", 0.75, P), makeHit("e5", 0.7, P),
      makeHit("n1", 0.95), makeHit("n2", 0.88),
    ];
    const { selected, nullPathIds } = selectPathScopedTopK(hits, P, 5);
    expect(selected).toHaveLength(5);
    expect(selected.every((h) => h.path === P)).toBe(true);
    expect(nullPathIds.size).toBe(0);
  });

  it("no requestedPath → standard slicing, no quota applied", () => {
    const hits = [
      makeHit("n1", 0.95), makeHit("n2", 0.88), makeHit("n3", 0.8),
      makeHit("e1", 0.7, P), makeHit("e2", 0.6, P),
    ];
    const { selected } = selectPathScopedTopK(hits, undefined, 3);
    expect(selected).toHaveLength(3);
    // Standard slice: first 3 in order
    expect(selected.map((h) => h.id)).toEqual(["n1", "n2", "n3"]);
  });
});
