/**
 * memory-clusterer.test.ts — Code-70u
 * Tests for memory clustering pipeline.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildEntityMap,
  jaccard,
  computeClusterFingerprint,
  reconcileWithExisting,
  upsertCluster,
} from "../lifecycle/compaction/memory-clusterer.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

function makeMockDb(queryImpl: (sql: string, vars?: any) => any[][]): SurrealClient {
  return { query: vi.fn(queryImpl) } as unknown as SurrealClient;
}

// ---------------------------------------------------------------------------
// buildEntityMap
// ---------------------------------------------------------------------------

describe("buildEntityMap", () => {
  it("returns correct {memoryId: Set<entityId>} shape", async () => {
    const rows = [
      { entityId: "entities:ent1", memoryId: "memories:mem1" },
      { entityId: "entities:ent2", memoryId: "memories:mem1" },
      { entityId: "entities:ent1", memoryId: "memories:mem2" },
    ];
    const db = makeMockDb(() => [rows]);
    const map = await buildEntityMap(db);

    expect(map.has("memories:mem1")).toBe(true);
    expect(map.get("memories:mem1")!.has("entities:ent1")).toBe(true);
    expect(map.get("memories:mem1")!.has("entities:ent2")).toBe(true);
    expect(map.has("memories:mem2")).toBe(true);
    expect(map.get("memories:mem2")!.has("entities:ent1")).toBe(true);
  });

  it("handles object IDs from SurrealDB", async () => {
    const rows = [
      { entityId: { id: "ent1" }, memoryId: { id: "mem1" } },
    ];
    const db = makeMockDb(() => [rows]);
    const map = await buildEntityMap(db);
    expect(map.has("mem1")).toBe(true);
  });

  it("returns empty map when no entity_edges", async () => {
    const db = makeMockDb(() => [[]]);
    const map = await buildEntityMap(db);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// jaccard
// ---------------------------------------------------------------------------

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["x", "y", "z"]);
    expect(jaccard(a, b)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["x", "y"]);
    const b = new Set(["p", "q"]);
    expect(jaccard(a, b)).toBe(0);
  });

  it("returns 1/3 for one shared element out of three union", () => {
    const a = new Set(["x", "y"]);
    const b = new Set(["y", "z"]);
    // intersection={y}(1), union={x,y,z}(3) -> 1/3
    expect(jaccard(a, b)).toBeCloseTo(1 / 3);
  });

  it("returns 0 for two empty sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it("returns correct value for known overlap", () => {
    // intersection={b,c}, union={a,b,c,d} → 2/4 = 0.5
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    expect(jaccard(a, b)).toBeCloseTo(2 / 4);
  });
});

// ---------------------------------------------------------------------------
// computeClusterFingerprint
// ---------------------------------------------------------------------------

describe("computeClusterFingerprint", () => {
  it("produces stable output for same sorted IDs", () => {
    const ids = ["memories:mem3", "memories:mem1", "memories:mem2"];
    const fp1 = computeClusterFingerprint(ids);
    const fp2 = computeClusterFingerprint(ids);
    expect(fp1).toBe(fp2);
  });

  it("is order-independent (same result regardless of input order)", () => {
    const a = computeClusterFingerprint(["mem3", "mem1", "mem2"]);
    const b = computeClusterFingerprint(["mem1", "mem2", "mem3"]);
    expect(a).toBe(b);
  });

  it("returns exactly 16 hex chars", () => {
    const fp = computeClusterFingerprint(["mem1", "mem2"]);
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different fingerprints for different sets", () => {
    const fp1 = computeClusterFingerprint(["mem1", "mem2"]);
    const fp2 = computeClusterFingerprint(["mem1", "mem3"]);
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// reconcileWithExisting
// ---------------------------------------------------------------------------

describe("reconcileWithExisting", () => {
  it("returns null when no existing clusters match", async () => {
    const db = makeMockDb(() => [[]]);
    const result = await reconcileWithExisting(db, ["mem1", "mem2"]);
    expect(result).toBeNull();
  });

  it("finds cluster with 50%+ overlap", async () => {
    const existingCluster = {
      id: "memory_clusters:cluster1",
      fingerprintId: "abc123",
      label: "test",
      memoryIds: ["mem1", "mem2", "mem3", "mem4"],
      entityIds: [],
      size: 4,
      method: "entity_cooccurrence",
    };
    const db = makeMockDb(() => [[existingCluster]]);
    // candidate has 3/4 of existing cluster's members -> 75% overlap from candidate perspective
    const result = await reconcileWithExisting(db, ["mem1", "mem2", "mem3"]);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("memory_clusters:cluster1");
  });

  it("returns null when overlap is below 50%", async () => {
    const existingCluster = {
      id: "memory_clusters:cluster1",
      fingerprintId: "abc123",
      label: "test",
      memoryIds: ["memA", "memB", "memC", "memD"],
      entityIds: [],
      size: 4,
      method: "entity_cooccurrence",
    };
    const db = makeMockDb(() => [[existingCluster]]);
    // only 1 of 4 candidate IDs overlaps -> 25% overlap
    const result = await reconcileWithExisting(db, ["memA", "memX", "memY", "memZ"]);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsertCluster
// ---------------------------------------------------------------------------

describe("upsertCluster", () => {
  it("inserts new cluster when no existing match", async () => {
    const queryFn = vi.fn((sql: string) => {
      if (sql.includes("CONTAINSANY")) return [[]]; // no existing
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const cluster = {
      fingerprintId: "fp123",
      label: "Test Cluster",
      memoryIds: ["mem1", "mem2", "mem3"],
      entityIds: ["ent1"],
      size: 3,
      method: "entity_cooccurrence" as const,
    };

    const result = await upsertCluster(db, cluster);
    expect(result.action).toBe("inserted");

    const calls = queryFn.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((sql: string) => sql.includes("CREATE"))).toBe(true);
  });

  it("updates existing cluster on second call", async () => {
    const existingCluster = {
      id: "memory_clusters:existing1",
      fingerprintId: "fp_original",
      label: "Original",
      memoryIds: ["mem1", "mem2"],
      entityIds: ["ent1"],
      size: 2,
      method: "entity_cooccurrence",
    };

    const queryFn = vi.fn((sql: string) => {
      if (sql.includes("CONTAINSANY")) return [[existingCluster]];
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const cluster = {
      fingerprintId: "fp_new",
      label: "Updated",
      memoryIds: ["mem1", "mem2", "mem3"],
      entityIds: ["ent1", "ent2"],
      size: 3,
      method: "entity_cooccurrence" as const,
    };

    const result = await upsertCluster(db, cluster);
    expect(result.action).toBe("upserted");

    const calls = queryFn.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((sql: string) => sql.includes("UPDATE"))).toBe(true);
  });

  it("preserves original fingerprintId on update", async () => {
    const existingCluster = {
      id: "memory_clusters:existing1",
      fingerprintId: "original_fp",
      label: "Original",
      memoryIds: ["mem1", "mem2"],
      entityIds: [],
      size: 2,
      method: "entity_cooccurrence",
    };

    const queryFn = vi.fn((sql: string) => {
      if (sql.includes("CONTAINSANY")) return [[existingCluster]];
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const cluster = {
      fingerprintId: "new_different_fp",
      label: "New",
      memoryIds: ["mem1", "mem2", "mem3"],
      entityIds: [],
      size: 3,
      method: "entity_cooccurrence" as const,
    };

    await upsertCluster(db, cluster);

    // The UPDATE call should use the existing cluster's ID, not set a new fingerprintId
    const calls = queryFn.mock.calls;
    const updateCall = calls.find((c: any[]) => (c[0] as string).includes("UPDATE"));
    expect(updateCall).toBeDefined();
    // Should NOT include fingerprintId in SET clause
    expect(updateCall![0]).not.toContain("fingerprintId");
  });
});
