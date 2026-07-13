import { describe, it, expect } from "vitest";
import { relevanceGateDrops } from "../recall/selection/relevance-gate.js";

/**
 * Unit coverage for the TURN-path top-hit relevance gate (Rúnir-2i8k). The gate returns EMPTY
 * recall when the top hit's POST-RERANK COSINE score is below the floor — so an off-topic query
 * stops injecting the weak top-K tail. It must NEVER fire on the RRF fallback (uncalibrated scale)
 * or the (retired) opener intent, and must be OFF at the default floor 0.
 */
const cosineHit = (score: number) => ({ scoreStages: { reranker: { score, threshold: 0 } } });
const rrfHit = (score: number) => ({ scoreStages: { vector: { score, rank: 1 } } }); // no reranker stage

describe("relevanceGateDrops (Rúnir-2i8k)", () => {
  it("is OFF at the default floor 0 — never drops, even a weak top hit", () => {
    expect(relevanceGateDrops(cosineHit(0.1), 0, "turn")).toBe(false);
  });

  it("DROPS when the top rerank-cosine score is below the floor (off-topic query)", () => {
    expect(relevanceGateDrops(cosineHit(0.47), 0.55, "turn")).toBe(true);
  });

  it("KEEPS when the top rerank-cosine score clears the floor (strong primary)", () => {
    expect(relevanceGateDrops(cosineHit(0.99), 0.55, "turn")).toBe(false);
  });

  it("treats score == floor as KEEP (strictly-below drops)", () => {
    expect(relevanceGateDrops(cosineHit(0.55), 0.55, "turn")).toBe(false);
  });

  it("NEVER fires on the RRF fallback — a hit with no reranker stage is not gated", () => {
    // Even a low RRF score must NOT be gated: the floor is calibrated on the cosine scale only.
    expect(relevanceGateDrops(rrfHit(0.01), 0.55, "turn")).toBe(false);
  });

  it("EXCLUDES the (retired) opener intent — never gates session_opener", () => {
    expect(relevanceGateDrops(cosineHit(0.1), 0.55, "session_opener")).toBe(false);
  });

  it("returns false when there is no top hit (empty selection)", () => {
    expect(relevanceGateDrops(undefined, 0.55, "turn")).toBe(false);
  });

  it("ignores a non-positive floor (defensive)", () => {
    expect(relevanceGateDrops(cosineHit(0.1), -1, "turn")).toBe(false);
  });
});
