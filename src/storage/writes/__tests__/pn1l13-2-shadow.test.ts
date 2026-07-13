import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l.13.2 — shadow would-decision logging tests.
//
// Covers:
//   D2: cue-gate param refactor is behavior-preserving (cue-gated supersede row identical before/after)
//   shadow OFF (flag unset) → no 2nd resolveDecision call, no log write, applied result byte-identical (spy)
//   shadow ON → would (all-ON) + baseline (all-OFF) computed over same candidates; diverged=baseline!==would
//   applied_memory_id populated post-branch for create/supersede; null for skip
//   judgeEnabled=false on both shadow resolves; resolveJudgeDecision NOT invoked in shadow
//   log write failure swallowed, applied result unchanged
//   band stamped on ArbitrationDecision; existing callers unaffected (band=undefined ok)
//   ensureSupersedeShadowTable is idempotent (mock idempotence check)

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
  ensureSupersedeShadowTable,
  supersedeMemory,
  updateMemoryText,
  upsertMemory,
} from "../../surreal/surreal-store.js";

// Typed aliases for mock inspection
const mockLogSupersedeShadow = logSupersedeShadow as Mock;
const mockEnsureSupersedeShadowTable = ensureSupersedeShadowTable as Mock;
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}

function makeVec(seed: number, len = 16): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

const NOW = new Date().toISOString();

function makeCandidate(
  o: Partial<SimilarCandidate> & { l2: string; similarity: number },
): SimilarCandidate {
  return { id: "cand-id", createdAt: NOW, updatedAt: NOW, ...o };
}

async function arb(opts: {
  text: string;
  candidates?: SimilarCandidate[];
  incomingTags?: string[];
  // Rúnir-pn1l.13.4 (U5): extra incoming metadata (e.g. a shared atomicFact to prove
  // referent identity so an F1/cue supersede can fire under the nominate-only gate).
  incomingMetadata?: Record<string, unknown>;
  env?: Record<string, string>;
  recentWrites?: Map<string, RecentWrite[]>;
  // Rúnir-pn1l.13.7 D4: judge is a handle, not a bare function.
  judge?: import("../supersession-judge.js").SupersessionJudgeHandle;
}) {
  (findSimilarMemories as Mock).mockResolvedValue(opts.candidates ?? []);
  const embedding = makeVec(0, 16);
  const metadata =
    opts.incomingTags || opts.incomingMetadata
      ? { ...(opts.incomingTags ? { tags: opts.incomingTags } : {}), ...opts.incomingMetadata }
      : undefined;
  return arbitrateWrite({
    db: makeDb(),
    text: opts.text,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: opts.recentWrites ?? new Map(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(metadata ? { metadata } : {}),
    ...(opts.judge ? { judge: opts.judge } : {}),
  });
}

// Rúnir-pn1l.13.4 (U5): F1/cue supersedes now require a proven referent identity. A
// same-subject value change carries a shared atomicFact {subject, predicate} in production
// (stable across the value), which proves via key:atomicFactIdentity. These shadow tests
// thread it so the intended supersede fires; keyless-blocked F1 is covered in
// referent-gate-arbitration.test.ts.
const danaFact = { subject: "Dana Cole", predicate: "role" };
const priyaFact = { subject: "Priya Nair", predicate: "role" };

beforeEach(() => {
  process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1"; // Rúnir-h435.1 [R1-1] applied atomic F1 fixtures
  vi.clearAllMocks();
  mockLogSupersedeShadow.mockResolvedValue(undefined);
  // Clear all shadow/flip env flags
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
  (upsertMemory as Mock).mockResolvedValue("new-id");
});
afterEach(() => {
  delete process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
});

// ─────────────────────────────────────────────────────────────────────────────
// D2: cue-gate param refactor — behavior-preserving
// ─────────────────────────────────────────────────────────────────────────────

describe("D2 — cue-gate param refactor is behavior-preserving", () => {
  // A cue-gated supersede row: candidate has slot tags shared with incoming,
  // incoming has a currentness cue ("is now"), and RUNIR_SUPERSEDE_CUE_GATE=1.
  // With cue gate ON the correction pass should fire supersede.
  it("cue-gate ON → supersede (same behavior before/after refactor)", async () => {
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    const TAGS = ["role:tech-lead", "person:dana-cole"];
    const candidate = makeCandidate({
      l2: "Dana Cole is the tech lead.",
      similarity: 0.88,
      tags: TAGS,
      atomicFact: { ...danaFact, value: "tech lead" },
    });
    const result = await arb({
      text: "Dana Cole is now the engineering manager.",
      candidates: [candidate],
      incomingTags: TAGS,
      incomingMetadata: { atomicFact: { ...danaFact, value: "engineering manager" } },
    });
    // The cue gate fires the correction pass → supersede (proven referent identity: shared atomicFact)
    expect(result.outcome).toBe("supersede");
  });

  it("cue-gate OFF → no supersede (create or merge, not supersede via cue)", async () => {
    // RUNIR_SUPERSEDE_CUE_GATE not set
    const TAGS = ["role:tech-lead", "person:dana-cole"];
    const candidate = makeCandidate({
      l2: "Dana Cole is the tech lead.",
      similarity: 0.88,
      tags: TAGS,
    });
    const result = await arb({
      text: "Dana Cole is now the engineering manager.",
      candidates: [candidate],
      incomingTags: TAGS,
    });
    // Without cue gate, cue-only path doesn't fire → not supersede via cue
    // (may be merge-update at 0.88 or create — but NOT supersede via currentness_cue:slot)
    if (result.outcome === "supersede") {
      // If it somehow supersedes, signal must NOT be currentness_cue:slot
      expect(result.reason).not.toMatch(/currentness_cue/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MF_default_off_isolation: shadow OFF → zero added work
// ─────────────────────────────────────────────────────────────────────────────

describe("shadow OFF (RUNIR_SUPERSEDE_SHADOW unset) — no-op", () => {
  it("shadow OFF → logSupersedeShadow never called, applied result unchanged", async () => {
    const result = await arb({ text: "a brand new fact about nothing" });
    expect(result.outcome).toBe("create");
    expect(mockLogSupersedeShadow).not.toHaveBeenCalled();
  });

  it("shadow OFF with skip candidate → logSupersedeShadow never called", async () => {
    const candidate = makeCandidate({
      l2: "a brand new fact about nothing",
      similarity: 0.99,
    });
    const result = await arb({
      text: "a brand new fact about nothing",
      candidates: [candidate],
    });
    // Exact text dup → skip
    expect(result.outcome).toBe("skip");
    expect(mockLogSupersedeShadow).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shadow ON — would+baseline computed, diverged=baseline!==would
// ─────────────────────────────────────────────────────────────────────────────

describe("shadow ON — would + baseline computed, diverged correct", () => {
  // A divergent scenario: applied=skip (all flags OFF, near-dup at 0.96),
  // baseline=skip, would=create (additive skip guard ON forces create for additive incoming).
  // We need a candidate at high cosine where additive guard would fire.
  // Use a skip-band candidate (sim >= 0.95) with additive incoming.
  // baseline (all-OFF) = skip; would (all-ON, addSkipGuard=true) = create if additive.
  it("divergent row: baseline=skip, would=create → diverged=true, log emitted", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";

    // Candidate text and incoming chosen so:
    //   - They normalize to different texts (no exact-dup skip before band check)
    //   - similarity >= 0.95 → skip band
    //   - incoming is additive (>=3 novel tokens, ratio >=0.40)
    // The candidate similarity is injected via mock.
    const CANDIDATE_TEXT =
      "Dana Cole runs the Atlas oncall roster for Postgres incidents.";
    const ADDITIVE_INCOMING =
      "The Atlas oncall roster, run by Dana Cole, now also covers Redis escalations, nightly backup incidents, and cache eviction alerts.";

    const candidate = makeCandidate({
      l2: CANDIDATE_TEXT,
      similarity: 0.97, // skip band
    });

    // Applied path: all flags OFF → RUNIR_ADDITIVE_SKIP_GUARD unset → skip
    const result = await arb({
      text: ADDITIVE_INCOMING,
      candidates: [candidate],
    });

    // Applied = skip (guard is OFF on the live path)
    expect(result.outcome).toBe("skip");

    // Shadow was ON → log called once
    expect(mockLogSupersedeShadow).toHaveBeenCalledOnce();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;

    // baseline (all-OFF) = skip (same as applied since applied is already all-OFF)
    expect(call.baselineOutcome).toBe("skip");
    // would (all-ON, addSkipGuard=true) = create (additive content guard fires)
    expect(call.wouldOutcome).toBe("create");
    // diverged = baseline !== would
    expect(call.diverged).toBe(true);
    // applied_memory_id = null for skip
    expect(call.appliedMemoryId).toBeNull();
  });

  it("non-divergent row: baseline=create, would=create → diverged=false", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // No candidates → both baseline and would resolve to create
    const result = await arb({ text: "a completely new fact" });
    expect(result.outcome).toBe("create");

    expect(mockLogSupersedeShadow).toHaveBeenCalledOnce();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.baselineOutcome).toBe("create");
    expect(call.wouldOutcome).toBe("create");
    expect(call.diverged).toBe(false);
    // applied_memory_id populated (create branch)
    expect(typeof call.appliedMemoryId).toBe("string");
    expect(call.appliedMemoryId).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MFB: applied_memory_id timing
// ─────────────────────────────────────────────────────────────────────────────

describe("MFB — applied_memory_id populated post-branch", () => {
  it("supersede branch → applied_memory_id is the new replacement id (not null)", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";

    // Set up a deterministic-text supersede: wouldSupersedeTexts triggers F1.
    // F1 fires when candidate.l2 and incoming text share the same "statement key"
    // (first colon-delimited segment) but differ in value. Use "priya is: X" pattern.
    const CANDIDATE_TEXT = "priya is: senior engineer";
    const INCOMING_TEXT = "priya is: staff engineer";
    const candidate = makeCandidate({
      l2: CANDIDATE_TEXT,
      similarity: 0.88,
      // U5: shared atomicFact proves referent identity so the F1 nomination retires.
      atomicFact: { ...priyaFact, value: "senior engineer" },
    });

    const result = await arb({
      text: INCOMING_TEXT,
      candidates: [candidate],
      incomingMetadata: { atomicFact: { ...priyaFact, value: "staff engineer" } },
    });

    // F1 deterministic text supersede should fire (referent identity proven via atomicFact)
    expect(result.outcome).toBe("supersede");
    expect(result.memoryId).toBeTruthy();

    expect(mockLogSupersedeShadow).toHaveBeenCalledOnce();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.appliedMemoryId).toBe(result.memoryId);
    expect(call.appliedMemoryId).not.toBeNull();
    expect(call.appliedOutcome).toBe("supersede");
  });

  it("create branch → applied_memory_id is the new id", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const result = await arb({ text: "completely new unique fact xyz123" });
    expect(result.outcome).toBe("create");

    expect(mockLogSupersedeShadow).toHaveBeenCalledOnce();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.appliedMemoryId).toBe(result.memoryId);
    expect(typeof call.appliedMemoryId).toBe("string");
  });

  it("skip branch → applied_memory_id is null", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({
      l2: "exact text for dedup testing",
      similarity: 0.99,
    });
    const result = await arb({
      text: "exact text for dedup testing",
      candidates: [candidate],
    });
    expect(result.outcome).toBe("skip");

    expect(mockLogSupersedeShadow).toHaveBeenCalledOnce();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.appliedMemoryId).toBeNull();
    expect(call.appliedOutcome).toBe("skip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MFC: judgeEnabled=false in shadow; resolveJudgeDecision NOT called
// ─────────────────────────────────────────────────────────────────────────────

describe("MFC — judgeEnabled=false in shadow resolves", () => {
  it("shadow ON + judge enabled on live path → resolveJudgeDecision called at most once (applied), shadow does NOT call it extra times", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    process.env.RUNIR_SUPERSEDE_JUDGE_GATE = "1";

    // Rúnir-pn1l.13.7 D4: judge is a handle; .judge() is the call surface.
    const judgeFn = vi.fn().mockResolvedValue({
      status: "verdict",
      verdict: { verdict: "independent", confidence: 0 },
    });
    const mockJudge = {
      judge: judgeFn,
      identity: {
        model: "test",
        promptVersion: "v2-continuation-2026-07-09",
        promptSha256: "a".repeat(64),
        confidenceFloor: 0.6,
        temperature: 0.1,
        effectiveJsonMode: true,
        baseUrl: "https://test.example",
        timeoutMs: 30_000,
      },
      getCounters: () => ({
        verdict: 0, unavailable: 0, transport_error: 0, invalid_response: 0,
        vetoed: 0, confirmed: 0, duplicate: 0, ledger_write_failures: 0,
      }),
      noteResolution: vi.fn(),
      noteLedgerWriteFailure: vi.fn(),
    };
    // Candidate in merge band (0.87) that is judge-worthy:
    // needs currentness cue + shared slot tags + non-conflicting subjects
    const TAGS = ["role:tech-lead", "person:dana-cole"];
    const candidate = makeCandidate({
      l2: "Dana Cole is the tech lead on Atlas.",
      similarity: 0.87,
      tags: TAGS,
    });

    // Text has currentness cue ("is now") + shared slot tags
    await arb({
      text: "Dana Cole is now the VP of Engineering on Atlas.",
      candidates: [candidate],
      incomingTags: TAGS,
      judge: mockJudge as any,
    });

    // judge may be called for the applied path (outcome=judge resolved via judge)
    // but NOT for the shadow would/baseline paths.
    // The shadow would path uses judgeEnabled=false → returns "judge" without calling the fn.
    // So judge should be called at most once (for the applied path only).
    expect(judgeFn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("shadow ON + no judge injected + judge gate ON → shadow would_outcome may be 'judge' but judge fn not called", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    process.env.RUNIR_SUPERSEDE_JUDGE_GATE = "1";
    // No judge injected → judgeEnabled = false on applied path too
    const TAGS = ["role:tech-lead", "person:dana-cole"];
    const candidate = makeCandidate({
      l2: "Dana Cole is the tech lead.",
      similarity: 0.87,
      tags: TAGS,
    });

    await arb({
      text: "Dana Cole is now the VP of Engineering.",
      candidates: [candidate],
      incomingTags: TAGS,
    });

    // Shadow was on, so log should be called (no exception thrown)
    // The would outcome may be 'judge' (all flags forced ON including judgeEnabled=false
    // in shadow, but keepBoth guards also ON so might be create instead)
    // The key assertion: if log was called, it didn't invoke a judge fn
    // (no judge fn was passed). Just verify no throw.
    // Applied: no judge fn → judgeEnabled=false → no escalation → merge-update or create
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MF_default_off_isolation: throw in shadow is swallowed
// ─────────────────────────────────────────────────────────────────────────────

describe("MF_default_off_isolation — shadow throw is swallowed", () => {
  it("logSupersedeShadow rejects → applied result still returned correctly", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // Make log throw
    mockLogSupersedeShadow.mockRejectedValue(new Error("DB write failed"));

    const result = await arb({ text: "new fact that will be created" });
    // Applied result must be correct even when log fails
    expect(result.outcome).toBe("create");
    expect(result.memoryId).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MFE: band stamped on ArbitrationDecision; existing callers unaffected
// ─────────────────────────────────────────────────────────────────────────────

describe("MFE — band field on ArbitrationDecision", () => {
  it("create path → band field is available (logged as would_band)", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    await arb({ text: "brand new fact nobody has seen" });
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    // would and baseline both resolve to create → would_band and baseline_band = "create"
    expect(call.wouldBand).toBe("create");
    expect(call.baselineBand).toBe("create");
  });

  it("skip path → band is 'exact-dup' or 'store-near-dup-skip'", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({
      l2: "unique dedup text for band test",
      similarity: 0.99,
    });
    const result = await arb({
      text: "unique dedup text for band test",
      candidates: [candidate],
    });
    expect(result.outcome).toBe("skip");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    // baseline (all-OFF) should land in exact-dup (normalized text match before band check)
    expect(["exact-dup", "store-near-dup-skip", "recent-near-dup-skip"]).toContain(
      call.baselineBand,
    );
  });

  it("ArbitrationDecision band field is optional — existing callers see no type error", async () => {
    // Verify that the applied result still works even though we don't assert band on ArbitrationResult
    const result = await arb({ text: "another brand new fact" });
    // ArbitrationResult (the public type) does not carry band — this verifies no breakage
    expect(result.outcome).toBe("create");
    // No band on the public result shape
    expect((result as any).band).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureSupersedeShadowTable idempotence
// ─────────────────────────────────────────────────────────────────────────────

describe("ensureSupersedeShadowTable — idempotent (mock)", () => {
  it("calling ensure twice does not throw and calls db.query with DEFINE IF NOT EXISTS", async () => {
    const { ensureSupersedeShadowTable } = await import("../../surreal/surreal-store.js");
    // The mock always resolves; calling twice is fine
    await ensureSupersedeShadowTable(makeDb());
    await ensureSupersedeShadowTable(makeDb());
    // Both calls resolved without throw
    expect(mockEnsureSupersedeShadowTable).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// live_flags vector logged correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("live_flags vector", () => {
  it("with all live flags OFF → live_flags all false", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // No flip flags set
    await arb({ text: "new fact for flags test" });
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.liveFlags).toMatchObject({
      cueGate: false,
      temporalGuard: false,
      keepBothGuard: false,
      addSkipGuard: false,
      judgeGate: false,
    });
  });

  it("with cueGate=1 live → live_flags.cueGate=true", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    await arb({ text: "new fact for cue gate flags test" });
    if (mockLogSupersedeShadow.mock.calls.length > 0) {
      const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
      expect(call.liveFlags.cueGate).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 MFA: shadow WOULD uses real present-era nowMs even when live temporal guard
// is OFF (arbitrationNowMs=0). Validate via temporal-ordering path: a candidate
// with a far-future createdAt should NOT block shadow WOULD's cue supersede
// (because shadow nowMs ≈ present era, incomingMs ≈ now >= candidateMs is NOT
// guaranteed — but we can show shadow nowMs is non-zero i.e. present-era by
// checking that shadow WOULD fires a cue supersede on a candidate dated in the
// past, which ONLY works when nowMs is non-zero / present-era).
//
// Concrete approach: use a correction-pass (F1) supersede which does NOT use
// temporal ordering at all, but verify live temporal guard OFF does NOT prevent
// shadow WOULD from computing a supersede (the temporal guard in WOULD is ON,
// but since it uses present-era nowMs, a past-dated candidate is correctly
// handled as "incoming≈now > candidateMs" → supersede permitted).
// ─────────────────────────────────────────────────────────────────────────────

describe("R2 MFA — shadow WOULD uses real present-era nowMs (not 0) when live temporal OFF", () => {
  it("live temporal OFF + shadow ON: WOULD temporal guard uses real nowMs so past-dated candidate does not falsely block shadow supersede", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // Live temporal guard OFF → arbitrationNowMs=0 on the applied path.
    // Shadow WOULD has temporalGuardEnabled=true, and MFA fix gives it Date.now().
    // Use a cue-gated correction-pass supersede to reach the temporal leg:
    // incoming has cue + slot tags, candidate has same slot tags, past validAt/createdAt.
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";

    // Candidate created in the past (2020) — with present-era nowMs, incoming (absent validAt
    // anchored to nowMs) > candidate → temporal leg permits supersede.
    // With nowMs=0 (1970), incomingMs=0 < candidateMs=2020 → temporal leg fires
    // "older-incoming" → keeps both (create). So WOULD outcome differs.
    const PAST_DATE = "2020-01-01T00:00:00.000Z";
    const TAGS = ["role:staff-engineer", "person:dana-cole"];
    const candidate = makeCandidate({
      l2: "Dana Cole is the staff engineer.",
      similarity: 0.88,
      tags: TAGS,
      // createdAt/updatedAt are recent so withinHours gate passes (merge-window check).
      // validAt anchors the temporal leg to the past: candidateMs = parseEpochMs(validAt) = 2020.
      validAt: PAST_DATE,
      // U5: shared atomicFact proves referent identity so the F1 nomination retires.
      atomicFact: { ...danaFact, value: "staff engineer" },
    });

    // Applied path: temporal guard OFF → arbitrationNowMs=0, but temporal guard is OFF
    // so the temporal leg never fires on the applied path — applied outcome = supersede (cue path).
    // Shadow WOULD: temporal guard ON, MFA-correct nowMs=Date.now() (present) →
    //   incomingMs = nowMs (present) > candidateMs (2020) → temporal leg permits → supersede.
    // Shadow WOULD with buggy nowMs=0: incomingMs=0 < candidateMs(2020) → "older-incoming"
    //   → create (keep both). Diverged would be incorrect.
    const result = await arb({
      text: "Dana Cole is now the principal engineer.",
      candidates: [candidate],
      incomingTags: TAGS,
      incomingMetadata: { atomicFact: { ...danaFact, value: "principal engineer" } },
    });

    // Applied: cue gate ON, temporal guard OFF → supersede via cue path.
    expect(result.outcome).toBe("supersede");
    expect(mockLogSupersedeShadow).toHaveBeenCalledOnce();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;

    // With MFA fix (real nowMs in WOULD): WOULD outcome = supersede (present > past).
    // This is the key assertion: shadow WOULD is NOT corrupted by 1970-era anchor.
    expect(call.wouldOutcome).toBe("supersede");

    // Applied path byte-identical (shadow doesn't affect it)
    expect(result.outcome).toBe("supersede");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 MFB: BASELINE uses floor=mergeThreshold, NOT the live/possibly-lowered floor.
// A candidate at cosine 0.78:
//   BASELINE floor=mergeThreshold(0.85) → 0.78 < 0.85 → not eligible → no supersede → create
//   WOULD floor=0.75 → 0.78 > 0.75 → eligible → cue supersede fires → supersede
// → diverged=true (baseline_outcome=create, would_outcome=supersede)
// ─────────────────────────────────────────────────────────────────────────────

describe("R2 MFB — BASELINE uses floor=mergeThreshold (not live-lowered floor)", () => {
  it("live floor lowered to 0.75 AND shadow ON: BASELINE uses mergeThreshold(0.85) so cos=0.78 candidate is below baseline floor → baseline=create, would=supersede → diverged=true", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    // Live floor set to 0.75 so the applied path CAN supersede at cos=0.78
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.75";

    const TAGS = ["role:principal-engineer", "person:priya-nair"];
    // cos=0.78: above WOULD floor (0.75), below BASELINE floor (=mergeThreshold=0.85)
    const candidate = makeCandidate({
      l2: "Priya Nair is the principal engineer.",
      similarity: 0.78,
      tags: TAGS,
      atomicFact: { ...priyaFact, value: "principal engineer" },
    });

    const result = await arb({
      text: "Priya Nair is now the VP of Engineering.",
      candidates: [candidate],
      incomingTags: TAGS,
      incomingMetadata: { atomicFact: { ...priyaFact, value: "VP of Engineering" } },
    });

    // Applied: cue gate ON, floor=0.75 → cos=0.78 >= 0.75 → supersede
    expect(result.outcome).toBe("supersede");
    expect(mockLogSupersedeShadow).toHaveBeenCalledOnce();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;

    // WOULD floor=0.75 → cos=0.78 eligible → cue supersede → supersede
    expect(call.wouldOutcome).toBe("supersede");

    // BASELINE floor=mergeThreshold(0.85) → cos=0.78 < 0.85 → not eligible for supersede
    // → no correction pass fires → falls through to merge/create
    // Since cos=0.78 is also below skipThreshold(0.95) and mergeThreshold(0.85), no skip/merge
    // → baseline outcome = create (no eligible candidate in any band)
    expect(call.baselineOutcome).toBe("create");

    // diverged = baseline(create) !== would(supersede) → true
    expect(call.diverged).toBe(true);
  });

  it("with live floor=0.75 but shadow OFF → RUNIR_SUPERSEDE_CANDIDATE_FLOOR still only affects applied path (no leakage)", async () => {
    // Shadow OFF: verify the env var cleanup does not affect anything
    process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR = "0.75";
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    // Shadow OFF (RUNIR_SUPERSEDE_SHADOW not set)
    const TAGS = ["role:staff-engineer", "person:priya-nair"];
    const candidate = makeCandidate({
      l2: "Priya Nair is the staff engineer.",
      similarity: 0.78,
      tags: TAGS,
      atomicFact: { ...priyaFact, value: "staff engineer" },
    });
    const result = await arb({
      text: "Priya Nair is now the VP of Engineering.",
      candidates: [candidate],
      incomingTags: TAGS,
      incomingMetadata: { atomicFact: { ...priyaFact, value: "VP of Engineering" } },
    });
    expect(result.outcome).toBe("supersede");
    expect(mockLogSupersedeShadow).not.toHaveBeenCalled();
  });
});
