import { describe, expect, it } from "vitest";
import { runCalibrationReplay } from "../hexis/calibration-replay.js";
import { normalizeHexis } from "../hexis/runtime-hexis.js";
import { resolveRetrievalPolicyForLane } from "../recall/policy/retrieval-policy.js";
import type { SearchHit } from "../domain/memory/types.js";

function makeHit(id: string, score: number, text = `hit ${id}`): SearchHit {
  return { id, score, text };
}

function makeHexis() {
  return normalizeHexis({
    userId: "u1",
    hint: {
      label: "measurement frame",
      goals: ["measurement"],
      topicBias: { measurement: 1 },
    },
  });
}

describe("runCalibrationReplay", () => {
  it("compares baseline and candidate variants without changing production constants", () => {
    const policy = resolveRetrievalPolicyForLane("decision_trace");
    const hexis = makeHexis();

    const report = runCalibrationReplay(
      [
        {
          id: "clear-winner",
          policy,
          hexis,
          hits: [
            makeHit("current", 1, "measurement current"),
            makeHit("stale", 0.2, "measurement stale"),
          ],
          relevance: { current: 3, stale: 1 },
          expectedCurrentId: "current",
          staleIds: ["stale"],
        },
        {
          id: "near-tie",
          policy,
          hexis,
          hits: [
            makeHit("stale", 1, "measurement stale"),
            makeHit("current", 0.99, "measurement current"),
          ],
          relevance: { current: 3, stale: 1 },
          expectedCurrentId: "current",
          staleIds: ["stale"],
        },
        {
          id: "low-score-clear-relative-gap",
          policy,
          hexis,
          hits: [
            makeHit("low-current", 0.01, "measurement current"),
            makeHit("low-stale", 0.001, "measurement stale"),
          ],
          relevance: { "low-current": 3, "low-stale": 1 },
          expectedCurrentId: "low-current",
          staleIds: ["low-stale"],
        },
      ],
      [
        { id: "baseline" },
        { id: "lower-threshold-candidate", hexis: { ambiguityThreshold: 0.005 } },
        { id: "lambda-zero-candidate", hexis: { hexisLambda: 0 } },
      ],
    );

    const baseline = report.summary.find((entry) => entry.variantId === "baseline");
    const lowerThreshold = report.summary.find((entry) => entry.variantId === "lower-threshold-candidate");
    const lambdaZero = report.summary.find((entry) => entry.variantId === "lambda-zero-candidate");

    expect(baseline?.caseCount).toBe(3);
    expect(lowerThreshold?.caseCount).toBe(3);
    expect(lambdaZero?.caseCount).toBe(3);
    expect(lowerThreshold!.hexisInvocationRate).toBeLessThan(baseline!.hexisInvocationRate);
    expect(lambdaZero!.hexisInvocationRate).toBe(0);

    expect(report.cases.find((entry) =>
      entry.caseId === "clear-winner" && entry.variantId === "baseline"
    )?.hexisTriggered).toBe(false);
    expect(report.cases.find((entry) =>
      entry.caseId === "near-tie" && entry.variantId === "baseline"
    )?.hexisTriggered).toBe(true);
    expect(report.cases.find((entry) =>
      entry.caseId === "low-score-clear-relative-gap" && entry.variantId === "lower-threshold-candidate"
    )?.hexisTriggered).toBe(false);
  });

  it("replays RRF weights from rank stages and reports reorder-window boundary flips", () => {
    const policy = resolveRetrievalPolicyForLane("guidance_reference");
    const report = runCalibrationReplay(
      [
        {
          id: "ranked-legs",
          policy,
          hits: [
            {
              id: "vector-first",
              text: "vector",
              score: 1,
              scoreStages: { rrf: { score: 1, vectorRank: 1, bm25Rank: 3, recencyRank: 3 } },
            },
            {
              id: "bm25-first",
              text: "bm25",
              score: 0.9,
              scoreStages: { rrf: { score: 0.9, vectorRank: 3, bm25Rank: 1, recencyRank: 3 } },
            },
            {
              id: "recency-first",
              text: "recency",
              score: 0.8,
              scoreStages: { rrf: { score: 0.8, vectorRank: 3, bm25Rank: 3, recencyRank: 1 } },
            },
          ],
          relevance: { "bm25-first": 3, "vector-first": 2, "recency-first": 1 },
          topK: 1,
        },
      ],
      [
        { id: "baseline", rrfWeights: { vector: 3, bm25: 0.2, recency: 0.1 } },
        { id: "bm25-heavy", rrfWeights: { vector: 0.2, bm25: 3, recency: 0.1 } },
      ],
    );

    const bm25Heavy = report.cases.find((entry) => entry.variantId === "bm25-heavy");
    expect(bm25Heavy?.topIds[0]).toBe("bm25-first");
    expect(bm25Heavy?.boundaryFlipRate).toBeGreaterThan(0);
  });
});
