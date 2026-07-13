import { describe, expect, it } from "vitest";
import {
  boundaryFlipRate,
  ndcgAt5,
  stalePickRate,
  top1CurrentStateAccuracy,
} from "../hexis/harness-metrics";

describe("ndcgAt5", () => {
  it("returns 0 for empty ranking", () => {
    expect(ndcgAt5([])).toBe(0);
  });

  it("returns 0 when all relevance scores are zero", () => {
    expect(
      ndcgAt5([
        { id: "a", relevance: 0 },
        { id: "b", relevance: 0 },
      ]),
    ).toBe(0);
  });

  it("returns 1 for a perfectly ordered ranking", () => {
    const ranking = [
      { id: "a", relevance: 3 },
      { id: "b", relevance: 2 },
      { id: "c", relevance: 1 },
    ];
    expect(ndcgAt5(ranking)).toBeCloseTo(1, 10);
  });

  it("returns less than 1 for an imperfect ordering", () => {
    const ranking = [
      { id: "a", relevance: 1 },
      { id: "b", relevance: 3 },
      { id: "c", relevance: 2 },
    ];
    expect(ndcgAt5(ranking)).toBeLessThan(1);
    expect(ndcgAt5(ranking)).toBeGreaterThan(0);
  });

  it("only considers top 5 items in DCG (positions beyond 5 are ignored)", () => {
    // Items beyond position 5 don't contribute to DCG, but IDCG considers all items
    // With relevance=100 at position 6: IDCG puts it first, so NDCG < 1
    const ranking = [
      { id: "a", relevance: 5 },
      { id: "b", relevance: 4 },
      { id: "c", relevance: 3 },
      { id: "d", relevance: 2 },
      { id: "e", relevance: 1 },
      { id: "f", relevance: 100 },
    ];
    const result = ndcgAt5(ranking);
    // DCG@5 = 5/log2(2)+4/log2(3)+3/log2(4)+2/log2(5)+1/log2(6)
    // IDCG@5 uses top-5 by relevance: 100,5,4,3,2
    const dcg =
      5 / Math.log2(2) + 4 / Math.log2(3) + 3 / Math.log2(4) + 2 / Math.log2(5) + 1 / Math.log2(6);
    const idcg =
      100 / Math.log2(2) + 5 / Math.log2(3) + 4 / Math.log2(4) + 3 / Math.log2(5) + 2 / Math.log2(6);
    expect(result).toBeCloseTo(dcg / idcg, 10);
    expect(result).toBeLessThan(1);
  });

  it("handles single item ranking", () => {
    expect(ndcgAt5([{ id: "a", relevance: 5 }])).toBeCloseTo(1, 10);
  });

  it("computes correct DCG/IDCG ratio for known values", () => {
    // Position 1: rel=3, gain = 3/log2(2) = 3
    // Position 2: rel=1, gain = 1/log2(3) ≈ 0.631
    // IDCG: pos1=3/log2(2)=3, pos2=1/log2(3)≈0.631 → same order → NDCG=1 only if perfectly sorted
    // Use a case where order matters
    const ranking = [
      { id: "a", relevance: 1 },
      { id: "b", relevance: 3 },
    ];
    // DCG: 1/log2(2) + 3/log2(3) = 1 + 1.893 = 2.893
    // IDCG: 3/log2(2) + 1/log2(3) = 3 + 0.631 = 3.631
    const expected = (1 / Math.log2(2) + 3 / Math.log2(3)) / (3 / Math.log2(2) + 1 / Math.log2(3));
    expect(ndcgAt5(ranking)).toBeCloseTo(expected, 10);
  });
});

describe("boundaryFlipRate", () => {
  it("returns 0 for empty inputs", () => {
    expect(boundaryFlipRate([], [], 5)).toBe(0);
    expect(boundaryFlipRate(["a"], [], 5)).toBe(0);
    expect(boundaryFlipRate([], ["a"], 5)).toBe(0);
  });

  it("returns 0 when windowSize is 0", () => {
    expect(boundaryFlipRate(["a", "b"], ["a", "b"], 0)).toBe(0);
  });

  it("returns 0 when top-W items are identical", () => {
    expect(boundaryFlipRate(["a", "b", "c"], ["a", "b", "c"], 3)).toBe(0);
  });

  it("returns 1 when all top-W items changed", () => {
    expect(boundaryFlipRate(["a", "b", "c"], ["x", "y", "z"], 3)).toBeCloseTo(1, 10);
  });

  it("returns 0.5 when half of top-W changed", () => {
    expect(boundaryFlipRate(["a", "b", "c", "d"], ["a", "b", "x", "y"], 4)).toBeCloseTo(0.5, 10);
  });

  it("respects windowSize boundary", () => {
    // Only look at top 2; reranked top 2 are same as baseline
    expect(boundaryFlipRate(["a", "b", "c"], ["a", "b", "x"], 2)).toBe(0);
  });

  it("clamps window to shorter list length", () => {
    // baseline has 2 items, window=10 → effective window=2
    const result = boundaryFlipRate(["a", "b"], ["a", "b"], 10);
    expect(result).toBe(0);
  });
});

describe("top1CurrentStateAccuracy", () => {
  it("returns 0 for empty results", () => {
    expect(top1CurrentStateAccuracy([])).toBe(0);
  });

  it("returns 1 when all top-1 match expected", () => {
    const results = [
      { expectedCurrentId: "a", top1Id: "a" },
      { expectedCurrentId: "b", top1Id: "b" },
    ];
    expect(top1CurrentStateAccuracy(results)).toBeCloseTo(1, 10);
  });

  it("returns 0 when none match", () => {
    const results = [
      { expectedCurrentId: "a", top1Id: "x" },
      { expectedCurrentId: "b", top1Id: "y" },
    ];
    expect(top1CurrentStateAccuracy(results)).toBe(0);
  });

  it("returns correct fraction for partial match", () => {
    const results = [
      { expectedCurrentId: "a", top1Id: "a" },
      { expectedCurrentId: "b", top1Id: "x" },
      { expectedCurrentId: "c", top1Id: "c" },
      { expectedCurrentId: "d", top1Id: "y" },
    ];
    expect(top1CurrentStateAccuracy(results)).toBeCloseTo(0.5, 10);
  });
});

describe("stalePickRate", () => {
  it("returns 0 for empty results", () => {
    expect(stalePickRate([])).toBe(0);
  });

  it("returns 0 when no top1 is stale", () => {
    const results = [
      { top1Id: "a", staleIds: ["x", "y"] },
      { top1Id: "b", staleIds: ["z"] },
    ];
    expect(stalePickRate(results)).toBe(0);
  });

  it("returns 1 when all top1 are stale", () => {
    const results = [
      { top1Id: "x", staleIds: ["x", "y"] },
      { top1Id: "z", staleIds: ["z"] },
    ];
    expect(stalePickRate(results)).toBeCloseTo(1, 10);
  });

  it("returns correct fraction for partial stale picks", () => {
    const results = [
      { top1Id: "x", staleIds: ["x"] },
      { top1Id: "a", staleIds: ["z"] },
      { top1Id: "b", staleIds: ["b"] },
      { top1Id: "c", staleIds: ["z"] },
    ];
    expect(stalePickRate(results)).toBeCloseTo(0.5, 10);
  });

  it("handles empty staleIds list", () => {
    const results = [{ top1Id: "a", staleIds: [] as readonly string[] }];
    expect(stalePickRate(results)).toBe(0);
  });
});
