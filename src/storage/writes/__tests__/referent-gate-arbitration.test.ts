import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Rúnir-pn1l.13.4 U5 — the APPLIED (live) authority change, tested at the
// arbitrateWrite level.
//
// Two invariants under test, both with ALL flip flags OFF (default prod):
//   (R1) F1 nominate-only: `deterministic_text` may nominate but retires ONLY with a
//        positive referent proof. Unproven → no supersede (falls through), and the
//        shadow row records `would_nomination_blocked: "deterministic_text:unproven"`.
//   (R3) Unconditional anchor-conflict veto in EVERY band: a single conflict candidate
//        can never be retired, absorbed as a near-dup skip, or received as a merge-update.
//        With no other candidate it lands as `create` at recent-cache, skip-band, AND
//        merge-band similarities alike. NOT gated by any env flag.
//
// House pattern mirrors merge-keepboth-guard.test.ts: mocked store + makeCandidate/arb.

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

import { arbitrateWrite } from "../write-arbitrator.js";
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
function makeCandidate(o: Partial<SimilarCandidate> & { l2: string; similarity: number }): SimilarCandidate {
  const now = new Date().toISOString();
  return { id: "seed-id", createdAt: now, updatedAt: now, ...o };
}
async function arb(opts: {
  text: string;
  candidates?: SimilarCandidate[];
  recentWrites?: Map<string, RecentWrite[]>;
  metadata?: Record<string, unknown>;
}) {
  (findSimilarMemories as Mock).mockResolvedValue(opts.candidates ?? []);
  const embedding = makeVec(0);
  return arbitrateWrite({
    db: makeDb(),
    text: opts.text,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: opts.recentWrites ?? new Map<string, RecentWrite[]>(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // ALL flip flags OFF — default prod. The veto must hold with none of these set.
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  mockLogSupersedeShadow.mockResolvedValue(undefined);
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
});

// A conflict pair that ALSO shares a statement key so F1 nominates (deterministic_text),
// forcing the veto to be the thing that stops the supersede.
//   key = "parser bug" on both; values = "continuity-report.ts:84" vs ":419" (disjoint file_line anchors → conflict)
const CONFLICT_CANDIDATE_TEXT = "parser bug: continuity-report.ts:84";
const CONFLICT_INCOMING_TEXT = "parser bug: continuity-report.ts:419";

describe("R1 — F1 nominate-only (deterministic_text retires only with a proven referent)", () => {
  it("unproven same-key value change (no anchors, no keys) → NOT supersede", async () => {
    // Same statement key "config value", differing value, no anchors → F1 nominates
    // but referent is unproven → no supersede. (Baseline w077 behavior superseded; now blocked.)
    const candidate = makeCandidate({ l2: "config value: alpha mode", similarity: 0.90 });
    const r = await arb({ text: "config value: beta mode", candidates: [candidate] });
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("shadow row records would_nomination_blocked: deterministic_text:unproven", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({ l2: "config value: alpha mode", similarity: 0.90 });
    await arb({ text: "config value: beta mode", candidates: [candidate] });
    expect(mockLogSupersedeShadow).toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.wouldNominationBlocked).toBe("deterministic_text:unproven");
  });

  it("high-overlap value-swap pair (staging→production) with no non-text proof → KEEPS BOTH, F1 nomination blocked", async () => {
    // Codex arch-gate P1: near-verbatim was removed as a proof arm precisely because a
    // one-token value swap (staging→production) has very high token-Jaccard while being two
    // CO-VALID facts. Same statement key ("probe config") → F1 nominates; no key, no anchor,
    // no proof → the referent is unproven → NO supersede (keep both). Shadow records the
    // blocked nomination so the veto is observable to the re-adjudication gate.
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const BODY =
      "the requesty probe now uses two hundred fifty six tokens for safety margin across every configured provider tested in continuous integration nightly regression benchmark suites within the";
    const CAND = `probe config: ${BODY} staging deployment lane environment tier`;
    const INC = `probe config: ${BODY} production deployment lane environment tier`;
    const candidate = makeCandidate({ l2: CAND, similarity: 0.90 });
    const r = await arb({ text: INC, candidates: [candidate] });
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.wouldNominationBlocked).toBe("deterministic_text:unproven");
  });

  it("factKey-equal pair → SUPERSEDE proceeds, referent_proof key:factKey", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // Positive control for the key:factKey proof arm: factKey is value-varying, so a
    // shared factKey means an identical-l0 duplicate (NOT a value correction — a real
    // value change would change l0 and thus the factKey). The differing candidate/incoming
    // text here forces F1 to nominate; the synthetically-shared factKey proves identity.
    const candidate = makeCandidate({
      l2: "deploy target: staging cluster",
      similarity: 0.90,
      factKey: "config:deploy-target-abc123",
    });
    const r = await arb({
      text: "deploy target: production cluster",
      candidates: [candidate],
      metadata: { factKey: "config:deploy-target-abc123" },
    });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentProof).toBe("key:factKey");
  });

  it("atomicFactIdentity-equal pair (subject|predicate canonicalization) → SUPERSEDE proceeds", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // Rúnir-h435.1 [R1-1]: applied atomic authority is quarantine-gated (default OFF).
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    const atomicFact = { subject: "Runir service", predicate: "uses_port" };
    const candidate = makeCandidate({
      l2: "port setting: 7700 default",
      similarity: 0.90,
      atomicFact: { ...atomicFact, value: "7700" },
    });
    const r = await arb({
      text: "port setting: 8800 override",
      candidates: [candidate],
      metadata: { atomicFact: { ...atomicFact, value: "8800" } },
    });
    expect(r.outcome).toBe("supersede");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentProof).toBe("key:atomicFactIdentity");
  });

  // ---------------------------------------------------------------------------
  // Rúnir-pn1l Q4 U0 (2026-07-07) — APPLIED-PATH REGRESSION (brief §4, Codex P1 #2).
  // Same scenario as the two positive controls above (equal factKey / equal
  // atomicFactIdentity, correction-band similarity, F1-nominating same statement
  // key), but this time the candidate and incoming ALSO carry a partial-overlap
  // issue_ref conflict (GH#8,GH#9 vs GH#8,GH#10 — the architect's row, and the
  // exact shape the setsEqual fix in referent-identity.ts targets). Under the
  // architect's rule, anchor conflict wins UNCONDITIONALLY over key equality —
  // so despite the matching factKey/atomicFact, this must NOT supersede.
  // ---------------------------------------------------------------------------
  it("APPLIED-PATH REGRESSION: equal factKey + partial-overlap issue_ref conflict (GH#8,GH#9 vs GH#8,GH#10) → NO supersede (anchor-conflict beats key equality)", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({
      l2: "service port 7700; affects GH#8 and GH#9",
      similarity: 0.90,
      factKey: "config:port-shared-key",
    });
    const r = await arb({
      text: "service port 8800; affects GH#8 and GH#10",
      candidates: [candidate],
      metadata: { factKey: "config:port-shared-key" },
    });
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("conflict");
  });

  it("APPLIED-PATH REGRESSION: equal atomicFactIdentity + partial-overlap issue_ref conflict (GH#8,GH#9 vs GH#8,GH#10) → NO supersede (anchor-conflict beats key equality)", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const atomicFact = { subject: "Runir service", predicate: "uses_port" };
    const candidate = makeCandidate({
      l2: "service port 7700; affects GH#8 and GH#9",
      similarity: 0.90,
      atomicFact: { ...atomicFact, value: "7700" },
    });
    const r = await arb({
      text: "service port 8800; affects GH#8 and GH#10",
      candidates: [candidate],
      metadata: { atomicFact: { ...atomicFact, value: "8800" } },
    });
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("conflict");
  });
});

describe("R3 — unconditional anchor-conflict veto, ALL flags OFF, at every band", () => {
  it("MERGE band: single conflict candidate → create (referent-anchor-conflict), NOT merge-update", async () => {
    // similarity 0.90 lands in the merge band [0.85, 0.95)
    const candidate = makeCandidate({ l2: CONFLICT_CANDIDATE_TEXT, similarity: 0.90 });
    const r = await arb({ text: CONFLICT_INCOMING_TEXT, candidates: [candidate] });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/referent-anchor-conflict/);
    expect(updateMemoryText).not.toHaveBeenCalled();
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("MERGE band veto: shadow row records referentVerdict/referentProof (pn1l.13.6 Item A)", async () => {
    // Codex round-1: the merge-band veto (:1236-1245) has a `reason` but never stamped
    // referentVerdict/referentProof onto the shadow-visible decision object. Mirrors the
    // recent-band assertion shape above (Codex P2 test at :229-230).
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({ l2: CONFLICT_CANDIDATE_TEXT, similarity: 0.90 });
    const r = await arb({ text: CONFLICT_INCOMING_TEXT, candidates: [candidate] });
    expect(r.outcome).toBe("create");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("conflict");
    expect(typeof call.referentProof).toBe("string");
    expect(call.referentProof.length).toBeGreaterThan(0);
  });

  it("SKIP band: single conflict candidate at cos 0.97 → create, NOT skip", async () => {
    const candidate = makeCandidate({ l2: CONFLICT_CANDIDATE_TEXT, similarity: 0.97 });
    const r = await arb({ text: CONFLICT_INCOMING_TEXT, candidates: [candidate] });
    expect(r.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("SKIP band veto: reason names referent-anchor-conflict + shadow row records referentVerdict/referentProof (pn1l.13.6 Item A, P2.3)", async () => {
    // Codex round-1: the store-near-dup skip-band veto (:1193-1197 pre-13.6) previously
    // recorded NOTHING — a bare `continue`, no reason, no shadow fields. P2.3 accepts a
    // public reason change here (mirroring the already-shipped recent-band veto) since no
    // caller/test depends on the old generic "no recent duplicate or merge candidate found"
    // string on THIS path (verified: only supersede-shadow-smoke.test.ts asserts that string,
    // and only for a genuinely candidate-less write, not a vetoed store-near-dup).
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({ l2: CONFLICT_CANDIDATE_TEXT, similarity: 0.97 });
    const r = await arb({ text: CONFLICT_INCOMING_TEXT, candidates: [candidate] });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/referent-anchor-conflict/);
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("conflict");
    expect(typeof call.referentProof).toBe("string");
    expect(call.referentProof.length).toBeGreaterThan(0);
  });

  it("RECENT-WRITE cache: conflict entry (cosine 1.0) → create, NOT skip", async () => {
    // Inject the conflict pair via the recent-write cache. The recent entry cosines 1.0
    // against the incoming embedding (same one-hot vector), so absent the veto it would skip.
    const recentWrites = new Map<string, RecentWrite[]>();
    // resolveDecision reads recentCandidates from recentWrites.get(cacheKey). Prime the map
    // via a throwaway arb call that remembers the write under the correct partition key, then
    // reuse the populated map (avoids re-deriving getRecentWriteKey's internal partitioning).
    await arb({ text: CONFLICT_CANDIDATE_TEXT, recentWrites });
    // Now recentWrites holds the candidate text keyed correctly. Overwrite its embedding to cosine
    // 1.0 with the incoming so it reaches the recent near-dup skip band.
    for (const entries of recentWrites.values()) {
      for (const e of entries) e.embedding = makeVec(0);
    }
    (supersedeMemory as Mock).mockClear();
    const r = await arb({ text: CONFLICT_INCOMING_TEXT, recentWrites });
    expect(r.outcome).toBe("create");
  });

  it("RECENT-WRITE cache veto with NO store candidate → create records referent-anchor-conflict in reason + shadow (Codex P2)", async () => {
    // Codex P2: a recent-band anchor-conflict veto that finds no other absorbing candidate
    // falls to the generic `create` — previously with null shadow referent fields, so the
    // ledger could not prove the hard veto fired. It must now carry the reason AND populate
    // referent_verdict:"conflict" for the re-adjudication gate. recent-write :84 vs incoming
    // :419, cosine 1.0, NO store candidate, all flags OFF.
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const recentWrites = new Map<string, RecentWrite[]>();
    await arb({ text: CONFLICT_CANDIDATE_TEXT, recentWrites });
    for (const entries of recentWrites.values()) {
      for (const e of entries) e.embedding = makeVec(0);
    }
    mockLogSupersedeShadow.mockClear();
    const r = await arb({ text: CONFLICT_INCOMING_TEXT, recentWrites });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/referent-anchor-conflict/);
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("conflict");
  });

  it("raw-corpus magnet labeled-id conflict at merge band, all flags OFF → create, NOT merge-update", async () => {
    // task (bj8gfw9po) incoming vs Task bidwfprbl candidate → disjoint labeled_id anchors → conflict
    const candidate = makeCandidate({
      l2: "active task: Task bidwfprbl handles the build",
      similarity: 0.90,
    });
    const r = await arb({ text: "active task: task (bj8gfw9po) handles the build", candidates: [candidate] });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/referent-anchor-conflict/);
    expect(updateMemoryText).not.toHaveBeenCalled();
  });

  it("conflict candidate + F2 correction marker → veto beats F2, no supersede", async () => {
    // Marker present + shared slot tags would normally drive F2, but the anchor conflict vetoes.
    const candidate = makeCandidate({
      l2: "parser bug: continuity-report.ts:84",
      similarity: 0.90,
      tags: ["project:atlas", "component:parser"],
    });
    const r = await arb({
      text: "parser bug: continuity-report.ts:419",
      candidates: [candidate],
      metadata: { tags: ["project:atlas", "component:parser", "update"] },
    });
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });
});

describe("KTD10 regression — F2 marker+slot-tags without anchors is unchanged", () => {
  it("cued same-slot value change still supersedes (no anchors on either side)", async () => {
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    const TAGS = ["project:atlas", "role:on-call-lead"];
    const candidate = makeCandidate({
      l2: "Priya Nair is the on-call lead for Atlas",
      similarity: 0.90,
      tags: [...TAGS, "person:priya-nair"],
    });
    const r = await arb({
      text: "Marcus Webb is now the on-call lead, replacing Priya Nair",
      candidates: [candidate],
      metadata: { tags: [...TAGS, "subject:marcus-webb"] },
    });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("marker-present tag-free ambiguous handoff (no anchors) → create as before (unchanged)", async () => {
    const candidate = makeCandidate({
      l2: "Priya Nair is the on-call lead for Atlas",
      similarity: 0.90,
      tags: ["project:atlas", "role:on-call-lead", "person:priya-nair"],
    });
    const r = await arb({
      text: "Marcus Webb is the on-call lead",
      candidates: [candidate],
      metadata: { tags: ["project:atlas", "role:on-call-lead", "subject:marcus-webb", "update"] },
    });
    // w077: tagged correction with no compatible target → create (not via referent veto).
    expect(r.reason ?? "").not.toMatch(/referent-anchor-conflict/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rúnir-pn1l Q4 U1 — write-side v2 shadow stamping (F2-exception discriminant, A1;
// correction-band blocked-candidate snapshots + role-tag masquerade-prevention, A3).
// All applied-path outcomes are asserted byte-identical to their pre-U1 shape; only the
// shadow-visible `referentVerdict`/`referentProof`/`shadowCandidateSnapshot` fields differ.
// ─────────────────────────────────────────────────────────────────────────────
describe("Rúnir-pn1l Q4 U1 — A1: F2-exception referent_verdict discriminant", () => {
  it("F2 currentness_cue:slot supersede → referentVerdict:'f2_exception', referentProof:'signal:currentness_cue:slot'; applied outcome unaffected", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    const TAGS = ["project:atlas", "role:on-call-lead"];
    const candidate = makeCandidate({
      l2: "Priya Nair is the on-call lead for Atlas",
      similarity: 0.90,
      tags: [...TAGS, "person:priya-nair"],
    });
    const r = await arb({
      text: "Marcus Webb is now the on-call lead, replacing Priya Nair",
      candidates: [candidate],
      metadata: { tags: [...TAGS, "subject:marcus-webb"] },
    });
    // Applied outcome byte-identical to the pre-existing KTD10 assertion above.
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("f2_exception");
    expect(call.referentProof).toBe("signal:currentness_cue:slot");
  });

  it("F2 extractor_correction:slot (marker-driven) supersede → referentVerdict:'f2_exception', referentProof:'signal:extractor_correction:slot'", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // Different statement keys ("marcus webb is..." vs "priya nair is...") so F1 does NOT
    // nominate via wouldSupersedeTexts — the shared slot tags + `update` marker are what
    // drives F2's extractor_correction:slot signal instead (mirrors the working
    // supersession-reliability-repro.test.ts "role handoff" F2 pattern).
    const candidate = makeCandidate({
      l2: "Priya Nair is the tech lead for the Atlas project.",
      similarity: 0.88,
      tags: ["project:atlas", "role:tech-lead", "person:priya-nair"],
    });
    const r = await arb({
      text: "Marcus Webb is the new Atlas tech lead, replacing Priya.",
      candidates: [candidate],
      metadata: { tags: ["subject:marcus-webb", "project:atlas", "role:tech-lead", "update"] },
    });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("f2_exception");
    expect(call.referentProof).toBe("signal:extractor_correction:slot");
  });

  it("F1-proven supersede is UNCHANGED — referentVerdict stays 'proven', never 'f2_exception'", async () => {
    // Regression guard: confirms the new else-branch in the F1-proven spread never fires
    // when corrected.referentProof IS set (positive control mirrors the pre-existing
    // factKey-equal F1 test above, with the added verdict assertion).
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({
      l2: "deploy target: staging cluster",
      similarity: 0.90,
      factKey: "config:deploy-target-abc123",
    });
    const r = await arb({
      text: "deploy target: production cluster",
      candidates: [candidate],
      metadata: { factKey: "config:deploy-target-abc123" },
    });
    expect(r.outcome).toBe("supersede");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("proven");
    expect(call.referentProof).toBe("key:factKey");
  });
});

describe("Rúnir-pn1l Q4 U1 — A3: correction-band blocked-candidate snapshots (role-tagged)", () => {
  it("A3a — deterministic_text:unproven veto in the WOULD-only 0.75-0.85 floor window: shadow row carries would_nomination_blocked + a role-tagged blocked_nomination snapshot (applied lane never sees this candidate at all)", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // Similarity 0.80: below the APPLIED/BASELINE mergeThreshold (0.85, so findSupersedeTarget's
    // floor check `candidate.similarity < config.supersedeCandidateFloor` fails this candidate
    // in BOTH the applied and baseline lanes — it is invisible to them), but the WOULD lane
    // forces supersedeCandidateFloor=0.75 (write-arbitrator.ts's shadow block), so ONLY the
    // WOULD resolveDecision pass reaches this candidate at all. Same statement key
    // ("config value") so F1 nominates; no anchors/keys anywhere → unproven.
    const candidate = makeCandidate({ l2: "config value: alpha mode", similarity: 0.80 });
    const r = await arb({ text: "config value: beta mode", candidates: [candidate] });
    // Applied outcome: this candidate never reaches ANY applied-lane band (floor-gated out of
    // the correction pass; 0.80 < 0.85 also fails the merge-band floor) → generic create,
    // completely unaffected by anything in the WOULD-only lane.
    expect(r.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.wouldNominationBlocked).toBe("deterministic_text:unproven");
    expect(call.candidateSnapshotJson).not.toBeNull();
    const snapshot = JSON.parse(call.candidateSnapshotJson);
    expect(snapshot.snapshot_role).toBe("blocked_nomination");
    expect(snapshot.l2).toBe("config value: alpha mode");
  });

  it("A3b — correction-band anchor-conflict veto (loop-level continue in findSupersedeTarget): referentVerdict:'conflict' + a role-tagged blocked_nomination snapshot, in the WOULD-only floor window", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // Same statement key ("parser bug") so F1 would nominate, but disjoint file_line anchors
    // (:84 vs :419) force the loop-level anchor-conflict `continue` INSIDE findSupersedeTarget
    // (A3b), at similarity 0.80 — again only reachable via the WOULD lane's 0.75 floor.
    const candidate = makeCandidate({ l2: "parser bug: continuity-report.ts:84", similarity: 0.80 });
    const r = await arb({ text: "parser bug: continuity-report.ts:419", candidates: [candidate] });
    expect(r.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentVerdict).toBe("conflict");
    expect(typeof call.referentProof).toBe("string");
    expect(call.candidateSnapshotJson).not.toBeNull();
    const snapshot = JSON.parse(call.candidateSnapshotJson);
    expect(snapshot.snapshot_role).toBe("blocked_nomination");
    expect(snapshot.l2).toBe("parser bug: continuity-report.ts:84");
  });

  it("A3 precedence (Codex brief-gate P1 #2): a LATER band's own matched-candidate veto is preserved — the correction-band blocked-nomination snapshot (candidate A) never masquerades as the later band's snapshot (candidate B)", async () => {
    // Candidate A: in-band for the WOULD correction pass (sim 0.80, same statement key,
    // disjoint file_line anchors) → correction-band anchor-conflict continue (A3b) fires,
    // capturing A's snapshot role-tagged "blocked_nomination".
    // Candidate B: merge-band range (sim 0.90), ALSO anchor-conflicting (disjoint labeled_id),
    // so resolveRemainingBands()'s merge-band veto (pre-existing 13.6 Item A) fires on B and
    // sets decision.shadowCandidateSnapshot itself, role "matched_candidate", BEFORE the A3
    // fall-through stamp runs. The `??=`-style guard in resolveDecision (only fill in when
    // decision.shadowCandidateSnapshot is still undefined) must leave B's snapshot in place.
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.75"; // widen the APPLIED/BASELINE floor too, so both candidates are visible identically across all three lanes (applied/baseline/would) — isolates the assertion to the precedence logic itself, not a floor-visibility difference.
    const candidateA = makeCandidate({
      id: "candidate-a",
      l2: "parser bug: continuity-report.ts:84",
      similarity: 0.80,
    });
    const candidateB = makeCandidate({
      id: "candidate-b",
      l2: "active task: Task bidwfprbl handles the build",
      similarity: 0.90,
    });
    const r = await arb({
      // Shares candidate A's statement key ("parser bug") so F1 nominates + conflicts on A;
      // ALSO shares candidate B's disjoint labeled_id conflict text so the merge-band veto
      // fires on B independently.
      text: "parser bug: task (bj8gfw9po) handles the build",
      candidates: [candidateB, candidateA],
    });
    expect(r.outcome).toBe("create");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.candidateSnapshotJson).not.toBeNull();
    const snapshot = JSON.parse(call.candidateSnapshotJson);
    // Must be B's snapshot (the later, merge-band veto), NOT A's (the correction-band one) —
    // proving the fall-through `??=` guard did not overwrite an already-set snapshot.
    expect(snapshot.snapshot_role).toBe("matched_candidate");
    expect(snapshot.l2).toBe(candidateB.l2);
    expect(snapshot.id).toBe("candidate-b");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full derivation sweep at ARBITRATION level (the unit's real teeth):
//   - all 45 expected:block rows → NOT supersede through arbitrateWrite
// Keys empty (keyless) so block rows that would prove only via keys correctly stay blocked.
//
// NOTE (verified against the fixture): with empty keys, NO allow row BOTH F1-nominates
// (statement-key equality via wouldSupersedeTexts) AND keyless-proves. ALL 6 allow rows
// are provable:"key-dependent" (Rúnir-pn1l Q4 U0, 2026-07-07: the formerly-sole keyless-
// provable row, 7ac4a2, moved into this set — its incoming text's all-grade labeled_id
// set now correctly CONFLICTS against the candidate's under the setsEqual fix, since the
// incoming also names a second, distinct labeled_id ("task bumib4tnx") the candidate never
// mentions; anchor-shared alone no longer proves it). None of the 6 key-dependent rows
// F1-nominates without real key fuel threaded in — a nominate-only gate can gate F1, it
// cannot manufacture a nomination. So the applied-lane positive controls are the SYNTHETIC
// nominate+prove pairs in the R1 block above (near-verbatim / key:factKey /
// key:atomicFactIdentity), not a keyless fixture row. Unit-level proveReferentIdentity
// coverage of the fixture lives in referent-identity.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
interface DerivationRow {
  rowId: string;
  incomingText: string;
  candidateText: string;
  wouldSignal: string | null;
  label: "over_supersede" | "correct_supersede";
  expected: "block" | "allow";
  provable: true | false | "key-dependent";
  classNote: string;
}
const FIXTURE_PATH = resolve(
  "src/storage/writes/__tests__/fixtures/referent-identity/supersede-derivation.json",
);
const derivationRows: DerivationRow[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

describe("ARBITRATION-level derivation sweep (all flags OFF, keyless)", () => {
  it("all 46 expected:block rows → NOT supersede through arbitrateWrite", async () => {
    // Rúnir-pn1l Q4 U0 (Codex code-review, 2026-07-07): 46, not 45. Row 7ac4a2
    // ("task-milestone") was reclassified from allow/provable:true to
    // block/provable:false — proveReferentIdentity checks anchorRelation FIRST
    // and short-circuits on conflict BEFORE the key-equality loop, so once the
    // setsEqual fix correctly conflicts its {bly4ezhko} vs {bly4ezhko,bumib4tnx}
    // labeled_id sets, this row can NEVER supersede regardless of key fuel. It
    // is now a LIVE regression guard for the setsEqual fix in this sweep.
    const blockRows = derivationRows.filter((r) => r.expected === "block");
    expect(blockRows.length).toBe(46);
    const wronglySuperseded: string[] = [];
    for (const row of blockRows) {
      (supersedeMemory as Mock).mockClear();
      // Similarity 0.90 (merge band) so F1/F2 can nominate; the veto/gate must stop retirement.
      const candidate = makeCandidate({ l2: row.candidateText, similarity: 0.90 });
      const r = await arb({ text: row.incomingText, candidates: [candidate] });
      if (r.outcome === "supersede") wronglySuperseded.push(row.rowId);
    }
    expect(wronglySuperseded).toEqual([]);
  });
});
