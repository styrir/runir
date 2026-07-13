import { describe, it, expect } from "vitest";
import {
  mapIntentToRecallLane,
  resolveRetrievalPolicyForLane,
} from "../retrieval-policy.js";
import type { RecallLane } from "../policy-types.js";
import type { QueryIntent } from "../../intent/intent-analyzer.js";

describe("mapIntentToRecallLane", () => {
  const cases: Array<[QueryIntent, RecallLane]> = [
    ["session_opener", "session_opener"],
    ["current_status", "current_status"],
    ["latest_state", "latest_state"],
    ["architecture", "guidance_reference"],
    ["workflow_posture", "workflow_posture"],
    ["recent_work", "recent_work"],
    ["exact_lookup", "exact_lookup"],
    ["decision_trace", "decision_trace"],
    ["decision", "decision_trace"],
    ["exploratory_topic", "exploratory_topic"],
    ["entity", "exact_lookup"],
    ["schema", "exact_lookup"],
    ["debugging", "exact_lookup"],
    ["preference", "exact_lookup"],
    ["event", "exploratory_topic"],
    ["unknown_mixed", "unknown_mixed"],
    ["fact", "unknown_mixed"],
  ];

  for (const [label, expected] of cases) {
    it(`maps ${label} -> ${expected}`, () => {
      expect(mapIntentToRecallLane(label)).toBe(expected);
    });
  }

  it("falls through to unknown_mixed for an unrecognized label", () => {
    expect(mapIntentToRecallLane("garbage_label" as QueryIntent)).toBe("unknown_mixed");
  });
});

describe("resolveRetrievalPolicyForLane", () => {
  const allLanes: RecallLane[] = [
    "session_opener",
    "current_status",
    "latest_state",
    "guidance_reference",
    "workflow_posture",
    "exact_lookup",
    "recent_work",
    "decision_trace",
    "exploratory_topic",
    "unknown_mixed",
  ];

  for (const lane of allLanes) {
    it(`returns a policy whose lane equals the input (${lane})`, () => {
      expect(resolveRetrievalPolicyForLane(lane).lane).toBe(lane);
    });
  }

  it("session_opener uses deterministic path and disables hexis", () => {
    const p = resolveRetrievalPolicyForLane("session_opener");
    expect(p.retrievalPath).toBe("deterministic");
    expect(p.useDeterministicContinuity).toBe(true);
    expect(p.useLatestStateResolution).toBe(false);
    expect(p.hexis.enabled).toBe(false);
    expect(p.hexis.hexisLambda).toBe(0);
  });

  it("current_status uses deterministic path and disables hexis", () => {
    const p = resolveRetrievalPolicyForLane("current_status");
    expect(p.retrievalPath).toBe("deterministic");
    expect(p.hexis.enabled).toBe(false);
  });

  it("latest_state uses latest_state retrieval and strict hexis", () => {
    const p = resolveRetrievalPolicyForLane("latest_state");
    expect(p.retrievalPath).toBe("latest_state");
    expect(p.useLatestStateResolution).toBe(true);
    expect(p.hexis.enabled).toBe(true);
    expect(p.hexis.hexisLambda).toBe(0.1);
  });

  it("guidance_reference uses hybrid with reduced hexisLambda", () => {
    const p = resolveRetrievalPolicyForLane("guidance_reference");
    expect(p.retrievalPath).toBe("hybrid");
    expect(p.hexis.enabled).toBe(true);
    expect(p.hexis.hexisLambda).toBe(0.05);
    expect(p.recencyWindowHours).toBe(12);
    expect(p.rrfWeights?.bm25).toBe(1.45);
  });

  it("workflow_posture uses hybrid with reduced hexisLambda and 18h window", () => {
    const p = resolveRetrievalPolicyForLane("workflow_posture");
    expect(p.retrievalPath).toBe("hybrid");
    expect(p.hexis.hexisLambda).toBe(0.05);
    expect(p.recencyWindowHours).toBe(18);
  });

  it("exact_lookup zeroes hexisLambda but keeps hybrid path", () => {
    const p = resolveRetrievalPolicyForLane("exact_lookup");
    expect(p.retrievalPath).toBe("hybrid");
    expect(p.hexis.hexisLambda).toBe(0);
  });

  it("recent_work uses hybrid with a 24h recency window", () => {
    const p = resolveRetrievalPolicyForLane("recent_work");
    expect(p.retrievalPath).toBe("hybrid");
    expect(p.recencyWindowHours).toBe(24);
    expect(p.hexis.enabled).toBe(true);
  });

  it("decision_trace uses hybrid with full hexisLambda", () => {
    const p = resolveRetrievalPolicyForLane("decision_trace");
    expect(p.retrievalPath).toBe("hybrid");
    expect(p.hexis.hexisLambda).toBe(0.25);
    expect(p.recencyWindowHours).toBe(18);
  });

  it("exploratory_topic uses hybrid with full hexisLambda and 48h window", () => {
    const p = resolveRetrievalPolicyForLane("exploratory_topic");
    expect(p.retrievalPath).toBe("hybrid");
    expect(p.hexis.hexisLambda).toBe(0.25);
    expect(p.recencyWindowHours).toBe(48);
  });

  it("unknown_mixed uses hybrid with lambda=0.2", () => {
    const p = resolveRetrievalPolicyForLane("unknown_mixed");
    expect(p.retrievalPath).toBe("hybrid");
    expect(p.hexis.hexisLambda).toBe(0.2);
    expect(p.recencyWindowHours).toBe(48);
  });

  it("unknown lanes fall through to the default branch (hybrid + mixed_default)", () => {
    const p = resolveRetrievalPolicyForLane("does_not_exist" as RecallLane);
    expect(p.retrievalPath).toBe("hybrid");
    expect(p.selectorProfile).toBe("mixed_default");
  });
});
