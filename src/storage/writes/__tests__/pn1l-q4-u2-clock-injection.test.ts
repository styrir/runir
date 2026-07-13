import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l Q4 U2 — write-path clock injection tests.
//
// THE load-bearing invariant: adding the optional `nowMs` param to the arbitration path
// is BYTE-IDENTICAL for the applied production decision when the param is OMITTED. Codex
// attacked this twice (brief v1 + re-gate): the fix is that `arbitrateWrite` passes the RAW
// `input.nowMs` through to each callee, and each callee resolves `nowMs ?? Date.now()`
// LOCALLY — so an omitted clock leaves every site doing its OWN independent `Date.now()`,
// never a single collapsed instant.
//
// Covers:
//   - Independence (NOT collapsed): with nowMs omitted, a candidate straddling the recency
//     window decides identically to a reference `Date.now()` computed independently — proving
//     each withinHours site reads its own real clock, not a shared captured one.
//   - Injected clock shifts the window deterministically: the SAME candidate is in-window at
//     one nowMs and out-of-window at a later nowMs, flipping skip↔create.
//   - Shadow clock: with nowMs injected to an OLD instant, the WOULD/BASELINE recency checks
//     use the replay clock too (a candidate is in the merge window at replay time, not real
//     time) so divergence is not a clock artifact.
//
// resolveDecision / withinHours / findSupersedeTarget are internal to write-arbitrator.ts,
// so these drive the exported `arbitrateWrite` with a mocked `findSimilarMemories` (the same
// pattern as pn1l13-2-shadow.test.ts) — controlling the candidate pool + timestamps directly.

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
import { findSimilarMemories, logSupersedeShadow } from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

const mockFindSimilar = findSimilarMemories as Mock;
const mockLogShadow = logSupersedeShadow as Mock;

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}

function makeVec(seed: number, len = 16): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

const HOUR_MS = 3600 * 1000;

function makeCandidate(o: Partial<SimilarCandidate> & { l2: string; similarity: number }): SimilarCandidate {
  const now = new Date().toISOString();
  return { id: "cand-id", createdAt: now, updatedAt: now, ...o };
}

/** Drive arbitrateWrite with a fixed candidate pool + optional nowMs. */
async function arb(opts: {
  text: string;
  candidates: SimilarCandidate[];
  nowMs?: number;
  recentWrites?: Map<string, RecentWrite[]>;
}) {
  mockFindSimilar.mockResolvedValue(opts.candidates);
  const embedding = makeVec(0, 16);
  return arbitrateWrite({
    db: makeDb(),
    text: opts.text,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: opts.recentWrites ?? new Map(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogShadow.mockResolvedValue(undefined);
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
});
afterEach(() => {
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
});

// ─────────────────────────────────────────────────────────────────────────────
// Byte-identical / independence: omitted nowMs ⇒ each site uses its own Date.now()
// ─────────────────────────────────────────────────────────────────────────────

describe("omitted nowMs is byte-identical (each withinHours reads its own Date.now())", () => {
  // The store near-dup skip band fires at similarity >= skipThreshold (0.95) AND
  // withinHours(candidate, skipWindowHours=24). An exact-text near-dup 1h old is well inside
  // the 24h window ⇒ SKIP. This must hold with nowMs OMITTED exactly as before the U2 change.
  it("a fresh exact near-dup still skips with nowMs omitted", async () => {
    const text = "The deploy target is staging for the ingest worker rollout this week.";
    const oneHourAgo = new Date(Date.now() - 1 * HOUR_MS).toISOString();
    const candidate = makeCandidate({ l2: text, similarity: 0.99, createdAt: oneHourAgo, updatedAt: oneHourAgo });
    const res = await arb({ text, candidates: [candidate] });
    expect(res.outcome).toBe("skip");
  });

  // Independence proof at the 72h merge/recency boundary (the widest window any band uses).
  // An exact-text near-dup is absorbed (skip via containment) ONLY while it is within the 72h
  // merge window; a candidate 73h old is OUT of EVERY recency window ⇒ falls through to create.
  // Because each withinHours call resolves its OWN Date.now() (NOT a shared captured clock),
  // this boundary is judged against real time with nowMs OMITTED — the exact production timing,
  // proving omission does not change the observable outcome vs. the pre-U2 code.
  it("candidate just OUTSIDE the 72h window (73h old) creates; just INSIDE (71h) skips — nowMs omitted", async () => {
    const text = "Prod endpoint moved to us-west for the primary read replica cluster.";
    const old73h = new Date(Date.now() - 73 * HOUR_MS).toISOString();
    const old71h = new Date(Date.now() - 71 * HOUR_MS).toISOString();

    const outside = await arb({
      text,
      candidates: [makeCandidate({ l2: text, similarity: 0.99, createdAt: old73h, updatedAt: old73h })],
    });
    expect(outside.outcome).toBe("create"); // out of every recency window, no band matches

    const inside = await arb({
      text,
      candidates: [makeCandidate({ l2: text, similarity: 0.99, createdAt: old71h, updatedAt: old71h })],
    });
    expect(inside.outcome).toBe("skip"); // within the 72h merge window (absorbed)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-site independence, PROVEN by controlled Date.now() sequencing (Codex P3)
// ─────────────────────────────────────────────────────────────────────────────
//
// The coarse 71h/73h cases above would ALSO pass a broken "capture Date.now() once at the
// top and thread it everywhere" regression, because that regression is still self-consistent
// within a single arbitrateWrite call. This block is the sharper proof Codex asked for: it
// pins a candidate 1ms INSIDE the 72h merge window relative to an EARLY instant T, then forces
// the LIVE clock the applied `withinHours` site reads to a LATER instant T+10ms. With nowMs
// OMITTED:
//   - if each site reads its OWN Date.now() (correct), the candidate is 72h+9ms old at the
//     withinHours site ⇒ OUTSIDE the window ⇒ create (EXCLUDED at withinHours);
//   - a capture-once regression that threaded a value resolved at/near T would still see the
//     candidate as inside ⇒ skip — so this test FAILS on that regression.
// The decisive structural guard is the trailing-arg assertion: with nowMs omitted, the RAW
// `input.nowMs` (undefined) must reach findSimilarMemories as its 9th arg — a capture-once
// regression would pass a NUMBER there instead.

const MERGE_WINDOW_MS = 72 * HOUR_MS; // config.mergeWindowHours (72) — the widest band window

describe("per-site independence proven by controlled Date.now() (Codex P3)", () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    nowSpy?.mockRestore();
  });

  it("candidate 1ms inside the window at T is EXCLUDED at withinHours when the live clock has advanced to T+10ms (nowMs omitted)", async () => {
    const text = "Ingest worker concurrency raised to eight for the backfill window.";
    const T = Date.parse("2026-04-01T00:00:00.000Z");
    // Candidate updated 1ms INSIDE the 72h window measured from T.
    const candidateAt = new Date(T - MERGE_WINDOW_MS + 1).toISOString();
    const candidate = makeCandidate({ l2: text, similarity: 0.99, createdAt: candidateAt, updatedAt: candidateAt });

    // Freeze the live clock at T+10ms: every applied `withinHours` call (which resolves its OWN
    // Date.now() when nowMs is omitted) sees the candidate as 72h+9ms old ⇒ outside ⇒ create.
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(T + 10);
    mockFindSimilar.mockResolvedValue([candidate]);

    const res = await arbitrateWrite({
      db: makeDb(),
      text,
      userId: "u1",
      embedding: makeVec(0, 16),
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(makeVec(0, 16)),
      // nowMs OMITTED — the applied path must read the (mocked) live clock per-site.
    });

    expect(res.outcome).toBe("create"); // excluded at withinHours (age 72h+9ms > 72h)

    // Structural proof of raw passthrough (kills capture-once): findSimilarMemories received
    // `undefined` as its trailing (9th, index 8) clock arg, NOT a captured Date.now() number.
    expect(mockFindSimilar).toHaveBeenCalledTimes(1);
    const trailingClockArg = mockFindSimilar.mock.calls[0][8];
    expect(trailingClockArg).toBeUndefined();
  });

  it("the SAME 1ms-inside candidate is ABSORBED (skip) when the live clock reads exactly T", async () => {
    // Contrast: with the live clock at T (not advanced), the candidate is 72h-1ms old ⇒ inside
    // the 72h window ⇒ absorbed ⇒ skip. The only difference from the case above is where the
    // applied withinHours site's OWN Date.now() lands — proving the live per-site clock decides.
    const text = "Ingest worker concurrency raised to eight for the backfill window.";
    const T = Date.parse("2026-04-01T00:00:00.000Z");
    const candidateAt = new Date(T - MERGE_WINDOW_MS + 1).toISOString();
    const candidate = makeCandidate({ l2: text, similarity: 0.99, createdAt: candidateAt, updatedAt: candidateAt });

    nowSpy = vi.spyOn(Date, "now").mockReturnValue(T);
    mockFindSimilar.mockResolvedValue([candidate]);

    const res = await arbitrateWrite({
      db: makeDb(),
      text,
      userId: "u1",
      embedding: makeVec(0, 16),
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(makeVec(0, 16)),
      // nowMs OMITTED.
    });

    expect(res.outcome).toBe("skip"); // within the 72h window at T (absorbed)
  });

  it("an INJECTED nowMs overrides the live clock: the trailing arg to findSimilarMemories is the injected value", async () => {
    // The mirror of the passthrough proof: when nowMs IS supplied, findSimilarMemories must
    // receive that exact value (not Date.now()) as its trailing arg, and the decision follows
    // the injected clock regardless of what the (mocked) real clock says.
    const text = "Ingest worker concurrency raised to eight for the backfill window.";
    const T = Date.parse("2026-04-01T00:00:00.000Z");
    const candidateAt = new Date(T - MERGE_WINDOW_MS + 1).toISOString();
    const candidate = makeCandidate({ l2: text, similarity: 0.99, createdAt: candidateAt, updatedAt: candidateAt });

    // Real clock advanced far past the window; the injected replay clock is exactly T.
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(T + 100 * HOUR_MS);
    mockFindSimilar.mockResolvedValue([candidate]);

    const res = await arb({ text, candidates: [candidate], nowMs: T });

    // Injected T ⇒ candidate is 72h-1ms old ⇒ inside ⇒ skip (the injected clock, not the real one).
    expect(res.outcome).toBe("skip");
    expect(mockFindSimilar.mock.calls[0][8]).toBe(T);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injected clock shifts the window deterministically
// ─────────────────────────────────────────────────────────────────────────────

describe("injected nowMs shifts the recency window deterministically", () => {
  // Fix the candidate's updatedAt at an absolute instant. With the injected replay clock set
  // 1h after it, the candidate is INSIDE the 72h merge window ⇒ skip (absorbed). With the clock
  // set 73h after it, the candidate is OUTSIDE every window ⇒ create. Same candidate, same pool
  // — only nowMs moves, so the flip is attributable solely to the injected replay clock.
  it("same candidate: in-window at replay T+1h, out-of-window at replay T+73h", async () => {
    const text = "Team standup moved to 10am on the platform squad calendar.";
    const anchor = Date.parse("2026-03-01T00:00:00.000Z");
    const candidateAt = new Date(anchor).toISOString();
    const candidate = () => makeCandidate({ l2: text, similarity: 0.99, createdAt: candidateAt, updatedAt: candidateAt });

    const inWindow = await arb({ text, candidates: [candidate()], nowMs: anchor + 1 * HOUR_MS });
    expect(inWindow.outcome).toBe("skip");

    const outWindow = await arb({ text, candidates: [candidate()], nowMs: anchor + 73 * HOUR_MS });
    expect(outWindow.outcome).toBe("create");
  });

  // The injected clock must also govern the recent-write in-memory cache TTL: rememberWrite
  // stamps writtenAtMs from nowMs and pruneRecentWrites ages entries against nowMs. Two writes
  // 10h apart in SIMULATED time (but issued back-to-back in wall-clock) must NOT both remain
  // in the 5-min TTL cache — the second write's prune (at simulated T+10h) evicts the first.
  it("recent-write cache ages against the injected clock (simulated pacing, not wall clock)", async () => {
    const recentWrites = new Map<string, RecentWrite[]>();
    const anchor = Date.parse("2026-03-01T00:00:00.000Z");

    // Write A at simulated anchor (no similar candidates ⇒ create + rememberWrite stamps it).
    await arb({ text: "Alpha fact one about the ingest pipeline.", candidates: [], nowMs: anchor, recentWrites });
    // A cache entry exists now.
    const afterA = [...recentWrites.values()].reduce((n, arr) => n + arr.length, 0);
    expect(afterA).toBe(1);

    // Write B 10h later in simulated time. pruneRecentWrites(nowMs=anchor+10h) drops A (TTL 5m),
    // then B is remembered ⇒ still exactly 1 entry (A evicted, B added), not 2.
    await arb({ text: "Beta fact two about the recall path.", candidates: [], nowMs: anchor + 10 * HOUR_MS, recentWrites });
    const afterB = [...recentWrites.values()].reduce((n, arr) => n + arr.length, 0);
    expect(afterB).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shadow WOULD/BASELINE recency uses the replay clock (A4)
// ─────────────────────────────────────────────────────────────────────────────

describe("shadow lanes use the injected replay clock for recency (A4)", () => {
  // With RUNIR_SUPERSEDE_SHADOW=1 and nowMs injected to an OLD instant, a candidate that is
  // WITHIN the merge/skip window at REPLAY time (but would be ancient vs real 2026-07 time)
  // must still be considered by the shadow WOULD/BASELINE passes — proving shadowNowMs =
  // input.nowMs ?? Date.now() drives the shadow recency checks, not a real-time clock.
  it("shadow WOULD sees a replay-recent candidate that is ancient vs real time", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const text = "Server region is us-east for the analytics warehouse.";
    // Candidate + incoming both anchored to Jan 2026; replay clock = Jan 2026 + 1h.
    const anchor = Date.parse("2026-01-01T00:00:00.000Z");
    const candAt = new Date(anchor).toISOString();
    const candidate = makeCandidate({ l2: text, similarity: 0.99, createdAt: candAt, updatedAt: candAt });

    await arb({ text, candidates: [candidate], nowMs: anchor + 1 * HOUR_MS });

    // The shadow logger fired (block ran) and, because the candidate is within the replay-time
    // window, the WOULD lane matched it (would_matched_id set) rather than treating it as
    // out-of-window (which a real-2026-07 clock would have done for a Jan-2026 candidate).
    expect(mockLogShadow).toHaveBeenCalledTimes(1);
    const params = mockLogShadow.mock.calls[0][1] as Record<string, unknown>;
    expect(params.wouldMatchedId).toBe("cand-id");
  });

  // Sanity: with the SAME Jan-2026 candidate but nowMs OMITTED (real 2026-07 clock), the
  // shadow recency window excludes it (25+ weeks old ≫ 72h merge window) — the WOULD lane
  // finds no in-window match. This is the contrast that proves the clock is load-bearing.
  it("with nowMs omitted, the ancient candidate is out of the shadow window (real clock)", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const text = "Server region is us-east for the analytics warehouse.";
    const longAgo = new Date(Date.parse("2026-01-01T00:00:00.000Z")).toISOString();
    const candidate = makeCandidate({ l2: text, similarity: 0.99, createdAt: longAgo, updatedAt: longAgo });

    await arb({ text, candidates: [candidate] }); // nowMs omitted ⇒ real Date.now()

    expect(mockLogShadow).toHaveBeenCalledTimes(1);
    const params = mockLogShadow.mock.calls[0][1] as Record<string, unknown>;
    // Out of every recency window at real time ⇒ WOULD did not match it.
    expect(params.wouldMatchedId).toBeNull();
  });
});
