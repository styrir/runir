import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../src/shared/cosine.js";

describe("cosineSimilarity", () => {
  it("returns 0 for two empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 when either vector is empty", () => {
    expect(cosineSimilarity([1, 2], [])).toBe(0);
    expect(cosineSimilarity([], [1, 2])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([1], [1, 2, 3, 4])).toBe(0);
  });

  it("returns 1 for identical unit vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([0, 1, 0], [0, 1, 0])).toBeCloseTo(1, 10);
  });

  it("returns ~0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0, 0], [0, 0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 when first vector is all zeros", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when second vector is all zeros", () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("is symmetric: cos(a,b) == cos(b,a)", () => {
    const a = [0.5, 0.7, -0.2];
    const b = [0.1, -0.3, 0.9];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it("scales out vector magnitude (cos depends on direction only)", () => {
    const baseline = cosineSimilarity([3, 4], [4, 3]);
    const scaled = cosineSimilarity([30, 40], [4, 3]);
    expect(scaled).toBeCloseTo(baseline, 10);
  });

  it("matches the textbook value for the 3-4 / 4-3 pair", () => {
    expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(24 / 25, 10);
  });
});
