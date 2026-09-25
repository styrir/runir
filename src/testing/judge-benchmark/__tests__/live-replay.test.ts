import { describe, expect, it } from "vitest";
import { classifyMerge, neitherContainsOther, replayLiveRow, type ReplayInput } from "../live-replay.js";

const input = (overrides: Partial<ReplayInput> = {}): ReplayInput => ({
  pairId: "ss-000000000001", gold: "independent", appliedOutcome: "merge-update",
  oldText: "Atlas is blue.", incomingText: "Atlas has a second feature.",
  oldId: "old", oldCreatedAt: "2026-09-25T09:00:00Z", occurredAt: "2026-09-25T09:01:00Z",
  cosine: 0.9, oldTags: [], incomingTags: [], sameSession: true,
  flags: { cueGate: false, temporalGuard: false, keepBothGuard: false, addSkipGuard: false,
    judgeGate: false, f2JudgeConfirm: false, atomicIdentityProof: false },
  ...overrides,
});

describe("W1 live replay", () => {
  it("uses the real resolver and records a reproduced merge band", () => {
    const row = replayLiveRow(input());
    expect(row.reproduced).toBe(true);
    expect(row.band).toBe("merge-band");
    expect(row.mergeKind).toBe("sentence_union");
    expect(row.oldBeforeDecision).toBe(true);
  });
  it("keeps mismatch and unsupported flags distinct from reproduction", () => {
    expect(replayLiveRow(input({ appliedOutcome: "supersede" })).reproduced).toBe(false);
    expect(replayLiveRow(input({ flags: { ...input().flags, judgeGate: true } })).unreplayable).toBe("unsupported_live_flags");
  });
  it("classifies containment and the 1200-character longer-text fallback", () => {
    expect(classifyMerge("Atlas is blue.", "Atlas is blue. It is large.")).toBe("containment_replacement");
    expect(classifyMerge("A".repeat(650) + ".", "B".repeat(650) + ".")).toBe("longer_text_1200");
  });
  it("replays optional guards and counts when neither side contains the other", () => {
    const baseline = replayLiveRow(input());
    const guarded = replayLiveRow(input({ flags: { ...input().flags, mergeKeepBothOnFusion: true } }));
    expect(baseline.replayOutcome).toBe("merge-update");
    expect(guarded.replayOutcome).toBe("create");
    expect(neitherContainsOther("Atlas is blue.", "Atlas has a second feature.")).toBe(true);
    expect(neitherContainsOther("Atlas is blue.", "Atlas is blue. It is large.")).toBe(false);
    expect(neitherContainsOther("A".repeat(650) + ".", "B".repeat(650) + ".")).toBe(true);
  });
});
