import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../../domain/memory/types.js";
import { detectExactQaIntent, scoreExactQaCandidate } from "../../../domain/memory/exact-qa.js";
import { applyRerankScores, collapseContradictions, postProcessRecallResults } from "../../selection/recall-selection.js";

function hit(id: string, text: string, score = 0.5): SearchHit {
  return { id, text, score };
}

describe("exact-QA structured retrieval protections", () => {
  it("recognizes exact-value questions and scores raw spans/atomic claims", () => {
    const candidate: SearchHit = {
      ...hit("a", "Runir local service uses port 7700."),
      rawSpan: { text: "The exact port is 7700.", kind: "exact_answer" },
      atomicClaims: [{ subject: "Runir local service", predicate: "port", value: "7700" }],
    };

    expect(detectExactQaIntent("Which port does the Runir local service use?")).toBe(true);
    expect(scoreExactQaCandidate("Which port does the Runir local service use?", candidate)).toBeGreaterThan(0.5);
  });

  it("preserves exact candidates through reranker threshold filtering", () => {
    const exact = { ...hit("exact", "Runir local service uses port 7700.", 0.2), exactQaCandidate: true };
    const broad = hit("broad", "Runir service architecture overview.", 0.9);
    const scores = new Map([["broad", 0.8]]);

    const result = applyRerankScores([exact, broad], scores, 0.5, {
      preserve: (candidate) => candidate.exactQaCandidate === true,
    });

    expect(result.map((candidate) => candidate.id)).toContain("exact");
  });

  describe("exact-QA preserve floor-score fix (Rúnir-qjn4.3 R3)", () => {
    it("OFF (no preserveFloor): preserved hits keep their RRF score — byte-identical to today", () => {
      const exact = { ...hit("exact", "Runir local service uses port 7700.", 0.02), exactQaCandidate: true };
      const broad = hit("broad", "Runir service architecture overview.", 0.9);
      const scores = new Map([["broad", 0.8]]);

      const result = applyRerankScores([exact, broad], scores, 0.5, {
        preserve: (candidate) => candidate.exactQaCandidate === true,
      });

      const byId = new Map(result.map((r) => [r.id, r.score]));
      // broad passed threshold → reranker score 0.8; exact preserved → keeps RRF 0.02
      expect(byId.get("broad")).toBe(0.8);
      expect(byId.get("exact")).toBe(0.02);
      // exact parks at the bottom (the historical scale-mixing wart)
      expect(result.map((r) => r.id)).toEqual(["broad", "exact"]);
    });

    it("ON (preserveFloor=threshold): preserved hit floors to the threshold and ranks with reranked peers", () => {
      const exact = { ...hit("exact", "Runir local service uses port 7700.", 0.02), exactQaCandidate: true };
      const broad = hit("broad", "Runir service architecture overview.", 0.9);
      const scores = new Map([["broad", 0.8]]);

      const result = applyRerankScores([exact, broad], scores, 0.5, {
        preserve: (candidate) => candidate.exactQaCandidate === true,
        preserveFloor: 0.5,
      });

      const byId = new Map(result.map((r) => [r.id, r.score]));
      expect(byId.get("broad")).toBe(0.8);
      // exact had no reranker score → floored to 0.5 (was 0.02)
      expect(byId.get("exact")).toBe(0.5);
      // both now on the cosine scale; exact ranks above threshold, below the 0.8 hit
      expect(result.map((r) => r.id)).toEqual(["broad", "exact"]);
    });

    it("ON: a preserved hit with a sub-threshold reranker cosine keeps it when above the floor", () => {
      const exact = { ...hit("exact", "exact", 0.02), exactQaCandidate: true };
      const other = hit("other", "other", 0.9);
      // exact has a reranker cosine 0.6 but falls under threshold 0.7 → preserved; 0.6 > floor 0.5
      const scores = new Map([["other", 0.95], ["exact", 0.6]]);

      const result = applyRerankScores([exact, other], scores, 0.7, {
        preserve: (candidate) => candidate.exactQaCandidate === true,
        preserveFloor: 0.5,
      });

      const byId = new Map(result.map((r) => [r.id, r.score]));
      expect(byId.get("exact")).toBe(0.6); // max(cosine 0.6, floor 0.5) = 0.6
      expect(byId.get("other")).toBe(0.95);
    });

    it("ON: a threshold-passing hit is unaffected by the floor", () => {
      const passing = hit("passing", "passing", 0.1);
      const scores = new Map([["passing", 0.9]]);

      const result = applyRerankScores([passing], scores, 0.5, {
        preserveFloor: 0.5,
      });

      expect(result[0].score).toBe(0.9); // reranker cosine, not floored
    });
  });

  it("does not collapse answer-distinct exact facts with different values", () => {
    const result = collapseContradictions([
      hit("alice", "Alice birthday is 1990-01-02."),
      hit("bob", "Bob birthday is 1991-03-04."),
    ]);

    expect(result.map((candidate) => candidate.id).sort()).toEqual(["alice", "bob"]);
  });

  it("renders exact candidates at full depth even when the intent depth is l0", () => {
    const result = postProcessRecallResults([
      { ...hit("exact", "Runir local service uses port 7700. Do not reduce this to a title."), l0: "Runir port", exactQaCandidate: true },
    ], {
      intent: { categories: ["cases"], depth: "l0", confidence: 0.8, label: "fact" },
      topK: 1,
    });

    expect(result.renderedText[0]).toContain("7700");
    expect(result.renderedText[0]).toContain("Do not reduce this");
  });
});
