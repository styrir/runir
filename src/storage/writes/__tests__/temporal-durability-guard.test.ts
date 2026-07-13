import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l.2 (Q2) + pn1l.7/pn1l.8 — supersede-only temporal + durability pre-guard.
// A supersede must be driven by a fact that is NEWER and not-more-transient than the
// one it replaces. The guard turns supersede → create (keep both) when ordering is
// unknown / out-of-order, or a transient/ephemeral incoming would overwrite a durable
// stored fact. Behind RUNIR_SUPERSEDE_TEMPORAL_GUARD (default OFF): on ⇒ F2/cue/judge
// supersedes are gated; off ⇒ byte-for-byte today's behavior. Conservative: only ever
// supersede → create, never the reverse.
//
// pn1l.7 — the temporal-ordering leg now anchors an ABSENT incoming validAt to
//   ingestion-now (Zep-style cue→reference-time anchoring at arbitration). An
//   UNPARSEABLE incoming validAt still keeps both (must NOT silently become now).
// pn1l.8 — the durability leg (durableTransientKeepBothReason) is split out and runs
//   on ALL paths INCLUDING F1 (deterministic_text) and the merge band, so a transient
//   restatement can never overwrite a durable fact. The temporal-ordering leg stays
//   OFF the F1 path (w077 — don't temporally-gate the deterministic same-key path).

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

import {
  arbitrateWrite,
  hasTransienceCue,
  durableTransientKeepBothReason,
  temporalOrderingKeepBothReason,
} from "../write-arbitrator.js";
import { findSimilarMemories, supersedeMemory, updateMemoryText } from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";
import type { SupersessionJudgeHandle, SupersessionVerdict } from "../supersession-judge.js";
import { DEFAULT_JUDGE_CONFIDENCE_FLOOR, emptyJudgeCounters, JUDGE_PROMPT_VERSION } from "../supersession-judge.js";

const T_OLD = "2026-06-01T00:00:00.000Z";
const T_NEW = "2026-06-15T00:00:00.000Z";
// A validAt comfortably in the future of any ingestion-now anchor — used to prove the
// future-dated-candidate holdout (manufacture-now must still lose the strict comparison).
const T_FUTURE = "2099-01-01T00:00:00.000Z";
// Fixed arbitration-now used for all pure-function tests so they are deterministic and
// never flaky (temporalOrderingKeepBothReason no longer calls Date.now() internally —
// the caller supplies the epoch, MUST-FIX #2).
const NOW_MS = new Date("2026-06-23T12:00:00.000Z").getTime();

function uCand(o: Partial<SimilarCandidate> = {}): SimilarCandidate {
  return { id: "c", l2: "candidate text", similarity: 0.9, createdAt: T_OLD, ...o };
}

// ───────────────── Part A1 — durableTransientKeepBothReason (durability leg) ─────────────────
describe("durableTransientKeepBothReason — transient/ephemeral over durable", () => {
  it("transient incoming (cue) over a DURABLE candidate → transient-over-durable", () => {
    expect(durableTransientKeepBothReason(
      uCand({ tier: "durable" }), "Marcus leads on-call for now", "working"))
      .toBe("transient-over-durable");
  });

  it("EPHEMERAL incoming over a DURABLE candidate → ephemeral-over-durable (no cue needed)", () => {
    expect(durableTransientKeepBothReason(
      uCand({ tier: "durable" }), "Marcus leads on-call", "ephemeral"))
      .toBe("ephemeral-over-durable");
  });

  it("DURABLE incoming with a transience cue is NOT blocked (durable replacing durable supersedes — w077)", () => {
    expect(durableTransientKeepBothReason(
      uCand({ tier: "durable" }), "We use Postgres for now", "durable"))
      .toBeNull();
  });

  it("transience cue against a NON-durable candidate → null (only durable candidates are protected)", () => {
    expect(durableTransientKeepBothReason(
      uCand({ tier: "working" }), "Marcus leads for now", "working"))
      .toBeNull();
  });

  it("undefined incoming tier + transience cue still protects a durable candidate", () => {
    expect(durableTransientKeepBothReason(
      uCand({ tier: "durable" }), "Marcus leads for now", undefined))
      .toBe("transient-over-durable");
  });

  it("UNKNOWN incoming tier, NO transience cue, durable candidate → null (PERMIT — must NOT widen)", () => {
    // The durability leg keeps-both ONLY for an explicitly-transient incoming. An
    // unknown tier with no cue is not a transience signal → supersede is permitted.
    expect(durableTransientKeepBothReason(
      uCand({ tier: "durable" }), "Marcus is the on-call lead", undefined))
      .toBeNull();
  });
});

// ───────────────── Part A2 — temporalOrderingKeepBothReason (temporal leg, pn1l.7) ─────────────────
// All calls pass NOW_MS explicitly — the function is a pure predicate (no Date.now() inside).
describe("temporalOrderingKeepBothReason — ordering + pn1l.7 absent-validAt anchoring", () => {
  it("pn1l.7 ABSENT incoming validAt anchors to nowMs → supersede permitted vs a past candidate (null)", () => {
    // The un-neuter: an undated cue-driven supersede anchors to arbitration-now (NOW_MS),
    // which is newer than T_OLD, so the supersede proceeds.
    expect(temporalOrderingKeepBothReason(uCand({ validAt: T_OLD }), undefined, NOW_MS)).toBeNull();
    expect(temporalOrderingKeepBothReason(uCand({ validAt: T_OLD }), "", NOW_MS)).toBeNull();
  });

  it("pn1l.7 FUTURE-dated candidate vs nowMs → older-incoming (strict-older still blocks)", () => {
    // candidate.validAt is in the far future; NOW_MS is older → keep both.
    expect(temporalOrderingKeepBothReason(uCand({ validAt: T_FUTURE }), undefined, NOW_MS))
      .toBe("older-incoming");
  });

  it("pn1l.7 UNPARSEABLE incoming validAt → invalid-incoming-validAt (must NOT silently become now)", () => {
    expect(temporalOrderingKeepBothReason(uCand({ validAt: T_OLD }), "not-a-date", NOW_MS))
      .toBe("invalid-incoming-validAt");
  });

  it("unparseable candidate time (validAt and createdAt) → invalid-candidate-time", () => {
    expect(temporalOrderingKeepBothReason(
      uCand({ validAt: undefined, createdAt: "garbage" }), T_NEW, NOW_MS))
      .toBe("invalid-candidate-time");
  });

  it("incoming older than candidate → older-incoming", () => {
    expect(temporalOrderingKeepBothReason(uCand({ createdAt: T_NEW }), T_OLD, NOW_MS)).toBe("older-incoming");
  });

  it("incoming newer than candidate, parseable both sides → null (supersede allowed)", () => {
    expect(temporalOrderingKeepBothReason(uCand({ createdAt: T_OLD }), T_NEW, NOW_MS)).toBeNull();
  });

  it("equal timestamps are not 'older' → null (allowed)", () => {
    expect(temporalOrderingKeepBothReason(uCand({ createdAt: T_NEW }), T_NEW, NOW_MS)).toBeNull();
  });

  it("candidate validAt takes precedence over createdAt for ordering", () => {
    expect(temporalOrderingKeepBothReason(uCand({ validAt: T_NEW, createdAt: T_OLD }), T_OLD, NOW_MS))
      .toBe("older-incoming");
  });

  it("coerces a Date-valued candidate time (Surreal datetime), not treats it as invalid", () => {
    expect(temporalOrderingKeepBothReason(
      uCand({ createdAt: new Date(T_NEW) as unknown as string }), T_OLD, NOW_MS))
      .toBe("older-incoming");
  });

  it("a non-string/non-Date candidate time → invalid-candidate-time (keep both, never a wrong supersede)", () => {
    expect(temporalOrderingKeepBothReason(
      uCand({ validAt: {} as unknown as string, createdAt: {} as unknown as string }), T_NEW, NOW_MS))
      .toBe("invalid-candidate-time");
  });
});

describe("hasTransienceCue — temporary-state phrasing only", () => {
  it.each([
    "Marcus leads for now",
    "He's covering temporarily",
    "She owns it this week",
    "Reviewing it this sprint",
    "I'm out today",
    "On call tonight",
    "He's lead at the moment",
    "She's driving right now",
    "Mine for the time being",
    "Yours for the moment",
    "Travelling this month",
    "Busy this morning",
  ])("detects %j", (text) => expect(hasTransienceCue(text)).toBe(true));

  it.each([
    "We currently use Postgres",   // 'currently' is a durable-state word, NOT transience (Codex)
    "Marcus is now the lead",      // bare 'now' is a currentness cue, not transience
    "Priya is no longer the lead",
    "The user prefers dark mode",
  ])("does NOT flag %j", (text) => expect(hasTransienceCue(text)).toBe(false));
});

// ──────────────────── Part B — wiring through arbitrateWrite ────────────────────
function makeDb() { return { query: vi.fn().mockResolvedValue([[]]) } as any; }
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function iCand(o: Partial<SimilarCandidate> = {}): SimilarCandidate {
  const now = new Date().toISOString(); // within the 72h merge window
  return { id: "seed-id", l2: "Priya Nair is the on-call lead for Atlas", similarity: 0.9, createdAt: now, updatedAt: now, ...o };
}
async function arb(text: string, candidate: SimilarCandidate, metadata?: Record<string, unknown>, judge?: SupersessionJudgeHandle) {
  (findSimilarMemories as Mock).mockResolvedValue([candidate]);
  const embedding = makeVec(0);
  return arbitrateWrite({
    db: makeDb(), text, userId: "u1", embedding, scope: "user", source: "memory_store",
    recentWrites: new Map<string, RecentWrite[]>(), embedText: vi.fn().mockResolvedValue(embedding),
    ...(metadata ? { metadata } : {}), ...(judge ? { judge } : {}),
  });
}
const SEED_TAGS = ["project:atlas", "role:on-call-lead", "person:priya-nair"];
const HANDOFF_TAGS = ["project:atlas", "role:on-call-lead", "subject:marcus-webb"];
const CUE_HANDOFF = "Marcus Webb is now the on-call lead, replacing Priya Nair";
// Rúnir-pn1l.13.4 (U5): F1 is nominate-only — a same-key value correction retires the
// candidate only with a proven referent identity. A production same-subject value change
// carries a shared atomicFact {subject, predicate} (stable across the value), proving
// identity via key:atomicFactIdentity. These durability-leg tests thread it so the F1
// supersede fires and the durability/temporal interaction (the actual subject under test)
// is exercised. Keyless-blocked F1 is covered in referent-gate-arbitration.test.ts.
const ATLAS_DS_FACT = { subject: "Atlas primary datastore", predicate: "is" };
// Rúnir-h435.1 [R1-3]: complete triple required for proof-readiness (value excluded from identity).
const judgeReturning = (v: SupersessionVerdict): SupersessionJudgeHandle & { judge: Mock } => {
  const counters = emptyJudgeCounters();
  const judgeFn = vi.fn().mockResolvedValue({ status: "verdict", verdict: v });
  return {
    judge: judgeFn,
    identity: {
      model: "test-model",
      promptVersion: JUDGE_PROMPT_VERSION,
      promptSha256: "a".repeat(64),
      confidenceFloor: DEFAULT_JUDGE_CONFIDENCE_FLOOR,
      temperature: 0.1,
      effectiveJsonMode: true,
      baseUrl: "https://test.example",
      timeoutMs: 30_000,
    },
    getCounters: () => ({ ...counters }),
    noteResolution: vi.fn(),
    noteLedgerWriteFailure: vi.fn(),
  };
};

beforeEach(() => {
  process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1"; // Rúnir-h435.1 [R1-1] F1 fixtures use atomicFact fuel
  vi.clearAllMocks();
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
});

describe("temporal guard OFF (default) — byte-for-byte", () => {
  it("a cue-driven F2 supersede still supersedes with the guard off (even with no validAt)", async () => {
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    const r = await arb(CUE_HANDOFF, iCand({ tags: SEED_TAGS }), { tags: HANDOFF_TAGS });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("a judge supersede still supersedes with the guard off (judge site default-OFF, no validAt)", async () => {
    process.env.RUNIR_SUPERSEDE_JUDGE_GATE = "1"; // judge fires; temporal guard intentionally unset
    const judge = judgeReturning({ verdict: "supersede", confidence: 0.9 });
    const cand = iCand({ l2: "The Atlas datastore is SurrealDB", similarity: 0.88, tags: ["project:atlas", "datastore:surrealdb"] });
    const r = await arb("We migrated the Atlas datastore off SurrealDB to Postgres", cand,
      { tags: ["project:atlas", "datastore:postgres"] }, judge);
    expect(judge.judge).toHaveBeenCalled();
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  // pn1l.8 DEFAULT-OFF regression: a transient restatement of a durable fact via F1
  // SUPERSEDES with the guard off (today's behavior — proves the temporal flag still
  // gates durability-on-F1 for non-atomic proofs). Rúnir-h435.1 PIN-6: atomic-proven F1
  // runs durability UNCONDITIONALLY, so this row uses key:factKey fuel (not atomic) to
  // keep the original "flag gates pn1l.8" assertion meaningful.
  it("F1 transient→durable SUPERSEDES with the guard off (proves flag gates pn1l.8)", async () => {
    const r = await arb(
      "Atlas primary datastore is Postgres for now",
      iCand({
        l2: "Atlas primary datastore is SurrealDB",
        similarity: 0.93,
        tier: "durable",
        factKey: "config:atlas-primary-datastore",
      }),
      { tier: "working", factKey: "config:atlas-primary-datastore" });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  // pn1l.8 DEFAULT-OFF regression: a same-subject attribute change folds in the merge
  // band with the guard off (today's behavior).
  it("merge-band transient→durable MERGES with the guard off (proves flag gates pn1l.8 merge-band)", async () => {
    // Subsuming-value pattern: incoming extends the candidate's value, so it is NOT an
    // F1 same-key replacement (wouldSupersedeTexts substring rule) and falls to the merge band.
    const cand = iCand({ l2: "user prefers dark mode", similarity: 0.9, tier: "durable" });
    const r = await arb("user prefers dark mode and reduced motion for now", cand, { tier: "working" });
    expect(r.outcome).toBe("merge-update");
    expect(updateMemoryText).toHaveBeenCalled();
  });
});

describe("temporal guard ON — F2/cue producer", () => {
  beforeEach(() => { process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD = "1"; process.env.RUNIR_SUPERSEDE_CUE_GATE = "1"; });

  // pn1l.7 HAPPY PATH (the un-neuter): a cue supersede with NO incoming validAt now
  // anchors to ingestion-now and PROCEEDS against a past-created candidate.
  it("pn1l.7 ALLOWS a cue supersede with NO incoming validAt (anchors to now > past candidate)", async () => {
    const r = await arb(CUE_HANDOFF, iCand({ tags: SEED_TAGS, validAt: T_OLD }), { tags: HANDOFF_TAGS });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("ALLOWS the cue supersede when the incoming validAt is newer than a non-durable candidate", async () => {
    const r = await arb(CUE_HANDOFF, iCand({ tags: SEED_TAGS, validAt: T_OLD }), { tags: HANDOFF_TAGS, validAt: T_NEW });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  // pn1l.7 / holdout #1 — temporal-move: a cue supersede carrying a TRANSIENCE cue
  // ("for this sprint") over a standing durable default keeps both (durability leg
  // fires FIRST, manufacture-now never gets to erase it).
  it("pn1l.7 temporal-move: cue + 'for this sprint' over a DURABLE candidate → create + transient-over-durable", async () => {
    const r = await arb(
      "Marcus Webb is now the on-call lead this sprint, replacing Priya Nair",
      iCand({ tags: SEED_TAGS, tier: "durable", validAt: T_OLD }),
      { tags: HANDOFF_TAGS, tier: "working" });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/durability guard/);
    expect(r.reason).toMatch(/transient-over-durable/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  // pn1l.7 / holdout #2 — future-dated candidate: candidate.validAt is in the future,
  // incoming carries NO validAt (anchors to now < candidate) → keep both.
  it("pn1l.7 future-dated candidate vs manufactured-now incoming → create + older-incoming", async () => {
    const r = await arb(CUE_HANDOFF, iCand({ tags: SEED_TAGS, validAt: T_FUTURE }), { tags: HANDOFF_TAGS });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/temporal-ordering guard/);
    expect(r.reason).toMatch(/older-incoming/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  // pn1l.7 / holdout #3 — invalid incoming validAt must NOT silently become now.
  it("pn1l.7 invalid incoming validAt → create + invalid-incoming-validAt (no silent supersede)", async () => {
    const r = await arb(CUE_HANDOFF, iCand({ tags: SEED_TAGS, validAt: T_OLD }),
      { tags: HANDOFF_TAGS, validAt: "not-a-date" });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/temporal-ordering guard/);
    expect(r.reason).toMatch(/invalid-incoming-validAt/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("protects a DURABLE candidate from a transient incoming even with newer validAt → create + transient-over-durable", async () => {
    const r = await arb(
      "Marcus Webb is now the on-call lead this week, replacing Priya Nair",
      iCand({ tags: SEED_TAGS, tier: "durable", validAt: T_OLD }),
      { tags: HANDOFF_TAGS, validAt: T_NEW, tier: "working" });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/transient-over-durable/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });
});

describe("temporal guard ON — F1 (deterministic_text): durability gated, temporal NOT", () => {
  beforeEach(() => { process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD = "1"; });

  // pn1l.8 / holdout #4 — F1 durable→durable: a clean deterministic same-key durable
  // correction MUST still supersede (no w077 regression; durable→durable supersedes).
  it("pn1l.8 F1 durable→durable still SUPERSEDES (no w077 regression)", async () => {
    const r = await arb(
      "Atlas primary datastore is Postgres",
      iCand({ l2: "Atlas primary datastore is SurrealDB", similarity: 0.93, tier: "durable", atomicFact: { ...ATLAS_DS_FACT, value: "SurrealDB" } }),
      { tier: "durable", atomicFact: { ...ATLAS_DS_FACT, value: "Postgres" } });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  // pn1l.8 / holdout #5 — F1 transient→durable: a transient restatement of a durable
  // fact via F1 → keep both (closes f1_bypass — the durability leg now runs on F1).
  it("pn1l.8 F1 transient→durable → create + durability guard (closes f1_bypass)", async () => {
    const r = await arb(
      "Atlas primary datastore is Postgres for now",
      iCand({ l2: "Atlas primary datastore is SurrealDB", similarity: 0.93, tier: "durable" }),
      { tier: "working" });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/durability guard/);
    expect(r.reason).toMatch(/transient-over-durable/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("F1 with no validAt and a non-durable candidate still supersedes (temporal leg stays OFF F1)", async () => {
    const r = await arb(
      "Atlas primary datastore is Postgres",
      iCand({ l2: "Atlas primary datastore is SurrealDB", similarity: 0.93, atomicFact: { ...ATLAS_DS_FACT, value: "SurrealDB" } }),
      /* no validAt, no tier; F1 temporal leg must NOT gate. atomicFact proves referent
         identity (U5 nominate-only) so the F1 supersede fires. */
      { atomicFact: { ...ATLAS_DS_FACT, value: "Postgres" } });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });
});

describe("temporal guard ON — merge band (pn1l.8 Finding 3)", () => {
  beforeEach(() => { process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD = "1"; process.env.RUNIR_SUPERSEDE_CUE_GATE = "1"; });

  // pn1l.8 / holdout #6 — merge-band transient→durable: a same-subject attribute change
  // (identical slot tags, no subject change → no cue supersede signal → merge band),
  // durable candidate, transient incoming → keep both (closes Finding 3 reachability).
  it("pn1l.8 merge-band transient→durable → create + merge-band durability guard", async () => {
    // Subsuming-value pattern → merge band (NOT an F1 supersede); durable candidate +
    // transient incoming → kept both deterministically (Layer 0), never folded.
    const cand = iCand({ l2: "user prefers dark mode", similarity: 0.9, tier: "durable" });
    const r = await arb("user prefers dark mode and reduced motion for now", cand, { tier: "working" });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/merge-band durability guard/);
    expect(r.reason).toMatch(/transient-over-durable/);
    expect(updateMemoryText).not.toHaveBeenCalled();
  });

  it("merge-band durable→durable still MERGES (durability leg permits durable replacing durable)", async () => {
    const cand = iCand({ l2: "user prefers dark mode", similarity: 0.9, tier: "durable" });
    const r = await arb("user prefers dark mode and reduced motion", cand, { tier: "durable" });
    expect(r.outcome).toBe("merge-update");
    expect(updateMemoryText).toHaveBeenCalled();
  });
});

describe("temporal guard ON — skip band (pn1l.8 acceptance #7, in-scope-benign)", () => {
  beforeEach(() => { process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD = "1"; });

  // pn1l.8 / holdout #7 — skip-band transient→durable: a transient near-dup at
  // cosine >= skipThreshold (0.95) SKIPS (the incoming is dropped) BEFORE any
  // durability check. For the durability DIRECTION this is benign — the DURABLE
  // candidate is retained untouched. No code change to the skip band; this proves it.
  it("pn1l.8 skip-band transient→durable at >= skipThreshold → skip (durable candidate retained)", async () => {
    // cosine 0.97 >= skipThreshold (0.95) within the skip window → the store near-dup
    // skip fires (step 4) BEFORE the merge band, dropping the incoming. Subsuming-value
    // shape so it is not an F1 supersede / exact-dup. Benign for the durability direction.
    const cand = iCand({ l2: "user prefers dark mode", similarity: 0.97, tier: "durable" });
    const r = await arb("user prefers dark mode and reduced motion for now", cand, { tier: "working" });
    expect(r.outcome).toBe("skip");
    // The durable candidate is neither superseded nor mutated.
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled();
  });
});

describe("temporal guard ON — judge producer", () => {
  beforeEach(() => { process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD = "1"; process.env.RUNIR_SUPERSEDE_JUDGE_GATE = "1"; });

  // pn1l.7 carries into the judge site: a judge supersede with NO incoming validAt now
  // anchors to ingestion-now and PROCEEDS against a past-created candidate.
  it("pn1l.7 ALLOWS a judge supersede with NO incoming validAt (anchors to now > past candidate)", async () => {
    const judge = judgeReturning({ verdict: "supersede", confidence: 0.9 });
    const cand = iCand({ l2: "The Atlas datastore is SurrealDB", similarity: 0.88, tags: ["project:atlas", "datastore:surrealdb"], validAt: T_OLD });
    const r = await arb("We migrated the Atlas datastore off SurrealDB to Postgres", cand,
      { tags: ["project:atlas", "datastore:postgres"] }, judge);
    expect(judge.judge).toHaveBeenCalled();
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("intercepts a judge supersede when the candidate is future-dated → create (judge ran, overridden)", async () => {
    const judge = judgeReturning({ verdict: "supersede", confidence: 0.9 });
    const cand = iCand({ l2: "The Atlas datastore is SurrealDB", similarity: 0.88, tags: ["project:atlas", "datastore:surrealdb"], validAt: T_FUTURE });
    const r = await arb("We migrated the Atlas datastore off SurrealDB to Postgres", cand,
      { tags: ["project:atlas", "datastore:postgres"] }, judge);
    expect(judge.judge).toHaveBeenCalled();
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/temporal-ordering guard/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("protects a DURABLE candidate from a transient incoming on the judge-escalation route → create + durability guard", async () => {
    // A transient-over-durable conflict on the merge/judge route is intercepted
    // DETERMINISTICALLY by the merge-band durability leg (Layer 0) BEFORE the paid judge
    // is ever consulted — a wrong durable overwrite must not depend on a paid call. The
    // judge-site durability leg remains as defense-in-depth for any future judge producer.
    const judge = judgeReturning({ verdict: "supersede", confidence: 0.9 });
    const cand = iCand({ l2: "The Atlas datastore is SurrealDB", similarity: 0.88, tier: "durable", tags: ["project:atlas", "datastore:surrealdb"] });
    const r = await arb("We migrated the Atlas datastore off SurrealDB to Postgres for now", cand,
      { tags: ["project:atlas", "datastore:postgres"], tier: "working" }, judge);
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/durability guard/);
    expect(r.reason).toMatch(/transient-over-durable/);
    expect(judge.judge).not.toHaveBeenCalled(); // deterministic interception, no paid call
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("ALLOWS the judge supersede when the incoming validAt is newer than a non-durable candidate", async () => {
    const judge = judgeReturning({ verdict: "supersede", confidence: 0.9 });
    const cand = iCand({ l2: "The Atlas datastore is SurrealDB", similarity: 0.88, tags: ["project:atlas", "datastore:surrealdb"], validAt: T_OLD });
    const r = await arb("We migrated the Atlas datastore off SurrealDB to Postgres", cand,
      { tags: ["project:atlas", "datastore:postgres"], validAt: T_NEW }, judge);
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });
});
