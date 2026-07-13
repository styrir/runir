import { describe, it, expect } from "vitest";
import {
  applyHexisByPolicy,
  evaluateHexisGate,
  resolveRetrievalController,
} from "../retrieval-controller.js";
import { resolveRetrievalPolicyForLane } from "../retrieval-policy.js";
import type { RecallLane } from "../policy-types.js";
import type { SearchHit } from "../../../domain/memory/types.js";
import type { IntentSignal } from "../../intent/intent-analyzer.js";
import type { HexisState } from "../../../hexis/runtime-hexis.js";

function hit(id: string, score: number): SearchHit {
  return { id, text: id, score };
}

function policyFor(lane: RecallLane) {
  return resolveRetrievalPolicyForLane(lane);
}

const sampleIntent: IntentSignal = {
  categories: [],
  depth: "l1",
  confidence: 0.9,
  label: "exact_lookup",
};

describe("resolveRetrievalController", () => {
  it("returns intent, policy, and recipe", () => {
    const out = resolveRetrievalController(sampleIntent);
    expect(out.intent).toBe(sampleIntent);
    expect(out.policy.lane).toBeDefined();
    expect(out.recipe).toBeDefined();
  });

  it("derives policy lane from intent label", () => {
    const out = resolveRetrievalController({
      ...sampleIntent,
      label: "session_opener",
    } as IntentSignal);
    expect(out.policy.lane).toBe("session_opener");
  });

  it("routes compaction intents to the compaction_projection lane + recipe (OM-2, Rúnir-tfxt.2)", () => {
    for (const label of ["pre_compaction", "post_compaction_validation"] as const) {
      const out = resolveRetrievalController({ ...sampleIntent, label } as IntentSignal);
      expect(out.policy.lane).toBe("compaction_projection");
      expect(out.policy.useDeterministicContinuity).toBe(true);
      expect(out.policy.retrievalPath).toBe("deterministic");
      expect(out.policy.selectorProfile).toBe("status_continuity");
      expect(out.policy.hexis.enabled).toBe(false);
      // Recipe-id ↔ retrievalPath drift guard (Rúnir-5hug): the recipe's
      // declared path must match the policy-derived path.
      expect(out.recipe.id).toBe("compaction_projection");
      expect(out.recipe.retrievalPath).toBe("deterministic");
    }
  });
});

describe("evaluateHexisGate", () => {
  it("disables when policy hexis is disabled (lane_disabled)", () => {
    const gate = evaluateHexisGate(
      [hit("a", 0.9), hit("b", 0.5)],
      policyFor("session_opener"),
    );
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("lane_disabled");
  });

  it("disables with insufficient_candidates when fewer than 2 hits", () => {
    const gate = evaluateHexisGate(
      [hit("a", 0.9)],
      policyFor("exploratory_topic"),
    );
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("insufficient_candidates");
  });

  it("disables with top_gap_clear when the top score dominates", () => {
    const gate = evaluateHexisGate(
      [hit("a", 0.9), hit("b", 0.1)],
      policyFor("exploratory_topic"),
    );
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("top_gap_clear");
  });

  it("enables with ambiguous_boundary when top scores are close", () => {
    const gate = evaluateHexisGate(
      [hit("a", 0.9), hit("b", 0.89)],
      policyFor("exploratory_topic"),
    );
    expect(gate.enabled).toBe(true);
    expect(gate.reason).toBe("ambiguous_boundary");
  });

  it("reports zero ambiguityGap when scores are equal", () => {
    const gate = evaluateHexisGate(
      [hit("a", 0.5), hit("b", 0.5)],
      policyFor("exploratory_topic"),
    );
    expect(gate.ambiguityGap).toBe(0);
  });
});

describe("applyHexisByPolicy", () => {
  it("bypasses with bypass_lane_lambda when hexisLambda == 0", () => {
    const out = applyHexisByPolicy(
      [hit("a", 0.9), hit("b", 0.85)],
      null,
      policyFor("exact_lookup"),
    );
    expect(out.gate.reason).toBe("bypass_lane_lambda");
    expect(out.gate.enabled).toBe(false);
    expect(out.hits).toHaveLength(2);
    for (const h of out.hits) {
      expect(h.preHexisScore).toBeDefined();
      expect(h.postHexisScore).toBeDefined();
    }
  });

  it("returns the original hits when hexis state is null", () => {
    const hits = [hit("a", 0.9), hit("b", 0.89)];
    const out = applyHexisByPolicy(hits, null, policyFor("exploratory_topic"));
    expect(out.hits).toBe(hits);
    expect(out.gate.enabled).toBe(true);
  });

  it("returns the original hits when the gate disables", () => {
    const hits = [hit("a", 0.9), hit("b", 0.1)];
    const fakeHexis = { entries: [] } as unknown as HexisState;
    const out = applyHexisByPolicy(hits, fakeHexis, policyFor("exploratory_topic"));
    expect(out.hits).toBe(hits);
    expect(out.gate.enabled).toBe(false);
  });

  it("preserves all input hit ids in the output even on bypass", () => {
    const hits = [hit("alpha", 0.7), hit("beta", 0.6)];
    const out = applyHexisByPolicy(hits, null, policyFor("exact_lookup"));
    const ids = out.hits.map((h) => h.id).sort();
    expect(ids).toEqual(["alpha", "beta"]);
  });
});
