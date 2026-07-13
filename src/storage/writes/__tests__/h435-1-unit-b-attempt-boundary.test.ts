/**
 * Rúnir-h435.1 Unit B — B-1 attempt-row ordering + failure ladder.
 *
 * Mock surface (binding brief §Tests):
 * - DB-call boundaries of surreal-store via vi.mock
 * - atomic-shadow-store writers via vi.mock (failure injection (a))
 * - computeAtomicIsolatedEvaluation via vi.spyOn (failure injection (b) only)
 * Everything else REAL.
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
import * as atomicShadow from "../atomic-shadow.js";
import {
  findSimilarMemories,
  logSupersedeShadow,
  supersedeMemory,
  updateMemoryText,
  upsertMemory,
} from "../../surreal/surreal-store.js";
import { createAtomicShadowAttempt } from "../../surreal/atomic-shadow-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";
import { getRecentWriteKey } from "../recent-writes.js";

const mockAttempt = createAtomicShadowAttempt as Mock;
const mockLogShadow = logSupersedeShadow as Mock;

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

/** PIN-2 safety activation: flag OFF applied create; isolated (authority ON) supersedes. */
function safetyActivationCandidate() {
  return makeCandidate({
    id: "atomic-only-cand",
    l2: ATOMIC_CAND_TEXT,
    similarity: 0.9,
    atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAllFlags();
  process.env.RUNIR_SUPERSEDE_SHADOW = "1";
  mockAttempt.mockResolvedValue(undefined);
  mockLogShadow.mockResolvedValue(undefined);
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
  (upsertMemory as Mock).mockResolvedValue("new-id");
});
afterEach(() => {
  clearAllFlags();
  vi.restoreAllMocks();
});

describe("B-1 attempt-row ordering + failure ladder", () => {
  it("B-1(i) attempt CREATE awaited before applied side effects on create branch", async () => {
    const order: string[] = [];
    mockAttempt.mockImplementation(async () => {
      order.push("attempt");
    });
    (upsertMemory as Mock).mockImplementation(async () => {
      order.push("upsert");
      return "new-id";
    });
    (findSimilarMemories as Mock).mockResolvedValue([safetyActivationCandidate()]);
    const embedding = makeVec(0);
    await arbitrateWrite({
      db: makeDb(),
      text: ATOMIC_INC_TEXT,
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(order.indexOf("attempt")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("upsert")).toBeGreaterThan(order.indexOf("attempt"));
    expect(mockAttempt).toHaveBeenCalled();
    expect(mockAttempt.mock.calls[0][1].activationClass).toBe("safety_activation");
  });

  it("B-1(i) attempt before supersedeMemory when identity flag ON (supersede branch)", async () => {
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    const order: string[] = [];
    mockAttempt.mockImplementation(async () => {
      order.push("attempt");
    });
    (supersedeMemory as Mock).mockImplementation(async () => {
      order.push("supersede");
    });
    // Two atomic-proven candidates → multi-nomination; applied supersedes best.
    // Flag ON + multi nom ⇒ efficacy_only (or safety if outcomes diverge) — PIN-2 either way.
    const c1 = makeCandidate({
      id: "best",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.95,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const c2 = makeCandidate({
      id: "other",
      l2: "primary engine: RocksDB for Atlas",
      similarity: 0.88,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "RocksDB" },
    });
    (findSimilarMemories as Mock).mockResolvedValue([c1, c2]);
    const embedding = makeVec(0);
    const r = await arbitrateWrite({
      db: makeDb(),
      text: ATOMIC_INC_TEXT,
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    // Deterministic supersede branch under identity flag ON.
    expect(r.outcome).toBe("supersede");
    expect(mockAttempt).toHaveBeenCalled();
    expect(order).toContain("attempt");
    expect(order).toContain("supersede");
    // F10: UNCONDITIONAL attempt-before-side-effect ordering.
    expect(order.indexOf("attempt")).toBeLessThan(order.indexOf("supersede"));
  });

  it("B-1(i) PIN-2 skip branch: attempt CREATE before skip-side-effect (rememberWrite)", async () => {
    // Applied: store near-dup skip at cos>=0.95 after unproven F1 falls through.
    // Isolated (atomicAuthority ON): supersedes → safety activation (PIN-2).
    // R3: CALL ORDER via sequence log — not post-hoc map state (remember before
    // attempt would still leave the map non-empty after return).
    // Map subclass is instrumentation of the caller-owned recentWrites map (not a
    // module mock of rememberWrite / recent-writes) — allowed mock-surface rail.
    const order: string[] = [];
    mockAttempt.mockImplementation(async () => {
      order.push("attempt");
    });
    class OrderMap extends Map<string, RecentWrite[]> {
      override set(key: string, value: RecentWrite[]): this {
        order.push("remember");
        return super.set(key, value);
      }
    }
    const candidate = makeCandidate({
      id: "skip-atomic",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.96, // >= skipThreshold 0.95
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    (findSimilarMemories as Mock).mockResolvedValue([candidate]);
    const embedding = makeVec(0);
    const recentWrites = new OrderMap();
    const r = await arbitrateWrite({
      db: makeDb(),
      text: ATOMIC_INC_TEXT,
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(r.outcome).toBe("skip");
    expect(mockAttempt).toHaveBeenCalled();
    expect(mockAttempt.mock.calls[0][1].activationClass).toBe("safety_activation");
    // Call order: attempt first; rememberWrite's map.set strictly after.
    expect(order[0]).toBe("attempt");
    expect(order).toContain("remember");
    expect(order.indexOf("attempt")).toBeLessThan(order.indexOf("remember"));
  });

  it("B-1(i) PIN-2 merge-update branch: attempt CREATE before updateMemoryText", async () => {
    // Atomic F1 pair at merge-band sim (0.88, < skip 0.95): applied unproven → merge-update;
    // isolated (authority ON) supersedes → safety activation (PIN-2).
    // R3 residual: CALL ORDER via sequence log — attempt before BOTH updateMemoryText
    // and rememberWrite (map.set). Plain map + attempt→update only is false-green if
    // rememberWrite moves before the attempt row. Same instrumented Map-subclass
    // pattern as the skip-ordering case (caller-owned recentWrites instrumentation).
    const order: string[] = [];
    mockAttempt.mockImplementation(async () => {
      order.push("attempt");
    });
    (updateMemoryText as Mock).mockImplementation(async () => {
      order.push("update");
    });
    class OrderMap extends Map<string, RecentWrite[]> {
      override set(key: string, value: RecentWrite[]): this {
        order.push("remember");
        return super.set(key, value);
      }
    }
    const atomicCand = makeCandidate({
      id: "atomic-merge-pin2",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.88,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    (findSimilarMemories as Mock).mockResolvedValue([atomicCand]);
    const embedding = makeVec(0);
    const recentWrites = new OrderMap();
    const r = await arbitrateWrite({
      db: makeDb(),
      text: ATOMIC_INC_TEXT,
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        // No correction marker — marker would break out of merge band (w077).
        // F1 wouldSupersede is text-driven and still nominates for the isolated lane.
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(r.outcome).toBe("merge-update");
    expect(mockAttempt).toHaveBeenCalled();
    expect(mockAttempt.mock.calls[0][1].activationClass).toBe("safety_activation");
    // Call order: attempt first; updateMemoryText + rememberWrite strictly after.
    expect(order[0]).toBe("attempt");
    expect(order).toContain("update");
    expect(order).toContain("remember");
    expect(order.indexOf("attempt")).toBeLessThan(order.indexOf("update"));
    expect(order.indexOf("attempt")).toBeLessThan(order.indexOf("remember"));
  });

  it("F1: guard-kept-both applied create upsertMemory metadata carries NO supersedeSignal", async () => {
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({
      id: "durable-cand",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      tier: "durable",
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    (findSimilarMemories as Mock).mockResolvedValue([candidate]);
    const embedding = makeVec(0);
    const r = await arbitrateWrite({
      db: makeDb(),
      text: "primary engine: Dragonfly for Atlas for now",
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tier: "working",
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/durability guard/);
    expect(upsertMemory).toHaveBeenCalled();
    // upsertMemory(db, id, text, emb, userId, metadata, ...)
    const meta = (upsertMemory as Mock).mock.calls[0][5] as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta).not.toHaveProperty("supersedeSignal");
  });

  it("B-1(ii) rejected attempt-row create ⇒ arbitrateWrite rejects; no applied side effect", async () => {
    mockAttempt.mockRejectedValue(new Error("attempt write failed"));
    (findSimilarMemories as Mock).mockResolvedValue([safetyActivationCandidate()]);
    const embedding = makeVec(0);
    await expect(
      arbitrateWrite({
        db: makeDb(),
        text: ATOMIC_INC_TEXT,
        userId: "u1",
        embedding,
        scope: "user",
        source: "memory_store",
        recentWrites: new Map(),
        embedText: vi.fn().mockResolvedValue(embedding),
        metadata: {
          tags: ["update"],
          atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
        },
      }),
    ).rejects.toThrow(/attempt write failed/);
    expect(upsertMemory).not.toHaveBeenCalled();
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled();
  });

  it("B-1(iii) isolated computation throw → computation_failed attempt; dual failure throws", async () => {
    // (b) force computeAtomicIsolatedEvaluation to throw
    vi.spyOn(atomicShadow, "computeAtomicIsolatedEvaluation").mockImplementation(() => {
      throw new Error("isolated boom");
    });
    (findSimilarMemories as Mock).mockResolvedValue([safetyActivationCandidate()]);
    const embedding = makeVec(0);

    // First: attempt write succeeds → applied proceeds
    mockAttempt.mockResolvedValue(undefined);
    const r = await arbitrateWrite({
      db: makeDb(),
      text: ATOMIC_INC_TEXT,
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(mockAttempt).toHaveBeenCalled();
    expect(mockAttempt.mock.calls[0][1].activationClass).toBe("computation_failed");
    expect(mockAttempt.mock.calls[0][1].errorDetail).toMatch(/isolated boom/);
    expect(r.outcome).toBe("create"); // applied still runs
    expect(upsertMemory).toHaveBeenCalled();

    // Dual failure: attempt also rejects → throw, zero applied
    vi.clearAllMocks();
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    (findSimilarMemories as Mock).mockResolvedValue([safetyActivationCandidate()]);
    (upsertMemory as Mock).mockResolvedValue("new-id");
    mockAttempt.mockRejectedValue(new Error("failed-attempt also dead"));
    await expect(
      arbitrateWrite({
        db: makeDb(),
        text: ATOMIC_INC_TEXT,
        userId: "u1",
        embedding,
        scope: "user",
        source: "memory_store",
        recentWrites: new Map(),
        embedText: vi.fn().mockResolvedValue(embedding),
        metadata: {
          tags: ["update"],
          atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
        },
      }),
    ).rejects.toThrow(/failed-attempt also dead/);
    expect(upsertMemory).not.toHaveBeenCalled();

    // WOULD/BASELINE swallow unchanged: logSupersedeShadow rejection never affects applied
    vi.restoreAllMocks();
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    mockAttempt.mockResolvedValue(undefined);
    mockLogShadow.mockRejectedValue(new Error("shadow emit fail"));
    (findSimilarMemories as Mock).mockResolvedValue([safetyActivationCandidate()]);
    (upsertMemory as Mock).mockResolvedValue("new-id");
    const r2 = await arbitrateWrite({
      db: makeDb(),
      text: ATOMIC_INC_TEXT,
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(r2.outcome).toBe("create");
  });

  it("B-1(iv) stale-entry guard: expired recent-write entry untouched after failure paths", async () => {
    const userId = "u1";
    const scope = "user" as const;
    const key = getRecentWriteKey(userId, scope, undefined);
    const stale: RecentWrite = {
      text: "stale entry text",
      normalizedText: "stale entry text",
      embedding: makeVec(9),
      userId,
      scope,
      source: "memory_store",
      writtenAtMs: Date.now() - 60 * 60 * 1000, // 1h old; TTL is 5 min
    };
    const map = new Map<string, RecentWrite[]>([[key, [stale]]]);

    // Failure path (ii): attempt reject
    mockAttempt.mockRejectedValue(new Error("attempt fail"));
    (findSimilarMemories as Mock).mockResolvedValue([safetyActivationCandidate()]);
    const embedding = makeVec(0);
    await expect(
      arbitrateWrite({
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
      }),
    ).rejects.toThrow();
    expect(map.get(key)).toEqual([stale]); // untouched

    // Failure path (iii dual): computation throw + attempt reject
    vi.spyOn(atomicShadow, "computeAtomicIsolatedEvaluation").mockImplementation(() => {
      throw new Error("iso fail");
    });
    mockAttempt.mockRejectedValue(new Error("attempt fail 2"));
    await expect(
      arbitrateWrite({
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
      }),
    ).rejects.toThrow();
    expect(map.get(key)).toEqual([stale]);
  });

  it("B-1(v) non-PIN-2 event: no attempt row", async () => {
    // Exact-dup skip with no F1 nomination / no atomic involvement
    const now = new Date().toISOString();
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        id: "dup",
        l2: "exactly the same text body here",
        similarity: 0.99,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    const embedding = makeVec(0);
    const r = await arbitrateWrite({
      db: makeDb(),
      text: "exactly the same text body here",
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
    });
    expect(r.outcome).toBe("skip");
    expect(mockAttempt).not.toHaveBeenCalled();
  });
});
