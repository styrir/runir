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
import { createOverlayRegistry, type OverlayRegistry, type OverlayStore } from "../../overlay/overlay-store.js";
import type { OverlayLockKey } from "../overlay-supersession.js";
import type { OverlayHandle } from "../write-arbitrator.js";
import { arbitrateWrite } from "../write-arbitrator.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

const FIXED_NOW_MS = 1_700_000_000_000;

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as unknown as Parameters<typeof arbitrateWrite>[0]["db"];
}

function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

function makeOverlayHandle(): { handle: OverlayHandle; registry: OverlayRegistry; spies: { put: Mock; delete: Mock } } {
  const registry = createOverlayRegistry({
    perTenantCap: 256,
    ttlMs: 120_000,
    globalAggregateCap: 5_000,
    now: () => FIXED_NOW_MS,
  });
  const realForUser = registry.forUser.bind(registry);
  const calls: { put: Mock; delete: Mock } = {
    put: vi.fn(),
    delete: vi.fn(),
  };
  // Wrap forUser so we can spy on the per-tenant store's put/delete invocations.
  registry.forUser = (userId: string): OverlayStore => {
    const store = realForUser(userId);
    return new Proxy(store, {
      get(target: OverlayStore, prop: keyof OverlayStore) {
        if (prop === "put") {
          return (lockKey: OverlayLockKey, entry: Parameters<OverlayStore["put"]>[1]) => {
            calls.put(userId, lockKey, entry);
            target.put(lockKey, entry);
          };
        }
        if (prop === "delete") {
          return (lockKey: OverlayLockKey) => {
            calls.delete(userId, lockKey);
            return target.delete(lockKey);
          };
        }
        return Reflect.get(target, prop);
      },
    });
  };
  return {
    handle: { registry, ttlMs: 120_000, now: () => FIXED_NOW_MS },
    registry,
    spies: calls,
  };
}

describe("arbitrateWrite — overlay outcome wiring (Rúnir-yod0.3.13)", () => {
  beforeEach(() => {
  process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1"; // Rúnir-h435.1 [R1-1]
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (updateMemoryText as Mock).mockResolvedValue(undefined);
    (upsertMemory as Mock).mockResolvedValue("new-id");
    (supersedeMemory as Mock).mockResolvedValue(undefined);
  });

  it("created → registry.forUser(userId).put", async () => {
    const { handle, spies } = makeOverlayHandle();
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
    expect(spies.put).toHaveBeenCalledTimes(1);
    expect(spies.delete).not.toHaveBeenCalled();
    const [userId, lockKey, entry] = spies.put.mock.calls[0];
    expect(userId).toBe("user-a");
    expect(lockKey).toEqual({ factKey: "preference:indentation", continuitySubjectKey: "user:user-a" });
    expect(entry.outcome).toBe("create");
    expect(entry.memoryId).toBe(result.memoryId);
    expect(entry.text).toBe("user prefers tabs over spaces");
    expect(entry.userId).toBe("user-a");
    expect(entry.committedAtMs).toBe(FIXED_NOW_MS);
    expect(entry.expiresAtMs).toBe(FIXED_NOW_MS + 120_000);
  });

  it("merge-update → put overwrites prior overlay entry on the same lock key", async () => {
    const { handle, registry, spies } = makeOverlayHandle();
    const recentWrites = new Map<string, RecentWrite[]>();
    const lockKey: OverlayLockKey = {
      factKey: "preference:indentation",
      continuitySubjectKey: "user:user-a",
    };

    // Seed an existing memory at the locked key, both in similar-candidates and overlay.
    const existing: SimilarCandidate = {
      id: "existing-id",
      l2: "user prefers tabs",
      similarity: 0.91,
      createdAt: new Date().toISOString(),
      continuitySubjectKey: "user:user-a",
    };
    (findSimilarMemories as Mock).mockResolvedValue([existing]);
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
    spies.put.mockClear();

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
    expect(spies.put).toHaveBeenCalledTimes(1);
    expect(spies.delete).not.toHaveBeenCalled();
    const [, putLockKey, entry] = spies.put.mock.calls[0];
    expect(putLockKey).toEqual(lockKey);
    expect(entry.outcome).toBe("merge-update");
    expect(entry.memoryId).toBe("existing-id");
    // Underlying overlay state reflects the overwrite.
    const overlayState = registry.forUser("user-a").get(lockKey);
    expect(overlayState?.outcome).toBe("merge-update");
    expect(overlayState?.text).toContain("width 4");
  });

  it("supersede → delete(prior) then put(new)", async () => {
    const { handle, registry, spies } = makeOverlayHandle();
    const recentWrites = new Map<string, RecentWrite[]>();
    const lockKey: OverlayLockKey = {
      factKey: "project:auth-token-ttl",
      continuitySubjectKey: "project:auth-service",
    };

    // Seed a similar candidate that triggers the supersede branch (cosine high
    // enough to skip-or-merge, text different enough to flip to supersede).
    // Rúnir-pn1l.13.4 (U5): F1 is nominate-only — the same-key value change retires the
    // candidate only with a proven referent identity. In production a same-subject value
    // correction carries a shared atomicFact {subject, predicate} (subject-stable across the
    // value), proving via key:atomicFactIdentity. (factKey is value-varying and would NOT
    // match across the value change, so it is deliberately NOT used as the proof here.)
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

    // Seed prior overlay entry under the same lock key.
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
    spies.put.mockClear();
    spies.delete.mockClear();

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
    expect(spies.delete).toHaveBeenCalledTimes(1);
    expect(spies.put).toHaveBeenCalledTimes(1);
    // Order: delete BEFORE put, both on the same lock key.
    const deleteOrder = spies.delete.mock.invocationCallOrder[0];
    const putOrder = spies.put.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(putOrder);
    expect(spies.delete.mock.calls[0][1]).toEqual(lockKey);
    expect(spies.put.mock.calls[0][1]).toEqual(lockKey);
    const entry = spies.put.mock.calls[0][2];
    expect(entry.outcome).toBe("supersede");
    expect(entry.memoryId).toBe(result.memoryId);
    expect(entry.memoryId).not.toBe("old-id");
  });

  it("noop / skip → no overlay mutation", async () => {
    const { handle, spies } = makeOverlayHandle();
    const recentWrites = new Map<string, RecentWrite[]>();
    const text = "user prefers tabs over spaces";
    const embedding = makeVec(0);
    const metadata = {
      factKey: "preference:indentation",
      continuitySubjectKey: "user:user-a",
    };

    // Prime the in-memory recent-write cache so the second call hits the
    // skip path on the exact-duplicate branch.
    await arbitrateWrite({
      db: makeDb(),
      text,
      userId: "user-a",
      embedding,
      metadata,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      overlay: handle,
    });
    expect(spies.put).toHaveBeenCalledTimes(1);
    expect(spies.delete).not.toHaveBeenCalled();
    spies.put.mockClear();
    spies.delete.mockClear();

    const result = await arbitrateWrite({
      db: makeDb(),
      text,
      userId: "user-a",
      embedding,
      metadata,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      overlay: handle,
    });

    expect(result.outcome).toBe("skip");
    expect(spies.put).not.toHaveBeenCalled();
    expect(spies.delete).not.toHaveBeenCalled();
  });

  it("missing factKey or continuitySubjectKey in metadata → overlay is bypassed (lock-key disengaged)", async () => {
    const { handle, spies } = makeOverlayHandle();
    const recentWrites = new Map<string, RecentWrite[]>();

    const result = await arbitrateWrite({
      db: makeDb(),
      text: "ambient note",
      userId: "user-a",
      embedding: makeVec(1),
      // metadata with one nullable key
      metadata: { factKey: "fact:ambient", continuitySubjectKey: "" },
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(makeVec(1)),
      overlay: handle,
    });

    expect(result.outcome).toBe("create");
    expect(spies.put).not.toHaveBeenCalled();
    expect(spies.delete).not.toHaveBeenCalled();
  });
});
