import { describe, expect, it } from "vitest";
import { buildRetrievalCalibrationTelemetry } from "../recall/policy/calibration-telemetry.js";
import { resolveRetrievalPolicyForLane } from "../recall/policy/retrieval-policy.js";
import type { HexisGateDecision } from "../recall/policy/policy-types.js";
import type { SearchHit } from "../domain/memory/types.js";

function makeHit(id: string, score: number, text = `raw text ${id}`): SearchHit {
  return {
    id,
    score,
    text,
    scoreStages: {
      rrf: {
        score,
        vectorRank: id === "a" ? 1 : undefined,
        bm25Rank: id === "b" ? 1 : undefined,
        recencyRank: id === "c" ? 1 : undefined,
      },
    },
    preHexisScore: score,
    postHexisScore: score,
    poolRank: id === "a" ? 1 : id === "b" ? 2 : 3,
    boundaryGap: 0.0044444,
    gateValue: 1,
    hexisMode: 0,
    laneLambda: 0.25,
  };
}

describe("buildRetrievalCalibrationTelemetry", () => {
  it("records compact non-text RRF and Hexis calibration fields", () => {
    const policy = resolveRetrievalPolicyForLane("decision_trace");
    const gate: HexisGateDecision = {
      enabled: true,
      reason: "ambiguous_boundary",
      reorderWindow: policy.hexis.reorderWindow,
      ambiguityGap: 0.0044444,
      admissibleIds: ["a", "b"],
    };

    const telemetry = buildRetrievalCalibrationTelemetry({
      policy,
      candidatePool: [
        makeHit("a", 0.0295081967, "SECRET raw memory alpha"),
        makeHit("b", 0.0285714286, "SECRET raw memory beta"),
        makeHit("c", 0.0264705882, "SECRET raw memory gamma"),
      ],
      gate,
      safeLimit: 15,
      recallLatencyMs: 12.4,
      emittedContextSize: 380,
    });

    expect(telemetry).toMatchObject({
      lane: "decision_trace",
      rrfK: 60,
      rrfWeights: { vector: 1, bm25: 1.2, recency: 0.35 },
      safeLimit: 15,
      reorderWindow: 7,
      top2Gap: 0.000937,
      top3Gap: 0.003038,
      hexis: {
        triggered: true,
        reason: "ambiguous_boundary",
        effectiveThreshold: 0.08,
        lambda: 0.25,
        mode: 0,
      },
      recallLatencyMs: 12,
      emittedContextSize: 380,
    });
    expect(telemetry.topCandidates).toHaveLength(3);
    expect(telemetry.topCandidates[0]).toEqual(expect.objectContaining({
      rank: 1,
      score: 0.029508,
      idHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    }));

    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain("SECRET raw memory");
    expect(serialized).not.toContain("\"text\"");
  });

  it("does not fail route telemetry when a legacy hit is missing an id", () => {
    const policy = resolveRetrievalPolicyForLane("decision_trace");
    const gate: HexisGateDecision = {
      enabled: false,
      reason: "clear_boundary",
      reorderWindow: policy.hexis.reorderWindow,
      ambiguityGap: 0.2,
      admissibleIds: [],
    };

    const telemetry = buildRetrievalCalibrationTelemetry({
      policy,
      candidatePool: [
        { score: 0.2, text: "legacy mock result" } as SearchHit,
      ],
      gate,
      safeLimit: 3,
      recallLatencyMs: 1,
      emittedContextSize: 0,
    });

    expect(telemetry.topCandidates[0].idHash).toMatch(/^[a-f0-9]{16}$/);
  });
});
