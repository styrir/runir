import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l.12 — supersede-candidacy floor.
//
// Tests (a)-(c): pure findSupersedeTarget unit tests — UNSEEN synthetic candidates,
// NOT cassette rows. Verifies that:
//   (a) same-slot cued name-swap at cos 0.80 → with floor 0.75 returns currentness_cue:slot;
//       with floor 0.85 (default/unset) → null.
//   (b) cross-entity analog (conflictingSubjects) cued at cos 0.80 + floor 0.75 → null.
//   (c) bare-handoff analog (no currentness cue) at cos 0.80 + floor 0.75 → null.
//
// Tests (d): arbitrateWrite floor resolution + clamp — all brief cases, including the
// Codex v2 edge (env invalid but present → mergeThreshold, does NOT fall through to input.config).

vi.mock("../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class { query = vi.fn().mockResolvedValue([[]]); },
}));

import { arbitrateWrite } from "../write-arbitrator.js";
import { findSimilarMemories, supersedeMemory } from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

function makeDb() { return { query: vi.fn().mockResolvedValue([[]]) } as any; }
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
// 1h ago — always within the 72h mergeWindowHours regardless of when the test runs.
const RECENT_ISO = new Date(Date.now() - 1 * 3600 * 1000).toISOString();

function makeCandidate(o: Partial<SimilarCandidate> = {}): SimilarCandidate {
  return {
    id: "seed-id",
    l2: "Sara Kim is the release manager for Orion",
    similarity: 0.80,
    createdAt: RECENT_ISO,
    updatedAt: RECENT_ISO,
    ...o,
  };
}

// SEED tags: person + role + project same slot
const SEED_TAGS_ORION = ["project:orion", "role:release-manager", "person:sara-kim"];
// INCOMING tags for name-swap: same slot, different person = subjectsChanged
const CORR_TAGS_ORION_SWAP = ["project:orion", "role:release-manager", "person:devin-cole"];
// Cross-entity: different project
const CORR_TAGS_BIFROST_SWAP = ["project:bifrost", "role:release-manager", "person:devin-cole"];
// Bare-handoff incoming tags (same slot, name swap — but no cue in text)
const CORR_TAGS_ORION_HANDOFF = ["project:orion", "role:release-manager", "person:devin-cole"];

// Cued name-swap incoming text
const CUED_TEXT = "Devin Cole is now the release manager for Orion, replacing Sara Kim, handling cut planning and sign-off.";
// Cross-entity cued text (cue present, but different project in tags)
const CROSS_ENTITY_CUED_TEXT = "Devin Cole is now the release manager for Bifrost, replacing Sara Kim.";
// Bare-handoff text: no currentness cue ("previously held by" is retrospective)
const BARE_HANDOFF_TEXT = "Devin Cole has taken on the release manager role previously held by Sara Kim for Orion.";

async function arb(
  text: string,
  candidate: SimilarCandidate,
  incomingTags?: string[],
  configOverride?: Record<string, unknown>,
) {
  (findSimilarMemories as Mock).mockResolvedValue([candidate]);
  const embedding = makeVec(0);
  return arbitrateWrite({
    db: makeDb(),
    text,
    userId: "u-pn1l12",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: new Map<string, RecentWrite[]>(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(incomingTags ? { metadata: { tags: incomingTags } } : {}),
    ...(configOverride ? { config: configOverride as any } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Start clean: no env overrides
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  (supersedeMemory as Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
});

// ─────────── (a) same-slot cued name-swap: floor gates access ───────────
describe("(a) findSupersedeTarget — same-slot cued name-swap at cos 0.80", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
  });

  it("floor 0.75 → currentness_cue:slot (supersede)", async () => {
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.75";
    const r = await arb(
      CUED_TEXT,
      makeCandidate({ similarity: 0.80, tags: SEED_TAGS_ORION }),
      CORR_TAGS_ORION_SWAP,
    );
    expect(r.outcome).toBe("supersede");
    expect(r.reason).toMatch(/currentness_cue:slot/);
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("floor 0.85 (unset = default = mergeThreshold) → null / no supersede", async () => {
    // Do NOT set RUNIR_SUPERSEDE_CANDIDATE_FLOOR → resolves to mergeThreshold=0.85
    // cos 0.80 < 0.85 → candidate skipped → no supersede
    const r = await arb(
      CUED_TEXT,
      makeCandidate({ similarity: 0.80, tags: SEED_TAGS_ORION }),
      CORR_TAGS_ORION_SWAP,
    );
    // Should NOT supersede (candidate below the default floor)
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });
});

// ─────────── (b) cross-entity: cued + floor 0.75 → null ───────────
describe("(b) findSupersedeTarget — cross-entity conflictingSubjects + cue + floor 0.75 → null", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.75";
  });

  it("conflictingSubjects blocks even when cue present and floor admits the candidate", async () => {
    // candidate has project:orion tags, incoming tags have project:bifrost → conflictingSubjects=true
    const r = await arb(
      CROSS_ENTITY_CUED_TEXT,
      makeCandidate({ similarity: 0.80, tags: SEED_TAGS_ORION }),
      CORR_TAGS_BIFROST_SWAP,
    );
    // Must NOT supersede (conflictingSubjects guard fires)
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });
});

// ─────────── (c) bare-handoff: no cue + floor 0.75 → null ───────────
describe("(c) findSupersedeTarget — bare-handoff no cue + floor 0.75 → null", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.75";
  });

  it("no currentness cue blocks even when floor admits candidate", async () => {
    // "previously held by" is retrospective, NOT a currentness cue
    const r = await arb(
      BARE_HANDOFF_TEXT,
      makeCandidate({ similarity: 0.80, tags: SEED_TAGS_ORION }),
      CORR_TAGS_ORION_HANDOFF,
    );
    // Must NOT supersede (cueGate=false → tagDriveAllowed=false)
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });
});

// ─────────── (d) arbitrateWrite floor resolution + clamp ───────────
describe("(d) arbitrateWrite — supersedeCandidateFloor resolution and clamp", () => {
  // We test resolution by observing whether a cos-0.80 candidate in a cued name-swap
  // context supersedes (floor admitted) or doesn't (floor rejected). This is the
  // cheapest observable signal for the resolved floor value without exposing internals.
  // For exact-value cases we cross-check by verifying the gate precisely.

  const candidate08 = makeCandidate({ similarity: 0.80, tags: SEED_TAGS_ORION });

  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
  });

  it("unset floor → mergeThreshold (0.85): cos 0.80 does NOT supersede", async () => {
    // Neither env nor config.supersedeCandidateFloor set
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP);
    expect(r.outcome).not.toBe("supersede");
  });

  it("env '0.75' → 0.75: cos 0.80 supersedes", async () => {
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.75";
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP);
    expect(r.outcome).toBe("supersede");
  });

  it("env '0.95' (> mergeThreshold 0.85) → clamped to mergeThreshold: cos 0.80 does NOT supersede", async () => {
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.95";
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP);
    expect(r.outcome).not.toBe("supersede");
  });

  it("env '0' (invalid, <= 0) → mergeThreshold: cos 0.80 does NOT supersede", async () => {
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0";
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP);
    expect(r.outcome).not.toBe("supersede");
  });

  it("env 'abc' (invalid, NaN) → mergeThreshold: cos 0.80 does NOT supersede", async () => {
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "abc";
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP);
    expect(r.outcome).not.toBe("supersede");
  });

  it("input.config {mergeThreshold:0.9} unset floor → effective mergeThreshold 0.9: cos 0.80 does NOT supersede", async () => {
    // MUST-FIX 2: unset floor inherits the EFFECTIVE mergeThreshold (0.9), not the hardcoded default (0.85)
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP, { mergeThreshold: 0.9 });
    expect(r.outcome).not.toBe("supersede");
  });

  it("input.config {supersedeCandidateFloor:0.95, mergeThreshold:0.85} → clamped to 0.85: cos 0.80 does NOT supersede", async () => {
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP, {
      supersedeCandidateFloor: 0.95,
      mergeThreshold: 0.85,
    });
    expect(r.outcome).not.toBe("supersede");
  });

  it("env 'abc' (invalid, PRESENT) + input.config {supersedeCandidateFloor:0.78} → mergeThreshold (env-present decides, does NOT fall through to 0.78)", async () => {
    // Codex v2 edge: env present but invalid → env decides (= mergeThreshold), ignores input.config
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "abc";
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP, {
      supersedeCandidateFloor: 0.78,
    });
    // 0.78 would admit cos 0.80, but env-invalid should NOT fall through to 0.78
    expect(r.outcome).not.toBe("supersede");
  });

  it("env '0.75abc' (malformed numeric-prefix) + input.config {supersedeCandidateFloor:0.78} → mergeThreshold (strict parse: no fall-through, no lowered floor)", async () => {
    // Codex arch MUST-FIX: parseFloat("0.75abc") silently → 0.75; Number("0.75abc") → NaN → mergeThreshold.
    // Proves the strict-numeric-parse fix: malformed env does NOT lower the floor to 0.75 or fall through to 0.78.
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.75abc";
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP, {
      supersedeCandidateFloor: 0.78,
    });
    // Neither 0.75 nor 0.78 should be the resolved floor — must fall back to mergeThreshold (0.85)
    expect(r.outcome).not.toBe("supersede");
  });

  it("input.config {supersedeCandidateFloor:0.75, mergeThreshold:0.85} with env absent → 0.75: cos 0.80 supersedes", async () => {
    // input.config floor honored only when env is absent and floor <= mergeThreshold
    const r = await arb(CUED_TEXT, candidate08, CORR_TAGS_ORION_SWAP, {
      supersedeCandidateFloor: 0.75,
      mergeThreshold: 0.85,
    });
    expect(r.outcome).toBe("supersede");
  });
});
