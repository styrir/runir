import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecordId } from "surrealdb";
import {
  linkEntityToMemory,
  getSupportingMemoryIds,
  getEntityByMemory,
} from "../entities/entity-store.js";

vi.mock("../entities/entity-arbitrator.js", () => ({
  entityIdSlug: vi.fn(() => "mock-slug"),
}));

const mockDb = { query: vi.fn() } as any;

describe("entity-to-memory linking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("linkEntityToMemory: RELATE query called with correct entity/memory IDs", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    await linkEntityToMemory(mockDb, "ent-abc", "mem-xyz", {
      confidence: 0.85,
      sourceProject: "test",
      scope: "user",
      contextText: "mentioned in context",
    });

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const sql = mockDb.query.mock.calls[0][0];
    const params = mockDb.query.mock.calls[0][1];
    expect(sql).toContain("RELATE");
    expect(params.fromRecord).toBeInstanceOf(RecordId);
    expect(String(params.fromRecord.table)).toBe("entities");
    expect(params.fromRecord.id).toBe("ent-abc");
    expect(params.toRecord).toBeInstanceOf(RecordId);
    expect(String(params.toRecord.table)).toBe("semiote");
    expect(params.toRecord.id).toBe("mem-xyz");
    expect(params.confidence).toBe(0.85);
  });

  it("on unique constraint violation: UPDATE query called instead", async () => {
    mockDb.query
      .mockRejectedValueOnce(new Error("unique constraint violation"))
      .mockResolvedValueOnce([[]]);

    await linkEntityToMemory(mockDb, "ent-abc", "mem-xyz", {
      confidence: 0.9,
      sourceProject: "test",
      scope: "user",
    });

    expect(mockDb.query).toHaveBeenCalledTimes(2);
    const updateSql = mockDb.query.mock.calls[1][0];
    expect(updateSql).toContain("UPDATE");
    expect(updateSql).toContain("mentioned_in");
  });

  it("getSupportingMemoryIds: returns correct memory ID array", async () => {
    mockDb.query.mockResolvedValueOnce([
      [{ outs: ["memories:m1", "memories:m2", "memories:m3"] }],
    ]);

    const ids = await getSupportingMemoryIds(mockDb, "ent-1");
    expect(ids).toEqual(["memories:m1", "memories:m2", "memories:m3"]);
  });

  it("getEntityByMemory: returns correct entity array", async () => {
    const e1 = { id: "entities:e1", kind: "person", canonicalName: "Alice" };
    const e2 = { id: "entities:e2", kind: "org", canonicalName: "Acme" };
    mockDb.query.mockResolvedValueOnce([[{ in: e1 }, { in: e2 }]]);

    const entities = await getEntityByMemory(mockDb, "mem-1");
    expect(entities).toEqual([e1, e2]);
  });
});
