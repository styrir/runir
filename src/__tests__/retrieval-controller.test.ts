import { describe, expect, it } from "vitest";
import { getRecipeRegistry } from "../recall/policy/recipe-registry.js";
import { applyHexisByPolicy, evaluateHexisGate, resolveRetrievalController } from "../recall/policy/retrieval-controller.js";
import { resolveRetrievalPolicyForLane } from "../recall/policy/retrieval-policy.js";
import { normalizeHexis } from "../hexis/runtime-hexis.js";
import type { SearchHit } from "../domain/memory/types.js";
import type { RecallLane } from "../recall/policy/policy-types.js";

function makeHit(id: string, score: number, text = `hit ${id}`): SearchHit {
  return { id, score, text };
}

describe("retrieval-controller", () => {
  it("maps latest-state intent to latest_state policy", () => {
    const resolved = resolveRetrievalController({
      label: "latest_state",
      categories: ["entities"],
      depth: "l1",
      confidence: 0.9,
    });

    expect(resolved.policy.lane).toBe("latest_state");
    expect(resolved.recipe.id).toBe("status_current");
    expect(resolved.policy.useLatestStateResolution).toBe(true);
    expect(resolved.policy.retrievalPath).toBe("latest_state");
  });

  it("keeps status_continuity contract in compatibility mode without barred-group claims", () => {
    const resolved = resolveRetrievalController({
      label: "current_status",
      categories: ["events"],
      depth: "l1",
      confidence: 0.9,
    });

    expect(resolved.policy.admissibilityContract).toEqual(expect.objectContaining({
      id: "status_continuity_compatibility",
      selectionEngine: "continuity_resolved",
      compatibilityMode: true,
      barredGroups: [],
    }));
    expect(resolved.policy.admissibilityContract?.continuityClasses.neutral).toBe("compatibility_only");
  });

  it("selects the expected initial recipe for each A3 intent family", () => {
    expect(resolveRetrievalController({
      label: "current_status",
      categories: ["events"],
      depth: "l1",
      confidence: 0.9,
    }).recipe.id).toBe("status_current");

    expect(resolveRetrievalController({
      label: "recent_work",
      categories: ["events"],
      depth: "l1",
      confidence: 0.9,
    }).recipe.id).toBe("history_change");

    expect(resolveRetrievalController({
      label: "architecture",
      categories: ["entities"],
      depth: "full",
      confidence: 0.9,
    }).recipe.id).toBe("reference_architecture");

    expect(resolveRetrievalController({
      label: "fact",
      categories: ["entities"],
      depth: "full",
      confidence: 0.3,
    }).recipe.id).toBe("general_recall");
  });

  it("maps architecture intent to the guidance_reference policy lane", () => {
    const resolved = resolveRetrievalController({
      label: "architecture",
      categories: ["entities", "patterns"],
      depth: "full",
      confidence: 0.9,
    });

    expect(resolved.policy.lane).toBe("guidance_reference");
    expect(resolved.policy.selectorProfile).toBe("guidance_reference");
    expect(resolved.policy.rrfWeights).toEqual({
      vector: 1,
      bm25: 1.45,
      recency: 0.2,
    });
    expect(resolved.policy.recencyWindowHours).toBe(12);
  });

  it("maps workflow_posture intent to its own policy lane", () => {
    const resolved = resolveRetrievalController({
      label: "workflow_posture",
      categories: ["events", "cases"],
      depth: "full",
      confidence: 0.9,
    });

    expect(resolved.policy.lane).toBe("workflow_posture");
    expect(resolved.policy.selectorProfile).toBe("workflow_posture");
    expect(resolved.recipe.id).toBe("workflow_posture");
    expect(resolved.policy.rrfWeights).toEqual({
      vector: 1,
      bm25: 1.35,
      recency: 0.35,
    });
  });

  it("keeps relation expansion off for all initial Phase A recipes", () => {
    expect(getRecipeRegistry()).toEqual([
      expect.objectContaining({ id: "status_current", version: "phase-a-v1", relationExpansionEnabled: false }),
      expect.objectContaining({ id: "compaction_projection", version: "phase-a-v1", relationExpansionEnabled: false }),
      expect.objectContaining({ id: "workflow_posture", version: "phase-a-v1", relationExpansionEnabled: false }),
      expect.objectContaining({ id: "history_change", version: "phase-a-v1", relationExpansionEnabled: false }),
      expect.objectContaining({ id: "reference_architecture", version: "phase-a-v1", relationExpansionEnabled: false }),
      expect.objectContaining({ id: "general_recall", version: "phase-a-v1", relationExpansionEnabled: false }),
    ]);
  });

  it("disables Hexis for deterministic continuity lanes", () => {
    const resolved = resolveRetrievalController({
      label: "session_opener",
      categories: ["events"],
      depth: "l1",
      confidence: 0.9,
    });

    const gate = evaluateHexisGate([makeHit("a", 1), makeHit("b", 0.99)], resolved.policy);
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("lane_disabled");
  });

  it("enables Hexis only when the top boundary is ambiguous", () => {
    const resolved = resolveRetrievalController({
      label: "decision_trace",
      categories: ["cases"],
      depth: "full",
      confidence: 0.8,
    });

    expect(evaluateHexisGate([makeHit("a", 1), makeHit("b", 0.97)], resolved.policy).enabled).toBe(true);
    expect(evaluateHexisGate([makeHit("a", 1), makeHit("b", 0.2)], resolved.policy).enabled).toBe(false);
  });

  it("keeps same-pool behavior when Hexis is applied", () => {
    const resolved = resolveRetrievalController({
      label: "decision_trace",
      categories: ["cases"],
      depth: "full",
      confidence: 0.8,
    });
    const hexis = normalizeHexis({
      userId: "u1",
      hint: { label: "capture frame", goals: ["capture"], topicBias: { capture: 1 } },
    });
    const hits = [
      makeHit("a", 1, "generic"),
      makeHit("b", 0.98, "capture specific evidence"),
      makeHit("c", 0.97, "other"),
    ];

    const result = applyHexisByPolicy(hits, hexis, resolved.policy);
    expect(result.hits.map((hit) => hit.id).sort()).toEqual(["a", "b", "c"]);
    expect(result.gate.enabled).toBe(true);
  });

  describe("per-lane lambda wiring (Phase 3b)", () => {
    const DETERMINISTIC_LANES: RecallLane[] = ["session_opener", "current_status", "exact_lookup"];

    function makeFrameHexis() {
      return normalizeHexis({
        userId: "u1",
        hint: {
          label: "capture frame",
          goals: ["capture"],
          topicBias: { capture: 1 },
        },
      });
    }

    for (const lane of DETERMINISTIC_LANES) {
      it(`lane-bypasses Hexis on ${lane} (lambda=0): postHexisScore=preHexisScore, mode=1, laneLambda=0`, () => {
        const policy = resolveRetrievalPolicyForLane(lane);
        expect(policy.hexis.hexisLambda).toBe(0);

        const hexis = makeFrameHexis();
        const hits = [
          makeHit("a", 1.0, "generic"),
          makeHit("b", 0.98, "capture specific evidence"),
          makeHit("c", 0.97, "other"),
        ];

        const result = applyHexisByPolicy(hits, hexis, policy);

        expect(result.gate.enabled).toBe(false);
        expect(result.gate.reason).toBe("bypass_lane_lambda");
        for (const hit of result.hits) {
          expect(hit.hexisMode).toBe(1);
          expect(hit.laneLambda).toBe(0);
          expect(hit.gateValue).toBe(0);
          expect(hit.postHexisScore).toBe(hit.preHexisScore);
          expect(hit.scoreStages?.hexis).toBeUndefined();
        }
      });
    }

    it("decision_trace (lambda=0.25) allows non-zero Hexis contribution with an ambiguous boundary", () => {
      const policy = resolveRetrievalPolicyForLane("decision_trace");
      expect(policy.hexis.hexisLambda).toBeGreaterThan(0);

      const hexis = makeFrameHexis();
      const hits = [
        makeHit("a", 1.0, "generic"),
        makeHit("b", 0.98, "capture specific evidence"),
        makeHit("c", 0.97, "other"),
      ];

      const result = applyHexisByPolicy(hits, hexis, policy);
      expect(result.gate.enabled).toBe(true);
      const boosted = result.hits.find((h) => h.id === "b");
      expect(boosted).toBeDefined();
      expect(boosted!.hexisMode).toBe(0);
      expect(boosted!.laneLambda).toBe(0.25);
      expect(boosted!.postHexisScore).toBeGreaterThan(boosted!.preHexisScore!);
    });

    it("latest_state (lambda=0.1) passes its lambda through to applyHexisToHits", () => {
      const policy = resolveRetrievalPolicyForLane("latest_state");
      expect(policy.hexis.hexisLambda).toBe(0.1);

      const hexis = makeFrameHexis();
      const hits = [
        makeHit("a", 1.0, "generic"),
        makeHit("b", 0.99, "capture specific evidence"),
        makeHit("c", 0.98, "other"),
      ];

      const result = applyHexisByPolicy(hits, hexis, policy);
      const admissible = result.hits.find((h) => h.hexisMode === 0);
      if (admissible) {
        expect(admissible.laneLambda).toBe(0.1);
      }
    });

    it("unknown_mixed lambda is 0.2", () => {
      const policy = resolveRetrievalPolicyForLane("unknown_mixed");
      expect(policy.hexis.hexisLambda).toBe(0.2);
    });
  });
});
