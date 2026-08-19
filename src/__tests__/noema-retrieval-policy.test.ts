import { describe, expect, it } from "vitest";
import type { SearchHit } from "../domain/memory/types";
import type { IntentSignal } from "../recall/intent/intent-analyzer";
import {
  mergeNoemaRetrievalLeg,
  resolveNoemaRetrievalPolicy,
} from "../recall/policy/noema-retrieval-policy.js";

function intent(label: IntentSignal["label"]): IntentSignal {
  return { label, categories: [], depth: "full", confidence: 0.9 };
}

function semiote(id: string, score: number, claimKey?: string): SearchHit {
  return {
    id: `semiote:${id}`,
    text: `Semiote ${id}`,
    score,
    sourceKind: "semiote",
    noemaClaimKey: claimKey,
  };
}

function noema(id: string, score: number, supportIds: string[] = [], claimKey = id): SearchHit {
  return {
    id: `noema:${id}`,
    text: `Noema ${id}`,
    score,
    sourceKind: "noema",
    noemaStatus: "active",
    noemaClaimKey: claimKey,
    noemaSupportSemioteIds: supportIds,
    active: true,
    rankingExplanation: ["noema:active"],
  };
}

describe("Noema retrieval policy", () => {
  it("allows active Noema to be primary only for stable/reference intents", () => {
    expect(resolveNoemaRetrievalPolicy(intent("preference"))).toMatchObject({
      mode: "primary",
      preferNoemaOverSupportingSemiote: true,
    });
    expect(resolveNoemaRetrievalPolicy(intent("architecture"))).toMatchObject({
      mode: "primary",
    });
  });

  it("keeps current/debug/recent intents on fresh Semiote evidence first", () => {
    for (const label of ["current_status", "recent_work", "debugging", "decision_trace", "session_opener"] as const) {
      expect(resolveNoemaRetrievalPolicy(intent(label))).toMatchObject({
        mode: "annotation",
        fallbackOnly: true,
      });
    }
  });

  it("dedupes supporting Semiotes when Noema is primary for the same claim", () => {
    const policy = resolveNoemaRetrievalPolicy(intent("preference"));
    const merged = mergeNoemaRetrievalLeg(
      [semiote("support-1", 0.99, "claim-editor"), semiote("other", 0.8, "claim-other")],
      [noema("editor", 0.9, ["support-1"], "claim-editor")],
      policy,
      5,
    );

    expect(merged.map((hit) => hit.id)).toEqual(["noema:editor", "semiote:other"]);
  });

  it("uses Noema only as fallback for annotation intents", () => {
    const policy = resolveNoemaRetrievalPolicy(intent("current_status"));
    expect(mergeNoemaRetrievalLeg([semiote("fresh", 0.7)], [noema("stable", 0.9)], policy, 5))
      .toEqual([semiote("fresh", 0.7)]);
    const fallback = mergeNoemaRetrievalLeg([], [noema("stable", 0.9)], policy, 5);
    expect(fallback[0]).toMatchObject({
      id: "noema:stable",
      rankingExplanation: ["noema:active", "noema:fallback_only"],
    });
    // Pins the annotation-fallback demotion factor: 0.9 * 0.6 = 0.54.
    expect(fallback[0].score).toBeCloseTo(0.54, 10);
  });

  it("filters inactive or rejected Noema candidates", () => {
    const policy = resolveNoemaRetrievalPolicy(intent("preference"));
    const rejected = { ...noema("rejected", 1), noemaStatus: "rejected" };
    const inactive = { ...noema("inactive", 1), active: false };

    expect(mergeNoemaRetrievalLeg([semiote("fresh", 0.7)], [rejected, inactive], policy, 5))
      .toEqual([semiote("fresh", 0.7)]);
  });

  it("does not surface a conflicted exclusive claim as an active answer", () => {
    const policy = resolveNoemaRetrievalPolicy(intent("preference"));
    const conflicted = {
      ...noema("atlas-on-call", 1, ["priya", "marcus"], "claim:atlas:on-call"),
      noemaStatus: "conflicted",
    };

    expect(mergeNoemaRetrievalLeg(
      [
        semiote("priya", 0.8, "claim:atlas:on-call"),
        semiote("marcus", 0.8, "claim:atlas:on-call"),
      ],
      [conflicted],
      policy,
      5,
    ).map((hit) => hit.id)).toEqual(["semiote:priya", "semiote:marcus"]);
  });
});
