/**
 * `memory_indexed` async-emit wiring — Rúnir-yod0.3.21.
 *
 * Asserts that `arbitrateWrite` emits a `memory_indexed` trace event
 * alongside `memory_committed` on every branch (create, merge-update,
 * supersede), and that under a synthetic write workload the drift
 * contract (`committedCount >= indexedCount`) holds.
 *
 * In today's codebase SurrealDB upserts maintain vector + FTS indexes
 * synchronously within the same transaction, so the two events co-fire
 * and the drift is trivially zero. The seam stays in place so a future
 * async-index topology can fire `memory_indexed` from a separate
 * visibility hook without touching call-sites that consume the trace
 * surface. ADR 0009 §Phantom-prevention rules row 2 documents the drift
 * detector contract.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class {
    query = vi.fn().mockResolvedValue([[]]);
  },
}));

import {
  findSimilarMemories,
  supersedeMemory,
  updateMemoryText,
  upsertMemory,
} from "../../surreal/surreal-store.js";
import {
  createOverlayRegistry,
  type OverlayRegistry,
} from "../../overlay/overlay-store.js";
import type { OverlayLockKey } from "../overlay-supersession.js";
import type { OverlayHandle } from "../write-arbitrator.js";
import { arbitrateWrite } from "../write-arbitrator.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";
import type {
  TraceLifecycleEvent,
} from "../../../recall/selection/retrieval-trace.js";
import { committedIndexedDrift } from "../../../obs/counters.js";

const FIXED_NOW_MS = 1_700_000_000_000;

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as unknown as Parameters<
    typeof arbitrateWrite
  >[0]["db"];
}

function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

interface TraceCapture {
  events: TraceLifecycleEvent[];
  registry: OverlayRegistry;
  handle: OverlayHandle;
}

function makeTraceCapture(): TraceCapture {
  const events: TraceLifecycleEvent[] = [];
  const registry = createOverlayRegistry({
    perTenantCap: 256,
    ttlMs: 120_000,
    globalAggregateCap: 5_000,
    now: () => FIXED_NOW_MS,
  });
  const handle: OverlayHandle = {
    registry,
    ttlMs: 120_000,
    now: () => FIXED_NOW_MS,
    traceEmit: (event) => {
      events.push(event);
    },
  };
  return { events, registry, handle };
}

beforeEach(() => {
  process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1"; // Rúnir-h435.1 [R1-1]
  vi.clearAllMocks();
  (findSimilarMemories as Mock).mockResolvedValue([]);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
  (upsertMemory as Mock).mockResolvedValue(undefined);
  (supersedeMemory as Mock).mockResolvedValue(undefined);
});

describe("arbitrateWrite — memory_indexed async-emit (Rúnir-yod0.3.21)", () => {
  it("create branch emits memory_committed AND memory_indexed for the same memoryId", async () => {
    const { events, handle } = makeTraceCapture();
    const recentWrites = new Map<string, RecentWrite[]>();

    const result = await arbitrateWrite({
      db: makeDb(),
      text: "user prefers tabs over spaces",
      userId: "user-a",
      embedding: makeVec(0),
      metadata: {
        factKey: "preference:indentation",
        continuitySubjectKey: "user:user-a",
      },
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(makeVec(0)),
      overlay: handle,
    });

    expect(result.outcome).toBe("create");
    const committed = events.filter((e) => e.type === "memory_committed");
    const indexed = events.filter((e) => e.type === "memory_indexed");
    expect(committed).toHaveLength(1);
    expect(indexed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      type: "memory_committed",
      memoryId: result.memoryId,
      outcome: "create",
    });
    expect(indexed[0]).toMatchObject({
      type: "memory_indexed",
      memoryId: result.memoryId,
    });
  });

  it("merge-update branch emits memory_committed AND memory_indexed", async () => {
    const { events, handle, registry } = makeTraceCapture();
    const recentWrites = new Map<string, RecentWrite[]>();
    const lockKey: OverlayLockKey = {
      factKey: "preference:indentation",
      continuitySubjectKey: "user:user-a",
    };
    registry.forUser("user-a").put(lockKey, {
      memoryId: "existing-id",
      text: "user prefers tabs",
      lockKey,
      userId: "user-a",
      score: 1,
      committedAtMs: FIXED_NOW_MS - 1_000,
      expiresAtMs: FIXED_NOW_MS + 60_000,
      lastAccessedAtMs: FIXED_NOW_MS - 1_000,
      active: true,
      outcome: "create",
    });
    const existing: SimilarCandidate = {
      id: "existing-id",
      l2: "user prefers tabs",
      similarity: 0.91,
      createdAt: new Date().toISOString(),
      continuitySubjectKey: "user:user-a",
    };
    (findSimilarMemories as Mock).mockResolvedValue([existing]);

    const result = await arbitrateWrite({
      db: makeDb(),
      text: "user prefers tabs over spaces with width 4",
      userId: "user-a",
      embedding: makeVec(0),
      metadata: { factKey: lockKey.factKey, continuitySubjectKey: lockKey.continuitySubjectKey },
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(makeVec(0)),
      overlay: handle,
    });

    expect(result.outcome).toBe("merge-update");
    expect(events.filter((e) => e.type === "memory_committed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "memory_indexed")).toHaveLength(1);
  });

  it("supersede branch emits memory_committed AND memory_indexed for the new memoryId", async () => {
    const { events, handle, registry } = makeTraceCapture();
    const recentWrites = new Map<string, RecentWrite[]>();
    const lockKey: OverlayLockKey = {
      factKey: "config:auth-token-ttl",
      continuitySubjectKey: "project:auth-service",
    };
    // Rúnir-pn1l.13.4 (U5): F1 is nominate-only — retirement needs a proven referent
    // identity. A same-subject value correction carries a shared atomicFact {subject,
    // predicate} (subject-stable across the value), proving via key:atomicFactIdentity.
    const jwtFact = { subject: "JWT_EXPIRY", predicate: "=" };
    const conflicting: SimilarCandidate = {
      id: "old-id",
      l2: "JWT_EXPIRY: 3600",
      similarity: 0.92,
      createdAt: new Date().toISOString(),
      continuitySubjectKey: "project:auth-service",
      atomicFact: { ...jwtFact, value: "3600" },
    };
    (findSimilarMemories as Mock).mockResolvedValue([conflicting]);
    registry.forUser("user-a").put(lockKey, {
      memoryId: "old-id",
      text: "JWT_EXPIRY: 3600",
      lockKey,
      userId: "user-a",
      score: 1,
      committedAtMs: FIXED_NOW_MS - 1_000,
      expiresAtMs: FIXED_NOW_MS + 60_000,
      lastAccessedAtMs: FIXED_NOW_MS - 1_000,
      active: true,
      outcome: "create",
    });

    const result = await arbitrateWrite({
      db: makeDb(),
      text: "JWT_EXPIRY: 900",
      userId: "user-a",
      embedding: makeVec(0),
      metadata: {
        factKey: lockKey.factKey,
        continuitySubjectKey: lockKey.continuitySubjectKey,
        atomicFact: { ...jwtFact, value: "900" },
      },
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(makeVec(0)),
      overlay: handle,
    });

    expect(result.outcome).toBe("supersede");
    const committed = events.filter((e) => e.type === "memory_committed");
    const indexed = events.filter((e) => e.type === "memory_indexed");
    expect(committed).toHaveLength(1);
    expect(indexed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ memoryId: result.memoryId });
    expect(indexed[0]).toMatchObject({ memoryId: result.memoryId });
  });

  it("drift contract: committedCount >= indexedCount under synthetic write workload", async () => {
    const { events, handle } = makeTraceCapture();
    const recentWrites = new Map<string, RecentWrite[]>();

    // Drive 10 distinct create-branch writes through arbitrateWrite. Each
    // non-skip outcome produces one committed and one indexed event from
    // the same call site. The drift contract MUST hold at every prefix of
    // the event stream regardless of how many writes pass the dedup gate.
    let nonSkipOutcomes = 0;
    for (let i = 0; i < 10; i++) {
      const text = `decision-${i}: project uses approach-${i}`;
      // Embedding dim must exceed the loop count so cosine similarity
      // doesn't accidentally cycle into a dedup-skip; use len=16 here.
      const embedding = makeVec(i, 16);
      const result = await arbitrateWrite({
        db: makeDb(),
        text,
        userId: "user-drift",
        embedding,
        metadata: {
          factKey: `decision:approach-${i}`,
          continuitySubjectKey: "user:user-drift",
        },
        scope: "user",
        source: "memory_store",
        recentWrites,
        embedText: vi.fn().mockResolvedValue(embedding),
        overlay: handle,
      });
      if (result.outcome !== "skip") nonSkipOutcomes++;
    }

    let committed = 0;
    let indexed = 0;
    for (const event of events) {
      if (event.type === "memory_committed") committed++;
      else if (event.type === "memory_indexed") indexed++;
      const drift = committedIndexedDrift({
        committedCount: committed,
        indexedCount: indexed,
      });
      expect(drift.contractHolds).toBe(true);
    }

    // Each non-skip outcome emits exactly one committed + one indexed
    // event; the two counters end equal regardless of how many writes
    // landed.
    expect(committed).toBe(nonSkipOutcomes);
    expect(indexed).toBe(nonSkipOutcomes);
    expect(nonSkipOutcomes).toBeGreaterThan(0);
    const final = committedIndexedDrift({
      committedCount: committed,
      indexedCount: indexed,
    });
    expect(final.ratio).toBe(0);
    expect(final.breach).toBe(false);
    expect(final.contractHolds).toBe(true);
  });
});
