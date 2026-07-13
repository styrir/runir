/**
 * Rúnir-h435.1 Unit B — B-3 lane isolation + scoped identity; B-4 deep snapshots.
 *
 * Mock surface: surreal-store DB boundaries + atomic-shadow-store writers (success).
 * resolveDecision / findSupersedeTarget / proveReferentIdentity REAL.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// F9: no dag-guard mock — supersedeMemory is stubbed so dag-guard never runs.
vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  logSupersedeShadow: vi.fn().mockResolvedValue(undefined),
  ensureSupersedeShadowTable: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class {
    query = vi.fn().mockResolvedValue([[]]);
  },
}));
vi.mock("../../surreal/atomic-shadow-store.js", () => ({
  createAtomicShadowAttempt: vi.fn().mockResolvedValue(undefined),
  createAtomicShadowEvent: vi.fn().mockResolvedValue(undefined),
  createAtomicShadowNomination: vi.fn().mockResolvedValue(undefined),
  finalizeAtomicShadowAttemptIfComplete: vi.fn().mockResolvedValue(true),
  ensureAtomicShadowTables: vi.fn().mockResolvedValue(undefined),
}));

import { arbitrateWrite } from "../write-arbitrator.js";
import {
  findSimilarMemories,
  logSupersedeShadow,
  supersedeMemory,
  upsertMemory,
} from "../../surreal/surreal-store.js";
import {
  createAtomicShadowEvent,
  createAtomicShadowAttempt,
} from "../../surreal/atomic-shadow-store.js";
import type { SimilarCandidate } from "../../../domain/memory/types.js";

const mockLog = logSupersedeShadow as Mock;
const mockEvent = createAtomicShadowEvent as Mock;
const mockAttempt = createAtomicShadowAttempt as Mock;

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(
  o: Partial<SimilarCandidate> & { l2: string; similarity: number },
): SimilarCandidate {
  const now = new Date().toISOString();
  return { id: "cand-1", createdAt: now, updatedAt: now, ...o };
}
function clearAllFlags() {
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  delete process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM;
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  delete process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF;
}

const ATOMIC_FACT_BASE = { subject: "Atlas datastore", predicate: "primary_engine" };
const ATOMIC_CAND_TEXT = "primary engine: SurrealDB for Atlas";
const ATOMIC_INC_TEXT = "primary engine: Dragonfly for Atlas";

beforeEach(() => {
  vi.clearAllMocks();
  clearAllFlags();
  process.env.RUNIR_SUPERSEDE_SHADOW = "1";
  mockLog.mockResolvedValue(undefined);
  mockEvent.mockResolvedValue(undefined);
  mockAttempt.mockResolvedValue(undefined);
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (upsertMemory as Mock).mockResolvedValue("new-id");
});
afterEach(() => clearAllFlags());

async function arb(opts: {
  text: string;
  candidates?: SimilarCandidate[];
  metadata?: Record<string, unknown>;
  nowMs?: number;
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
    recentWrites: new Map(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
}

describe("B-3 lane isolation + scoped identity", () => {
  it("B-3(i) no atomic-only involvement → applied factKey supersede unchanged; quarantine delta separate", async () => {
    // factKey-proven F1 still supersedes with identity flag OFF
    const candidate = makeCandidate({
      id: "fk",
      l2: "deploy target: staging cluster",
      similarity: 0.9,
      factKey: "config:deploy-target-abc123",
    });
    const r = await arb({
      text: "deploy target: production cluster",
      candidates: [candidate],
      metadata: { factKey: "config:deploy-target-abc123" },
    });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalledTimes(1);

    // Separate case: atomic-only quarantine honest delta (A-1(i) restated)
    vi.clearAllMocks();
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    mockLog.mockResolvedValue(undefined);
    mockEvent.mockResolvedValue(undefined);
    mockAttempt.mockResolvedValue(undefined);
    (upsertMemory as Mock).mockResolvedValue("new-id");
    const atomic = makeCandidate({
      id: "atomic-only",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const r2 = await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [atomic],
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(r2.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("B-3(ii)/(iii) WOULD keeps atomic proof; BASELINE unproven; write_event_id + live_flags additive", async () => {
    const atomic = makeCandidate({
      id: "atomic-only",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [atomic],
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(mockLog).toHaveBeenCalled();
    const call = mockLog.mock.calls[0][1] as any;
    expect(call.referentProof).toBe("key:atomicFactIdentity");
    expect(call.wouldOutcome).toBe("supersede");
    // BASELINE forces atomicAuthority false → unproven → not supersede
    expect(call.baselineOutcome).not.toBe("supersede");
    expect(call.liveFlags.atomicIdentityProof).toBe(false);
    expect(typeof call.writeEventId).toBe("string");
    expect(call.writeEventId.length).toBeGreaterThan(10);
  });

  it("B-3(iv) lane_clock_ms equals injected nowMs; recency boundary exactly AT window edge", async () => {
    const laneClockMs = Date.parse("2026-03-01T12:00:00.000Z");
    // F10/R4: fixture sits exactly AT the merge-window edge under the injected clock
    // (mergeWindowHours default 72): now - createdAt === 72h.
    // Applied path is candidate-dependent (merge-update on edge-cand; no correction
    // marker so unproven F1 falls through to merge). Isolated supersedes the same id.
    // A clock-divergent applied lane that rejects the edge candidate fails this test.
    const edgeCreated = new Date(laneClockMs - 72 * 3600 * 1000).toISOString();
    const atomic = makeCandidate({
      id: "edge-cand",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.88, // merge band (< skip 0.95)
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
      createdAt: edgeCreated,
      updatedAt: edgeCreated,
    });
    const r = await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [atomic],
      metadata: {
        // No "update" marker — keeps applied in merge-update (not F1 supersede).
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
      nowMs: laneClockMs,
    });
    // Applied lane engaged the edge candidate (candidate-dependent outcome).
    expect(r.outcome).toBe("merge-update");
    expect(r.matchedMemoryId).toBe("edge-cand");
    expect(r.mergedIntoId).toBe("edge-cand");
    // Safety activation → event packet with lane_clock_ms + dual-lane match.
    expect(mockEvent).toHaveBeenCalled();
    const ev = mockEvent.mock.calls[0][1] as any;
    expect(ev.laneClockMs).toBe(laneClockMs);
    expect(ev.laneClockMs).not.toBe(0);
    expect(ev.appliedOutcome).toBe("merge-update");
    expect(ev.appliedMatchedId).toBe("edge-cand");
    expect(ev.isolatedMatchedId).toBe("edge-cand");
  });

  it("B-3(iv) omitted nowMs: ONE captured clock (lane_clock_ms equals pre-call capture window)", async () => {
    // F10: single-clock when nowMs omitted — fake timers pin Date.now so view/lane/physical
    // prune share one instant (no second wall-clock drift).
    vi.useFakeTimers();
    const pinned = Date.parse("2026-04-01T15:30:00.000Z");
    vi.setSystemTime(pinned);
    try {
      const atomic = makeCandidate({
        id: "clock-cand",
        l2: ATOMIC_CAND_TEXT,
        similarity: 0.9,
        atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
        createdAt: new Date(pinned - 3600 * 1000).toISOString(),
        updatedAt: new Date(pinned - 3600 * 1000).toISOString(),
      });
      await arb({
        text: ATOMIC_INC_TEXT,
        candidates: [atomic],
        metadata: {
          tags: ["update"],
          atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
        },
        // nowMs intentionally omitted
      });
      expect(mockEvent).toHaveBeenCalled();
      const ev = mockEvent.mock.calls[0][1] as any;
      expect(ev.laneClockMs).toBe(pinned);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B-3(v) isolated judge outcome → isolated_outcome judge + isolated_unresolved judge_pending", async () => {
    // Dual fixture: higher-sim F2 escalates to judge (f2JudgeConfirm ON, no handle);
    // lower-sim atomic F1 still nominates so PIN-2 writes attempt/event (efficacy_only).
    // F2: isolated_outcome stays "judge"; isolated_unresolved is the discriminator.
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    const f2 = makeCandidate({
      id: "f2-cand",
      l2: "cache backend: redis for sessions",
      similarity: 0.95,
      tags: ["slot:cache", "subject:sessions"],
    });
    const f1 = makeCandidate({
      id: "f1-nom",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.88,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [f2, f1],
      metadata: {
        tags: ["slot:cache", "subject:sessions", "update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    // F10: REQUIRE attempt/event rows exist (fail, not skip when absent).
    expect(mockAttempt.mock.calls.length).toBeGreaterThan(0);
    expect(mockEvent.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockAttempt.mock.calls) {
      const p = call[1] as any;
      expect(p.activationClass).not.toBe("safety_activation");
    }
    const ev = mockEvent.mock.calls[0][1] as any;
    expect(ev.isolatedOutcome).toBe("judge");
    expect(ev.isolatedUnresolved).toBe("judge_pending");
  });

  it("F5: entry expiring between view-build and physical prune is retained consistently", async () => {
    // Capture-once prune clock on the OMITTED-nowMs path: advance wall time past the
    // entry's TTL during the awaited attempt-row write. View retained the entry at
    // T0; physical prune must reuse that same pruneNowMs (not a second Date.now()).
    // The old two-clock implementation would prune here and fail this assertion.
    const { getRecentWriteKey } = await import("../recent-writes.js");
    const { DEFAULT_ARBITRATION_CONFIG } = await import("../../../domain/memory/types.js");
    const userId = "u1";
    const scope = "user" as const;
    const key = getRecentWriteKey(userId, scope, undefined);
    const ttlMs = DEFAULT_ARBITRATION_CONFIG.recentWriteTtlMinutes * 60 * 1000;
    vi.useFakeTimers();
    const t0 = Date.parse("2026-05-01T10:00:00.000Z");
    vi.setSystemTime(t0);
    // Entry just inside the TTL at view-build; past TTL after we advance during attempt.
    const edgeEntry: import("../../../domain/memory/types.js").RecentWrite = {
      text: "recent near edge",
      normalizedText: "recent near edge",
      embedding: makeVec(3),
      userId,
      scope,
      source: "memory_store",
      writtenAtMs: t0 - ttlMs + 1,
    };
    const map = new Map([[key, [edgeEntry]]]);
    // PIN-2 safety activation so the attempt writer is awaited before physical prune.
    const atomic = makeCandidate({
      id: "prune-atomic",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    (findSimilarMemories as Mock).mockResolvedValue([atomic]);
    // Advance fake clock past the entry's TTL during the awaited attempt-row write,
    // then resolve — physical prune runs after this await with the capture-once clock.
    mockAttempt.mockImplementation(async () => {
      vi.advanceTimersByTime(ttlMs + 60_000);
    });
    const embedding = makeVec(0);
    try {
      await arbitrateWrite({
        db: makeDb(),
        text: ATOMIC_INC_TEXT,
        userId,
        embedding,
        scope,
        source: "memory_store",
        recentWrites: map,
        embedText: vi.fn().mockResolvedValue(embedding),
        metadata: {
          tags: ["update"],
          atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
        },
        // nowMs intentionally OMITTED — exercises prod Date.now() path.
      });
      // View retained the entry at T0; capture-once prune must keep it after return.
      expect(mockAttempt).toHaveBeenCalled();
      expect(map.get(key)?.some((e) => e.writtenAtMs === edgeEntry.writtenAtMs)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("B-4 deep decision-time snapshots", () => {
  it("B-4 deep copy: mutating nested atomicFact/tags after arbitration leaves captured snapshot unchanged", async () => {
    const atomicFact = { ...ATOMIC_FACT_BASE, value: "SurrealDB" };
    const tags = ["subject:atlas", "role:engine"];
    const candidate = makeCandidate({
      id: "snap-cand",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      atomicFact,
      tags,
      tier: "durable",
      validAt: "2026-01-15T00:00:00.000Z",
    });
    const incomingAf = { ...ATOMIC_FACT_BASE, value: "Dragonfly" };
    const incomingTags = ["update", "ephemeral-cue"];
    await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [candidate],
      metadata: {
        tags: incomingTags,
        atomicFact: incomingAf,
        tier: "ephemeral",
        validAt: "2026-02-01T00:00:00.000Z",
      },
    });
    expect(mockEvent).toHaveBeenCalled();
    const ev = mockEvent.mock.calls[0][1] as any;
    const incomingSnap = JSON.parse(ev.incomingSnapshotJson);
    const candSnap = ev.candidateSnapshotJson
      ? JSON.parse(ev.candidateSnapshotJson)
      : null;

    // Mutate nested source objects AFTER arbitration
    atomicFact.subject = "MUTATED_SUBJECT";
    (atomicFact as any).value = "MUTATED_VALUE";
    tags.push("MUTATED_TAG");
    incomingAf.subject = "MUTATED_INCOMING";
    incomingTags.push("MUTATED_IN_TAG");

    // Captured snapshots unchanged
    expect(incomingSnap.atomicFact.subject).toBe("Atlas datastore");
    expect(incomingSnap.atomicFact.value).toBe("Dragonfly");
    expect(incomingSnap.tags).not.toContain("MUTATED_IN_TAG");
    expect(incomingSnap.canonicalIdentity).toBeTruthy();
    expect(incomingSnap.tier).toBe("ephemeral");
    expect(incomingSnap.validAt).toBe("2026-02-01T00:00:00.000Z");
    // F10/B-4: candidate snapshot UNCONDITIONAL (F1 guard/supersede populates it).
    expect(candSnap).toBeTruthy();
    expect(candSnap.atomicFact.subject).toBe("Atlas datastore");
    expect(candSnap.atomicFact.value).toBe("SurrealDB");
    expect(candSnap.tags).not.toContain("MUTATED_TAG");
    expect(candSnap.referentKeys.atomicFactIdentity).toBeTruthy();
  });

  it("B-4 ephemeral incoming lacking text cues still snapshots tier/validAt/atomicFact", async () => {
    const candidate = makeCandidate({
      id: "eph",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    await arb({
      text: ATOMIC_INC_TEXT, // value change only — no currentness cue required for F1
      candidates: [candidate],
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
        tier: "ephemeral",
      },
    });
    expect(mockEvent).toHaveBeenCalled();
    const snap = JSON.parse((mockEvent.mock.calls[0][1] as any).incomingSnapshotJson);
    expect(snap.tier).toBe("ephemeral");
    expect(snap.atomicFact).toEqual({ ...ATOMIC_FACT_BASE, value: "Dragonfly" });
  });
});
