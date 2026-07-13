import { describe, it, expect, vi } from "vitest";
import {
  buildCooccurrenceGraph,
  buildEntityMap,
  collectOrphanMemories,
  computeClusterFingerprint,
  cosineFallbackClusters,
  findClusters,
  jaccard,
  reconcileWithExisting,
  upsertCluster,
} from "../memory-clusterer.js";

describe("jaccard", () => {
  it("returns 0 for two empty sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it("returns 1 for identical singletons", () => {
    expect(jaccard(new Set(["a"]), new Set(["a"]))).toBe(1);
  });

  it("returns 1 for identical multi-element sets", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["a", "b", "c"]))).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 10);
  });

  it("is symmetric", () => {
    const left = new Set(["a", "b", "c"]);
    const right = new Set(["b", "c", "d", "e"]);
    expect(jaccard(left, right)).toBeCloseTo(jaccard(right, left), 10);
  });
});

describe("computeClusterFingerprint", () => {
  it("is deterministic regardless of input order", () => {
    expect(computeClusterFingerprint(["a", "b", "c"])).toBe(
      computeClusterFingerprint(["c", "b", "a"]),
    );
  });

  it("returns a 16-character hex string", () => {
    const fp = computeClusterFingerprint(["mem:1", "mem:2"]);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different hashes for different inputs", () => {
    expect(computeClusterFingerprint(["a"])).not.toBe(
      computeClusterFingerprint(["b"]),
    );
    expect(computeClusterFingerprint(["a", "b"])).not.toBe(
      computeClusterFingerprint(["a", "b", "c"]),
    );
  });
});

describe("buildCooccurrenceGraph", () => {
  it("builds edges between memories that share entities", () => {
    const map = new Map<string, Set<string>>([
      ["m1", new Set(["e1", "e2"])],
      ["m2", new Set(["e2", "e3"])],
      ["m3", new Set(["e9"])],
    ]);
    const graph = buildCooccurrenceGraph(map);
    expect(graph.get("m1")?.get("m2")).toBeCloseTo(1 / 3, 10);
    expect(graph.get("m2")?.get("m1")).toBeCloseTo(1 / 3, 10);
    expect(graph.has("m3")).toBe(false);
  });

  it("returns an empty graph when no memories share entities", () => {
    const map = new Map<string, Set<string>>([
      ["m1", new Set(["e1"])],
      ["m2", new Set(["e2"])],
    ]);
    const graph = buildCooccurrenceGraph(map);
    expect(graph.size).toBe(0);
  });

  it("returns an empty graph for an empty entity map", () => {
    expect(buildCooccurrenceGraph(new Map()).size).toBe(0);
  });
});

describe("findClusters", () => {
  it("returns no clusters when shared-entity count is below threshold", () => {
    const map = new Map<string, Set<string>>([
      ["m1", new Set(["e1"])],
      ["m2", new Set(["e1"])],
    ]);
    const clusters = findClusters(map, 0.1, 2);
    expect(clusters).toHaveLength(0);
  });

  it("clusters memories that share many entities", () => {
    const map = new Map<string, Set<string>>([
      ["m1", new Set(["e1", "e2", "e3"])],
      ["m2", new Set(["e1", "e2", "e3"])],
      ["m3", new Set(["e9"])],
    ]);
    const clusters = findClusters(map, 0.3, 2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.method).toBe("entity_cooccurrence");
    expect([...clusters[0]!.memoryIds].sort()).toEqual(["m1", "m2"]);
  });

  it("merges transitive clusters via union-find", () => {
    const map = new Map<string, Set<string>>([
      ["m1", new Set(["e1", "e2", "e3"])],
      ["m2", new Set(["e1", "e2", "e3"])],
      ["m3", new Set(["e2", "e3", "e4"])],
    ]);
    const clusters = findClusters(map, 0.3, 2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memoryIds.length).toBe(3);
  });

  it("populates label and fingerprintId on clusters", () => {
    const map = new Map<string, Set<string>>([
      ["m1", new Set(["e1", "e2", "e3", "e4"])],
      ["m2", new Set(["e1", "e2", "e3", "e4"])],
    ]);
    const clusters = findClusters(map, 0.3, 2);
    expect(clusters[0]!.label.length).toBeGreaterThan(0);
    expect(clusters[0]!.fingerprintId).toMatch(/^[0-9a-f]{16}$/);
    expect(clusters[0]!.entityIds.length).toBe(4);
    expect(clusters[0]!.size).toBe(2);
  });

  it("excludes singletons (memories not paired into clusters)", () => {
    const map = new Map<string, Set<string>>([
      ["m1", new Set(["e1", "e2"])],
      ["m2", new Set(["e1", "e2"])],
      ["lonely", new Set(["x"])],
    ]);
    const clusters = findClusters(map, 0.3, 2);
    for (const c of clusters) {
      expect(c.memoryIds).not.toContain("lonely");
    }
  });
});

describe("buildEntityMap", () => {
  it("aggregates entity -> memory mentions from entity_edges", async () => {
    const db = {
      query: vi.fn(async () => [[
        { entityId: "e1", memoryId: "m1" },
        { entityId: "e2", memoryId: "m1" },
        { entityId: "e1", memoryId: "m2" },
      ]]),
    } as unknown as never;
    const map = await buildEntityMap(db);
    expect(map.get("m1")?.has("e1")).toBe(true);
    expect(map.get("m1")?.has("e2")).toBe(true);
    expect(map.get("m2")?.has("e1")).toBe(true);
  });

  it("normalizes RecordId-shaped ids and skips rows missing ids", async () => {
    const db = {
      query: vi.fn(async () => [[
        { entityId: { id: "e1" }, memoryId: { id: "m1" } },
        { entityId: null, memoryId: "m2" },
        { entityId: "e3", memoryId: null },
      ]]),
    } as unknown as never;
    const map = await buildEntityMap(db);
    expect(map.get("m1")?.has("e1")).toBe(true);
    expect(map.size).toBe(1);
  });

  it("returns an empty map when entity_edges has no rows", async () => {
    const db = { query: vi.fn(async () => [[]]) } as unknown as never;
    const map = await buildEntityMap(db);
    expect(map.size).toBe(0);
  });
});

describe("cosineFallbackClusters", () => {
  it("returns an empty array when there are no orphans", async () => {
    const db = { query: vi.fn() } as unknown as never;
    const clusters = await cosineFallbackClusters(db, [], new Map(), 0.8);
    expect(clusters).toEqual([]);
  });

  it("clusters orphan memories with similar embeddings and one shared entity", async () => {
    const db = {
      query: vi.fn(async () => [[
        { id: "m1", embedding: [1, 0, 0] },
        { id: "m2", embedding: [1, 0.01, 0] },
      ]]),
    } as unknown as never;
    const entityMap = new Map<string, Set<string>>([
      ["m1", new Set(["e1"])],
      ["m2", new Set(["e1"])],
    ]);
    const clusters = await cosineFallbackClusters(db, ["m1", "m2"], entityMap, 0.5);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.method).toBe("cosine_fallback");
    expect(clusters[0]!.memoryIds.sort()).toEqual(["m1", "m2"]);
  });

  it("does not cluster pairs that lack a shared entity", async () => {
    const db = {
      query: vi.fn(async () => [[
        { id: "m1", embedding: [1, 0, 0] },
        { id: "m2", embedding: [1, 0, 0] },
      ]]),
    } as unknown as never;
    const entityMap = new Map<string, Set<string>>([
      ["m1", new Set(["e1"])],
      ["m2", new Set(["e2"])],
    ]);
    const clusters = await cosineFallbackClusters(db, ["m1", "m2"], entityMap, 0.5);
    expect(clusters).toHaveLength(0);
  });

  it("filters out rows with empty embeddings", async () => {
    const db = {
      query: vi.fn(async () => [[
        { id: "m1", embedding: [] },
        { id: "m2", embedding: [1, 0] },
      ]]),
    } as unknown as never;
    const clusters = await cosineFallbackClusters(db, ["m1", "m2"], new Map(), 0.5);
    expect(clusters).toHaveLength(0);
  });
});

describe("reconcileWithExisting", () => {
  it("returns null when no existing cluster contains any candidate id", async () => {
    const db = { query: vi.fn(async () => [[]]) } as unknown as never;
    expect(await reconcileWithExisting(db, ["m1", "m2"])).toBeNull();
  });

  it("returns the highest-overlap cluster above the 50% threshold", async () => {
    const db = {
      query: vi.fn(async () => [[
        { id: "memory_clusters:a", memoryIds: ["m1", "m2"], entityIds: [] },
        { id: "memory_clusters:b", memoryIds: ["m2"], entityIds: [] },
      ]]),
    } as unknown as never;
    const best = await reconcileWithExisting(db, ["m1", "m2"]);
    expect(best?.id).toBe("memory_clusters:a");
  });

  it("returns null when no existing cluster meets the 50% overlap threshold", async () => {
    const db = {
      query: vi.fn(async () => [[
        { id: "memory_clusters:a", memoryIds: ["x"], entityIds: [] },
      ]]),
    } as unknown as never;
    const best = await reconcileWithExisting(db, ["m1", "m2", "m3", "m4", "m5"]);
    expect(best).toBeNull();
  });
});

describe("upsertCluster", () => {
  it("updates existing cluster when reconciliation matches", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("SELECT * FROM memory_clusters")) {
          return [[{ id: "memory_clusters:a", memoryIds: ["m1"], entityIds: ["e1"], label: "L", method: "entity_cooccurrence" }]];
        }
        return [];
      }),
    } as unknown as never;
    const result = await upsertCluster(db, {
      fingerprintId: "fp",
      label: "new",
      memoryIds: ["m1", "m2"],
      entityIds: ["e1", "e2"],
      size: 2,
      method: "entity_cooccurrence",
    });
    expect(result.action).toBe("upserted");
  });

  it("inserts a new cluster when reconciliation finds no match", async () => {
    const db = {
      query: vi.fn(async () => [[]]),
    } as unknown as never;
    const result = await upsertCluster(db, {
      fingerprintId: "fp",
      label: "new",
      memoryIds: ["m99"],
      entityIds: ["e99"],
      size: 1,
      method: "singleton",
    });
    expect(result.action).toBe("inserted");
  });
});

describe("collectOrphanMemories", () => {
  it("returns memory ids not in the clustered set", async () => {
    const db = {
      query: vi.fn(async () => [[
        { id: "m1" },
        { id: "m2" },
        { id: { id: "m3" } },
      ]]),
    } as unknown as never;
    const orphans = await collectOrphanMemories(db, new Set(["m1"]));
    expect(orphans.sort()).toEqual(["m2", "m3"]);
  });

  it("returns empty when all memories are clustered", async () => {
    const db = {
      query: vi.fn(async () => [[{ id: "m1" }]]),
    } as unknown as never;
    const orphans = await collectOrphanMemories(db, new Set(["m1"]));
    expect(orphans).toEqual([]);
  });
});
