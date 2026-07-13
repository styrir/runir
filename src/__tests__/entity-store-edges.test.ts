import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecordId } from "surrealdb";
import {
  linkEntityToMemory,
  getSupportingMemoryIds,
  getSupportingMemoryIdsBatch,
  getEntityNeighbors,
  getEntityByMemory,
} from "../entities/entity-store.js";

vi.mock("../entities/entity-arbitrator.js", () => ({
  entityIdSlug: vi.fn(() => "mock-slug"),
}));

const mockDb = { query: vi.fn() } as any;

describe("linkEntityToMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls db.query with RELATE syntax for mentioned_in", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    await linkEntityToMemory(mockDb, "entity-1", "mem-1", {
      confidence: 0.9,
      sourceProject: "test",
      scope: "user",
    });

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls[0][0]).toContain("RELATE");
    expect(mockDb.query.mock.calls[0][0]).toContain("mentioned_in");
    const params = mockDb.query.mock.calls[0][1];
    expect(params.fromRecord).toBeInstanceOf(RecordId);
    expect(String(params.fromRecord.table)).toBe("entities");
    expect(params.fromRecord.id).toBe("entity-1");
    expect(params.toRecord).toBeInstanceOf(RecordId);
    expect(String(params.toRecord.table)).toBe("semiote");
    expect(params.toRecord.id).toBe("mem-1");
  });

  it("on unique constraint violation, runs UPDATE instead", async () => {
    mockDb.query
      .mockRejectedValueOnce(new Error("Database index `idx_ee_unique` already contains"))
      .mockResolvedValueOnce([[]]);

    await linkEntityToMemory(mockDb, "entity-1", "mem-1", {
      confidence: 0.9,
      sourceProject: "test",
      scope: "user",
    });

    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockDb.query.mock.calls[1][0]).toContain("UPDATE");
  });
});

describe("getSupportingMemoryIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns array of memory IDs from mentioned_in edges via graph traversal", async () => {
    mockDb.query.mockResolvedValueOnce([
      [{ outs: ["memories:mem-1", "memories:mem-2"] }],
    ]);

    const ids = await getSupportingMemoryIds(mockDb, "entity-1");
    expect(ids).toEqual(["memories:mem-1", "memories:mem-2"]);
    // Traversal form, not a `WHERE in =` edge-table scan (planner serves that from
    // idx_ee_kind and walks every mentioned_in edge — the 5s entity-leg timeout).
    expect(mockDb.query.mock.calls[0][0]).toContain("->entity_edges");
    expect(mockDb.query.mock.calls[0][0]).toContain("mentioned_in");
    const params = mockDb.query.mock.calls[0][1];
    expect(params.entityRecord).toBeInstanceOf(RecordId);
    expect(String(params.entityRecord.table)).toBe("entities");
    expect(params.entityRecord.id).toBe("entity-1");
  });

  it("returns [] when the entity record does not exist or has no edges", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);
    expect(await getSupportingMemoryIds(mockDb, "ghost")).toEqual([]);

    mockDb.query.mockResolvedValueOnce([[{ outs: [] }]]);
    expect(await getSupportingMemoryIds(mockDb, "edgeless")).toEqual([]);
  });
});

describe("getEntityNeighbors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches outbound + inbound edges, filters mentioned_in, returns entity+edge pairs", async () => {
    const edge1 = {
      in: "entities:e1",
      out: "entities:e2",
      kind: "affiliated_with",
      confidence: 0.9,
      observedAt: "2026-01-01",
      lastSeenAt: "2026-01-01",
      sourceProject: "test",
      scope: "user",
    };
    const entity2 = {
      id: "entities:e2",
      kind: "org",
      canonicalName: "Acme",
      nameNorm: "acme",
    };

    // outbound query returns one edge
    mockDb.query
      .mockResolvedValueOnce([[edge1]])  // outbound edges
      .mockResolvedValueOnce([[]])        // inbound edges
      .mockResolvedValueOnce([[entity2]]); // neighbor lookup

    const neighbors = await getEntityNeighbors(mockDb, "e1");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].entity).toEqual(entity2);
    expect(neighbors[0].edge.kind).toBe("affiliated_with");
  });
});

describe("getEntityByMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns entities linked to a memory via mentioned_in", async () => {
    const entity = {
      id: "entities:e1",
      kind: "person",
      canonicalName: "Alice",
    };
    mockDb.query.mockResolvedValueOnce([[{ in: entity }]]);

    const entities = await getEntityByMemory(mockDb, "mem-1");
    expect(entities).toEqual([entity]);
    expect(mockDb.query.mock.calls[0][0]).toContain("mentioned_in");
  });
});

describe("getSupportingMemoryIdsBatch (imaf.11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("one traversal query for the whole set, keyed by bare entity id, per-record outs order preserved", async () => {
    mockDb.query.mockResolvedValueOnce([[
      { id: "entities:ent-a", outs: ["semiote:m1", "semiote:m2"] },
      { id: "entities:ent-b", outs: ["semiote:m3"] },
    ]]);
    const result = await getSupportingMemoryIdsBatch(mockDb, ["ent-a", "ent-b"]);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const [sql, vars] = mockDb.query.mock.calls[0];
    expect(sql).toContain('->entity_edges[WHERE kind = "mentioned_in"].out');
    expect(sql).toContain("FROM $entityRecords");
    expect((vars as { entityRecords: unknown[] }).entityRecords).toHaveLength(2);
    expect(result.get("ent-a")).toEqual(["semiote:m1", "semiote:m2"]);
    expect(result.get("ent-b")).toEqual(["semiote:m3"]);
  });

  it("returns an empty map without querying for an empty id list", async () => {
    const result = await getSupportingMemoryIdsBatch(mockDb, []);
    expect(result.size).toBe(0);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
