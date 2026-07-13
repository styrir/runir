import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l.5 — merge-band keep-both guard. The merge band must NOT fold two
// high-cosine facts into one row when they are cross-entity (conflictingSubjects)
// or an ambiguous same-slot value-change with no cue (bare handoff). Behind
// RUNIR_MERGE_KEEPBOTH_GUARD (default OFF): on ⇒ such candidates CREATE (keep both);
// off ⇒ byte-for-byte today's merge-update. Never supersede (conservative).

vi.mock("../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  logSupersedeShadow: vi.fn().mockResolvedValue(undefined),
  ensureSupersedeShadowTable: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class { query = vi.fn().mockResolvedValue([[]]); },
}));

import { arbitrateWrite, mergeKeepBothReason } from "../write-arbitrator.js";
import {
  findSimilarMemories,
  logSupersedeShadow,
  supersedeMemory,
  updateMemoryText,
} from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

const mockLogSupersedeShadow = logSupersedeShadow as Mock;

function makeDb() { return { query: vi.fn().mockResolvedValue([[]]) } as any; }
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(o: Partial<SimilarCandidate> = {}): SimilarCandidate {
  const now = new Date().toISOString();
  // 0.90 lands in the merge band [mergeThreshold 0.85, skipThreshold 0.95) so pass 5 is reached.
  return { id: "seed-id", l2: "Priya Nair is the on-call lead for Atlas", similarity: 0.90, createdAt: now, updatedAt: now, ...o };
}
async function arb(text: string, candidate: SimilarCandidate, tags?: string[]) {
  (findSimilarMemories as Mock).mockResolvedValue([candidate]);
  const embedding = makeVec(0);
  return arbitrateWrite({
    db: makeDb(), text, userId: "u1", embedding, scope: "user", source: "memory_store",
    recentWrites: new Map<string, RecentWrite[]>(), embedText: vi.fn().mockResolvedValue(embedding),
    ...(tags ? { metadata: { tags } } : {}),
  });
}

const SEED_TAGS = ["project:atlas", "role:on-call-lead", "person:priya-nair"];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
  mockLogSupersedeShadow.mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
});

describe("merge-band keep-both guard — gate OFF (default, byte-for-byte)", () => {
  it("cross-entity in-band still merge-updates when the guard is off", async () => {
    const r = await arb("Marcus Webb leads on-call for Bifrost", makeCandidate({ tags: SEED_TAGS }),
      ["project:bifrost", "role:on-call-lead", "subject:marcus-webb"]);
    expect(r.outcome).toBe("merge-update");
  });
});

describe("merge-band keep-both guard — gate ON", () => {
  beforeEach(() => { process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1"; });

  it("cross-entity in-band → CREATE (keep both), reason names conflicting-subjects; never supersede", async () => {
    const r = await arb("Marcus Webb leads on-call for Bifrost", makeCandidate({ tags: SEED_TAGS }),
      ["project:bifrost", "role:on-call-lead", "subject:marcus-webb"]);
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/conflicting-subjects/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("cross-entity in-band: shadowCandidateSnapshot replays to the SAME reason via mergeKeepBothReason (pn1l.13.6 AC4)", async () => {
    // Codex round-2 refinement #2: compare against the INNER mergeKeepBothReason return
    // ("conflicting-subjects"), not the full wrapped public reason string.
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const incomingText = "Marcus Webb leads on-call for Bifrost";
    const incomingTags = ["project:bifrost", "role:on-call-lead", "subject:marcus-webb"];
    const r = await arb(incomingText, makeCandidate({ tags: SEED_TAGS }), incomingTags);
    expect(r.outcome).toBe("create");

    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.candidateSnapshotJson).not.toBeNull();
    const snapshot = JSON.parse(call.candidateSnapshotJson);
    const parsedIncomingTags = JSON.parse(call.incomingTagsJson);
    expect(call.incomingTextFull).toBe(incomingText);
    expect(parsedIncomingTags).toEqual(incomingTags);

    // Reconstruct a SimilarCandidate-shaped object from the snapshot and replay.
    const replayedReason = mergeKeepBothReason(
      { ...snapshot, similarity: 0.90, createdAt: new Date().toISOString() } as SimilarCandidate,
      call.incomingTextFull,
      parsedIncomingTags,
    );
    expect(replayedReason).toBe("conflicting-subjects");
    expect(r.reason).toMatch(/conflicting-subjects/);
  });

  it("cue-less same-slot handoff in-band → CREATE (keep both), reason names ambiguous-slot-change-no-cue", async () => {
    const r = await arb("Marcus Webb is the on-call lead", makeCandidate({ tags: SEED_TAGS }),
      ["project:atlas", "role:on-call-lead", "subject:marcus-webb"]);
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/ambiguous-slot-change-no-cue/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("cue-less same-slot handoff in-band: shadowCandidateSnapshot replays to the SAME reason via mergeKeepBothReason (pn1l.13.6 AC4)", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const incomingText = "Marcus Webb is the on-call lead";
    const incomingTags = ["project:atlas", "role:on-call-lead", "subject:marcus-webb"];
    const r = await arb(incomingText, makeCandidate({ tags: SEED_TAGS }), incomingTags);
    expect(r.outcome).toBe("create");

    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.candidateSnapshotJson).not.toBeNull();
    const snapshot = JSON.parse(call.candidateSnapshotJson);
    const parsedIncomingTags = JSON.parse(call.incomingTagsJson);

    const replayedReason = mergeKeepBothReason(
      { ...snapshot, similarity: 0.90, createdAt: new Date().toISOString() } as SimilarCandidate,
      call.incomingTextFull,
      parsedIncomingTags,
    );
    expect(replayedReason).toBe("ambiguous-slot-change-no-cue");
    expect(r.reason).toMatch(/ambiguous-slot-change-no-cue/);
  });

  it("same-subject additive (no value change) does NOT trigger the guard — merge-update as before", async () => {
    const r = await arb("Priya Nair also handles the weekend rotation", makeCandidate({ tags: SEED_TAGS }), SEED_TAGS);
    expect(r.outcome).toBe("merge-update");
  });

  it("marker-present (tagged correction) bypasses the guard (w077 create, not a guard create)", async () => {
    const r = await arb("Marcus Webb is the on-call lead", makeCandidate({ tags: SEED_TAGS }),
      ["project:atlas", "role:on-call-lead", "subject:marcus-webb", "update"]);
    // w077: tagged correction with no compatible supersede target → create, but NOT via the keep-both guard.
    expect(r.reason ?? "").not.toMatch(/keep-both guard/);
  });

  it("cued same-slot value change still SUPERSEDES via the cue path (guard does not intercept)", async () => {
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    const r = await arb("Marcus Webb is now the on-call lead, replacing Priya Nair", makeCandidate({ tags: SEED_TAGS }),
      ["project:atlas", "role:on-call-lead", "subject:marcus-webb"]);
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });
});
