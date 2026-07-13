import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l.10 — distinct-occasion guard (Guard 1, merge band) + additive-aware
// skip guard (Guard 2, skip band). Both default-OFF.
//
// Guard 1: in mergeKeepBothReason, behind RUNIR_MERGE_KEEPBOTH_GUARD, a new branch
//   fires "distinct-occasion" when BOTH candidate and incoming carry a same-TYPE but
//   DIFFERENT structural qualifier (quarter, ISO-date, year, occasion word) AND subjects
//   are non-conflicting + shared.
// Guard 2: at BOTH skip bands, behind RUNIR_ADDITIVE_SKIP_GUARD, a new
//   isAdditiveContent check fires "create" when the incoming adds >=3 novel tokens AND
//   novelty ratio >= 0.40 (vs candidate), instead of skipping.

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
import { findSimilarMemories, supersedeMemory, updateMemoryText } from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

function makeDb() { return { query: vi.fn().mockResolvedValue([[]]) } as any; }

// A unit vector pointing in direction `seed` mod `len`.
function makeVec(seed: number, len = 16): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

// Embedding that scores exactly `sim` cosine against makeVec(0,16).
// We use a two-component trick: [sim, sqrt(1-sim^2), 0...0] vs [1,0,...] → cos = sim.
function _makeVecAtSim(sim: number, len = 16): number[] {
  const v = Array<number>(len).fill(0);
  v[0] = sim;
  v[1] = Math.sqrt(Math.max(0, 1 - sim * sim));
  return v;
}

function makeCandidate(o: Partial<SimilarCandidate> & { l2: string; similarity: number }): SimilarCandidate {
  const now = new Date().toISOString();
  return {
    id: "cand-id",
    createdAt: now,
    updatedAt: now,
    ...o,
  };
}

async function arb(
  text: string,
  candidate: SimilarCandidate,
  opts: { incomingTags?: string[]; env?: Record<string, string> } = {},
) {
  // We use an embedding that matches the candidate similarity by using makeVecAtSim.
  // The candidate's similarity field is what resolveDecision compares against the thresholds;
  // for the recent-in-memory band we need a real cosine, so we set up differently.
  (findSimilarMemories as Mock).mockResolvedValue([candidate]);
  const embedding = makeVec(0, 16);
  return arbitrateWrite({
    db: makeDb(),
    text,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: new Map<string, RecentWrite[]>(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(opts.incomingTags ? { metadata: { tags: opts.incomingTags } } : {}),
  });
}

// For Guard 2 skip-band tests we need the candidate's similarity >= 0.95.
// We supply it via similarCandidates (findSimilarMemories mock).
async function arbWithCandidateAtSim(
  text: string,
  candidateText: string,
  sim: number,
  opts: { incomingTags?: string[]; candidateTags?: string[]; candidateTier?: string } = {},
) {
  const now = new Date().toISOString();
  const candidate: SimilarCandidate = {
    id: "cand-skip-id",
    l2: candidateText,
    similarity: sim,
    createdAt: now,
    updatedAt: now,
    ...(opts.candidateTags ? { tags: opts.candidateTags } : {}),
    ...(opts.candidateTier ? { tier: opts.candidateTier as any } : {}),
  };
  (findSimilarMemories as Mock).mockResolvedValue([candidate]);
  const embedding = makeVec(0, 16);
  return arbitrateWrite({
    db: makeDb(),
    text,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: new Map<string, RecentWrite[]>(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(opts.incomingTags ? { metadata: { tags: opts.incomingTags } } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 1 — distinct-occasion anchor (merge band)
// Requires RUNIR_MERGE_KEEPBOTH_GUARD=1; similarity in merge band [0.85, 0.95).
// ─────────────────────────────────────────────────────────────────────────────

describe("Guard 1 — distinct-occasion anchor (merge band)", () => {
  const ATLAS_TAGS = ["project:atlas", "person:priya-nair"];

  beforeEach(() => {
    process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1";
  });

  // (a) Same-subject Q1 vs Q2 → "distinct-occasion" → CREATE (keep both)
  it("(a) same-subject Q1 vs Q2 different occasion → CREATE with distinct-occasion reason", async () => {
    const candidate = makeCandidate({
      l2: "Q1 Atlas standup: team aligned on Postgres migration timeline, owners confirmed.",
      similarity: 0.867,
      tags: ATLAS_TAGS,
    });
    const r = await arb(
      "Q2 Atlas standup: team realigned on Postgres migration timeline, Redis added to scope.",
      candidate,
      { incomingTags: ATLAS_TAGS },
    );
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/distinct-occasion/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  // (b) Same-subject, same/no anchor (paraphrase) → null (still folds / merge-update)
  // Texts have the SAME statement key prefix ("the atlas project standup") to ensure
  // F1 (wouldSupersedeTexts) does NOT fire — same key → same value → no supersede.
  // The candidate and incoming say the same thing (paraphrase), landing in merge band
  // with no distinct temporal anchor on either side → guard must NOT fire → merge-update.
  it("(b) same-subject no temporal anchor (paraphrase) → merge-update (guard does not fire)", async () => {
    const candidate = makeCandidate({
      // Statement key: "the atlas project standup covered the postgres migration and owners"
      // No quarter/date/year qualifier — no anchor.
      l2: "The Atlas project standup covered the Postgres migration and the assigned owners.",
      similarity: 0.867,
      tags: ATLAS_TAGS,
    });
    const r = await arb(
      // Same key prefix, essentially same value (paraphrase) — no anchor on either side.
      "The Atlas project standup covered the Postgres migration and the assigned owners.",
      candidate,
      { incomingTags: ATLAS_TAGS },
    );
    // No distinct anchor on either side → guard does not fire → skip (exact normalized dup)
    // or merge-update; either is acceptable as long as it is NOT create via distinct-occasion.
    expect(["skip", "merge-update"]).toContain(r.outcome);
    if (r.outcome === "create") {
      expect(r.reason).not.toMatch(/distinct-occasion/);
    }
  });

  // (c) "second engineer" bare ordinal → NOT an anchor (no false fire)
  it("(c) bare ordinal word 'second' is not a structural qualifier → guard does not fire", async () => {
    const candidate = makeCandidate({
      l2: "The first engineer on the Atlas team is Dana Cole.",
      similarity: 0.867,
      tags: ATLAS_TAGS,
    });
    const r = await arb(
      "The second engineer on the Atlas team is Marcus Webb.",
      candidate,
      { incomingTags: ATLAS_TAGS },
    );
    // "first"/"second" are bare ordinals — must NOT be treated as distinct-occasion anchors.
    // This resolves to CREATE because of conflicting-subjects (dana-cole vs marcus-webb),
    // but the reason must NOT name distinct-occasion.
    if (r.outcome === "create") {
      expect(r.reason).not.toMatch(/distinct-occasion/);
    }
    // If it merges (no subject tag conflict), that's also acceptable — just not distinct-occasion.
  });

  // (d) Cross-entity both carrying a quarter → conflicting-subjects fires FIRST (not distinct-occasion)
  it("(d) cross-entity both carrying a quarter → conflicting-subjects reason, not distinct-occasion", async () => {
    const candidate = makeCandidate({
      l2: "Q1 Bifrost standup: Dana Cole presented the new cache design.",
      similarity: 0.867,
      tags: ["project:bifrost", "person:dana-cole"],
    });
    const r = await arb(
      "Q2 Atlas standup: Marcus Webb presented the Postgres migration plan.",
      candidate,
      { incomingTags: ["project:atlas", "person:marcus-webb"] },
    );
    expect(r.outcome).toBe("create");
    // conflicting-subjects guard fires FIRST (different project+person tags → disjoint subjects)
    expect(r.reason).toMatch(/conflicting-subjects/);
    expect(r.reason).not.toMatch(/distinct-occasion/);
  });

  // Codex REVISE must-fix: shared-subject predicate must require BOTH sides to have subject tags.
  // Missing subject evidence on either side is NOT shared-subject evidence.

  // (d2) Q1 vs Q2 anchors but incoming has NO subject tags → guard must NOT fire
  it("(d2) Q1 vs Q2 anchor but incoming has no subject tags → distinct-occasion does NOT fire", async () => {
    const candidate = makeCandidate({
      l2: "Q1 Atlas standup: team aligned on Postgres migration timeline.",
      similarity: 0.867,
      tags: ["project:atlas", "person:priya-nair"],
    });
    const r = await arb(
      "Q2 Atlas standup: team realigned on Postgres migration timeline.",
      candidate,
      // intentionally no incomingTags → subjectValues(undefined) = empty set
      {},
    );
    // b.size === 0 → hasSharedSubject must be false → guard does NOT fire
    if (r.outcome === "create") {
      expect(r.reason).not.toMatch(/distinct-occasion/);
    }
  });

  // (d3) Q1 vs Q2 anchors but subjects are disjoint (bifrost vs speki) → guard must NOT fire
  it("(d3) Q1 vs Q2 anchor but subjects disjoint (bifrost vs speki) → distinct-occasion does NOT fire", async () => {
    const candidate = makeCandidate({
      l2: "Q1 Bifrost board meeting covered the quarterly roadmap.",
      similarity: 0.867,
      tags: ["project:bifrost"],
    });
    const r = await arb(
      "Q2 Speki board meeting covered the quarterly roadmap.",
      candidate,
      { incomingTags: ["project:speki"] },
    );
    // conflicting-subjects fires first (bifrost ≠ speki → disjoint subjects)
    // OR distinct-occasion must NOT fire — either way reason must not name distinct-occasion
    if (r.outcome === "create") {
      // conflicting-subjects should fire here (disjoint projects)
      expect(r.reason).not.toMatch(/distinct-occasion/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 2 — additive-aware skip (skip band, cos >= 0.95)
// Requires RUNIR_ADDITIVE_SKIP_GUARD=1; similarity >= skipThreshold (0.95).
// ─────────────────────────────────────────────────────────────────────────────

describe("Guard 2 — additive-aware skip (skip band, cos >= 0.95)", () => {
  // Texts designed so contentTokens produces the expected novelty ratios.
  // contentTokens: lowercase, split /[^a-z0-9]+/, len >= 4, not in GENERIC_VALUE_TOKENS.
  //
  // GENERIC_VALUE_TOKENS = { tech, lead, main, true, false, user, team, data, work,
  //                           type, name, role, item, project, active, status, value,
  //                           thing, stuff, info }
  //
  // IMPORTANT: texts must NOT share the same deriveStatementKey prefix (to avoid F1 supersede).
  // We use distinct leading subjects so the statement-key comparison fails → F1 does not fire.
  //
  // Guard 2 positive (e):
  //   candidate key  = "dana cole owns the atlas oncall roster covering postgres incidents"
  //   incoming key   = "dana cole owns the atlas oncall roster covering postgres" → same!
  //   Use DIFFERENT statement keys by changing the subject structure.
  //   Instead: candidate starts with "dana", incoming starts with "the atlas oncall roster" — different keys.
  //
  // Strategy: make candidate start with one subject, incoming start with a DIFFERENT subject phrasing
  // so deriveStatementKey diverges → F1 can't fire. Then ensure cos>=0.95 via mock.
  //
  // Candidate (additive positive, e):
  //   "Dana Cole owns the Atlas oncall roster, covering Postgres incidents and Redis escalations."
  //   tokens: {dana, cole, owns, atlas, oncall, roster, covering, postgres, incidents, redis, escalations} — minus owned: all >=4, none generic
  //   Actually 'owns' is 4 chars, not in GENERIC_VALUE_TOKENS → included.
  //   tokens: {dana,cole,owns,atlas,oncall,roster,covering,postgres,incidents,redis,escalations} = 11
  //
  // Incoming (additive positive):
  //   "The Atlas oncall roster, owned by Dana Cole, covers Postgres incidents, Redis escalations, and now the nightly backup runbook and cache layer."
  //   Novel tokens beyond candidate: {nightly, backup, runbook, cache, layer, covers, owned} → some are >=4
  //   novel = {nightly,backup,runbook,cache,layer,covers,owned} = 7
  //   incoming total tokens: {atlas,oncall,roster,owned,dana,cole,covers,postgres,incidents,redis,escalations,nightly,backup,runbook,cache,layer} ≈ 16
  //   novelty = 7/16 ≈ 0.44 >= 0.40 ✓; novel >= 3 ✓ → FIRE (create)
  //   statement key of candidate: "dana cole owns the atlas oncall"
  //   statement key of incoming:  "the atlas oncall roster" → DIFFERENT → F1 safe

  const CANDIDATE_TEXT = "Dana Cole owns the Atlas oncall roster, covering Postgres incidents and Redis escalations.";
  const ADDITIVE_INCOMING = "The Atlas oncall roster, owned by Dana Cole, covers Postgres incidents, Redis escalations, and now the nightly backup runbook and cache layer.";

  // Pure paraphrase negative (f):
  //   Candidate: "Priya Nair leads the Atlas Postgres oncall rotation."
  //   Incoming:  "Priya Nair heads the Atlas Postgres oncall group."
  //   candidate tokens: {priya,nair,leads,atlas,postgres,oncall,rotation} = 7
  //   incoming tokens:  {priya,nair,heads,atlas,postgres,oncall,group} = 7
  //   shared: {priya,nair,atlas,postgres,oncall} = 5; novel = {heads,group} = 2; novelty = 2/7 ≈ 0.29
  //   Wait: 0.29 >= 0.40? No → guard does not fire ✓
  //   Actually let's verify: 'leads' vs 'heads', 'rotation' vs 'group' — 2 novel tokens; novelty = 2/7 < 0.40 → skip ✓
  //   statement key of candidate: first delimiter is space-delimited 8 words or first ":" — "priya nair leads the atlas postgres oncall rotation"
  //   statement key of incoming:  "priya nair heads the atlas postgres" → DIFFERENT (leads≠heads) → F1 key mismatch → safe
  const PARAPHRASE_CANDIDATE = "Priya Nair leads the Atlas Postgres oncall rotation.";
  const PARAPHRASE_INCOMING  = "Priya Nair heads the Atlas Postgres oncall group.";

  // Reworded novelty ~0.17 (only 1 new token out of ~6) (g):
  //   candidate: "Marcus Webb handles the Atlas Postgres oncall incidents."
  //   tokens: {marcus,webb,handles,atlas,postgres,oncall,incidents} = 7
  //   incoming: "Marcus Webb handles the Atlas Postgres oncall escalations."
  //   tokens: {marcus,webb,handles,atlas,postgres,oncall,escalations} = 7; novel = {escalations}=1; novelty=1/7≈0.14 < 0.40 → skip ✓
  //   statement key candidate: "marcus webb handles the atlas postgres oncall incidents"
  //   statement key incoming:  "marcus webb handles the atlas postgres oncall escalations" → differ on last word → F1 key mismatch → safe
  const REWORD_CANDIDATE = "Marcus Webb handles the Atlas Postgres oncall incidents.";
  const REWORD_INCOMING  = "Marcus Webb handles the Atlas Postgres oncall escalations.";

  // Ratio ≥ 0.40 but only 2 absolute novel tokens → fails the >=3 floor (h):
  //   candidate: {cole,home,city,lisbon} = 4 tokens
  //   incoming:  {cole,home,city,berlin,paris} = 5 tokens; novel={berlin,paris}=2; novelty=2/5=0.40 >=0.40; abs=2 < 3 → no fire ✓
  //   statement key: "cole home city lisbon" vs "cole home city berlin" → differ → F1 safe
  const FLOOR_CANDIDATE = "Cole home city Lisbon.";
  const FLOOR_INCOMING  = "Cole home city Berlin Paris.";
  // contentTokens of FLOOR_CANDIDATE: cole(4)✓ home(4)✓ city(4)✓ lisbon(6)✓ → {cole,home,city,lisbon} = 4
  // contentTokens of FLOOR_INCOMING: cole(4)✓ home(4)✓ city(4)✓ berlin(6)✓ paris(5)✓ → {cole,home,city,berlin,paris} = 5
  // novel = {berlin,paris} = 2; novelty = 2/5 = 0.40 >= 0.40; abs novel = 2 < 3 → no fire ✓

  // (e) Additive novelty >= 0.40 with >= 3 novel tokens → create (keep both)
  it("(e) additive incoming with novelty ≥ 0.40 and ≥ 3 novel tokens → create (keep both)", async () => {
    process.env.RUNIR_ADDITIVE_SKIP_GUARD = "1";
    const r = await arbWithCandidateAtSim(ADDITIVE_INCOMING, CANDIDATE_TEXT, 0.958);
    expect(r.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  // (f) Pure paraphrase novelty 0.0 → skip
  it("(f) pure paraphrase (novelty ≈ 0.0) → skip (guard does not fire)", async () => {
    process.env.RUNIR_ADDITIVE_SKIP_GUARD = "1";
    const r = await arbWithCandidateAtSim(PARAPHRASE_INCOMING, PARAPHRASE_CANDIDATE, 0.97);
    expect(r.outcome).toBe("skip");
  });

  // (g) Reworded novelty ~0.17 → skip
  it("(g) reworded text (novelty ≈ 0.17, below 0.40) → skip (guard does not fire)", async () => {
    process.env.RUNIR_ADDITIVE_SKIP_GUARD = "1";
    const r = await arbWithCandidateAtSim(REWORD_INCOMING, REWORD_CANDIDATE, 0.97);
    expect(r.outcome).toBe("skip");
  });

  // (h) Novel ratio >= 0.40 but only 2 absolute novel tokens (< 3 floor) → skip
  it("(h) novelty ratio ≥ 0.40 but only 2 absolute novel tokens → skip (fails ≥3 floor)", async () => {
    process.env.RUNIR_ADDITIVE_SKIP_GUARD = "1";
    const r = await arbWithCandidateAtSim(FLOOR_INCOMING, FLOOR_CANDIDATE, 0.97);
    expect(r.outcome).toBe("skip");
  });

  // (i) Gate OFF → byte-identical to baseline (skip, no create)
  it("(i) gate OFF → additive incoming still skips (byte-identical baseline)", async () => {
    // RUNIR_ADDITIVE_SKIP_GUARD not set (default OFF)
    const r = await arbWithCandidateAtSim(ADDITIVE_INCOMING, CANDIDATE_TEXT, 0.958);
    expect(r.outcome).toBe("skip");
  });
});
