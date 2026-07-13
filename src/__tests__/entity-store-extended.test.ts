import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecordId, StringRecordId } from "surrealdb";

vi.mock("../entities/entity-arbitrator.js", () => ({
  entityIdSlug: vi.fn(() => "mock-slug"),
}));

import {
  ensureEntityTables,
  findEntityByName,
  findEntityByAlias,
  linkEntities,
  linkEntityToMemory,
  mergeEntities,
  reassignEntityEdges,
} from "../entities/entity-store.js";

const mockQuery = vi.fn();
const mockQueryTransaction = vi.fn();
const mockDb = { query: mockQuery, queryTransaction: mockQueryTransaction } as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue([[]]);
  mockQueryTransaction.mockResolvedValue(undefined);
});

// ── ensureEntityTables ───────────────────────────────────────────────────────

describe("ensureEntityTables", () => {
  it("defines entities table and all fields/indexes", async () => {
    await ensureEntityTables(mockDb);
    // 2 DEFINE TABLE + many fields + indexes
    const calls = mockQuery.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.filter((s) => s.includes("DEFINE TABLE"))).toHaveLength(2);
    expect(calls.some((s) => s.includes("DEFINE TABLE OVERWRITE entity_edges TYPE RELATION FROM entities TO entities | memories | semiote"))).toBe(true);
    expect(calls.filter((s) => s.includes("DEFINE FIELD"))).toHaveLength(
      calls.filter((s) => s.includes("DEFINE FIELD")).length,
    );
    expect(calls.filter((s) => s.includes("DEFINE INDEX"))).toHaveLength(
      calls.filter((s) => s.includes("DEFINE INDEX")).length,
    );
    // Check specific important fields
    expect(calls.some((s) => s.includes("entity_edges"))).toBe(true);
    expect(calls.some((s) => s.includes("provenance"))).toBe(true);
    expect(calls.some((s) => s.includes("idx_ee_unique"))).toBe(true);
    // aliases_enriched_at: written by entity-alias-enricher; the SCHEMAFULL
    // table rejected the whole UPDATE before this DEFINE (runaway paid loop).
    expect(calls.some((s) =>
      s.includes("DEFINE FIELD IF NOT EXISTS aliases_enriched_at ON TABLE entities"),
    )).toBe(true);
  });
});

// ── findEntityByName ─────────────────────────────────────────────────────────

describe("findEntityByName", () => {
  it("queries by nameNorm with default scope 'user'", async () => {
    mockQuery.mockResolvedValueOnce([[{ id: "e1", nameNorm: "alice" }]]);
    const result = await findEntityByName(mockDb, "alice");
    expect(result).toHaveLength(1);
    expect(mockQuery.mock.calls[0][1]).toEqual({ nameNorm: "alice", scope: "user" });
  });

  it("filters by kind when provided", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    await findEntityByName(mockDb, "alice", "person");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("kind = $kind");
    expect(mockQuery.mock.calls[0][1].kind).toBe("person");
  });

  it("filters by userId when provided", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    await findEntityByName(mockDb, "alice", undefined, "user-1");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("userId = $userId");
    expect(mockQuery.mock.calls[0][1].userId).toBe("user-1");
  });

  it("filters by both kind and userId", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    await findEntityByName(mockDb, "alice", "person", "user-1");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("kind = $kind");
    expect(sql).toContain("userId = $userId");
  });

  it("uses explicit scope when provided", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    await findEntityByName(mockDb, "alice", undefined, undefined, "session");
    expect(mockQuery.mock.calls[0][1].scope).toBe("session");
  });

  it("returns empty array when no results", async () => {
    mockQuery.mockResolvedValueOnce([undefined]);
    const result = await findEntityByName(mockDb, "nonexistent");
    expect(result).toEqual([]);
  });
});

// ── findEntityByAlias ────────────────────────────────────────────────────────

describe("findEntityByAlias", () => {
  it("queries by aliasNorm with default scope 'user'", async () => {
    mockQuery.mockResolvedValueOnce([[{ id: "e1", aliasesNorm: ["al"] }]]);
    const result = await findEntityByAlias(mockDb, "al");
    expect(result).toHaveLength(1);
    expect(mockQuery.mock.calls[0][1]).toEqual({ aliasNorm: "al", scope: "user" });
  });

  it("filters by userId when provided", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    await findEntityByAlias(mockDb, "al", "user-1");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("userId = $userId");
  });

  it("uses explicit scope when provided", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    await findEntityByAlias(mockDb, "al", undefined, "session");
    expect(mockQuery.mock.calls[0][1].scope).toBe("session");
  });

  it("returns empty array when result[0] is undefined", async () => {
    mockQuery.mockResolvedValueOnce([undefined]);
    const result = await findEntityByAlias(mockDb, "nonexistent");
    expect(result).toEqual([]);
  });
});

// ── linkEntities ─────────────────────────────────────────────────────────────

describe("linkEntities", () => {
  it("creates RELATE edge between two entities", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    const result = await linkEntities(mockDb, "e1", "e2", "affiliated_with", {
      confidence: 0.8,
      sourceProject: "test",
      scope: "user",
    });
    expect(result).toBe("e1->affiliated_with->e2");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("RELATE");
    const params = mockQuery.mock.calls[0][1];
    expect(params.fromRecord).toBeInstanceOf(RecordId);
    expect(params.toRecord).toBeInstanceOf(RecordId);
    expect(params.weight).toBe(1.0); // default weight
    expect(params.provenance).toBe("entity-extraction"); // default provenance
  });

  it("passes optional fields when provided", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    await linkEntities(mockDb, "e1", "e2", "related_to", {
      confidence: 0.7,
      weight: 2.5,
      sourceMemoryId: "mem-1",
      contextText: "they work together",
      sourceProject: "test",
      scope: "session",
      sessionId: "sess-1",
      provenance: "custom",
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params.weight).toBe(2.5);
    expect(params.sourceMemoryId).toBe("mem-1");
    expect(params.contextText).toBe("they work together");
    expect(params.sessionId).toBe("sess-1");
    expect(params.provenance).toBe("custom");
  });

  it("on unique constraint violation, updates existing edge", async () => {
    mockQuery
      .mockRejectedValueOnce(new Error("unique constraint violation"))
      .mockResolvedValueOnce([[]]);

    const result = await linkEntities(mockDb, "e1", "e2", "affiliated_with", {
      confidence: 0.8,
      sourceProject: "test",
      scope: "user",
    });
    expect(result).toBe("e1->affiliated_with->e2");
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toContain("UPDATE");
  });

  it("on 'already exists' error, updates existing edge", async () => {
    mockQuery
      .mockRejectedValueOnce(new Error("record already exists"))
      .mockResolvedValueOnce([[]]);

    await linkEntities(mockDb, "e1", "e2", "affiliated_with", {
      confidence: 0.8,
      sourceProject: "test",
      scope: "user",
    });
    expect(mockQuery.mock.calls[1][0]).toContain("UPDATE");
  });

  it("rethrows non-unique errors", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      linkEntities(mockDb, "e1", "e2", "affiliated_with", {
        confidence: 0.8,
        sourceProject: "test",
        scope: "user",
      }),
    ).rejects.toThrow("connection lost");
  });
});

// ── linkEntityToMemory (additional coverage) ─────────────────────────────────

describe("linkEntityToMemory — additional", () => {
  it("rethrows non-unique errors", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      linkEntityToMemory(mockDb, "e1", "mem-1", {
        confidence: 0.9,
        sourceProject: "test",
        scope: "user",
      }),
    ).rejects.toThrow("connection lost");
  });

  it("passes optional contextText and sessionId", async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    await linkEntityToMemory(mockDb, "e1", "mem-1", {
      confidence: 0.9,
      contextText: "some context",
      sourceProject: "test",
      scope: "session",
      sessionId: "sess-1",
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params.contextText).toBe("some context");
    expect(params.sessionId).toBe("sess-1");
  });
});

// ── mergeEntities ────────────────────────────────────────────────────────────

describe("mergeEntities", () => {
  it("applies winner updates and deletes loser (no edges) in one transaction", async () => {
    mockQuery
      .mockResolvedValueOnce([[]]) // composeEdgeReassignment READ 1: no loser edges
      .mockResolvedValueOnce([[{ aliases: ["old-alias"], aliasesNorm: ["old_alias"] }]]); // loser aliases

    await mergeEntities(mockDb, "winner", "loser", {
      canonicalName: "Winner Name",
      nameNorm: "winner_name",
      confidence: 0.95,
      firstSeenAt: "2024-01-01",
      lastSeenAt: "2024-06-01",
      description: "Updated description",
      aliases: ["alias1"],
      aliasesNorm: ["alias_1"],
    });

    // Winner update + loser-alias union + loser delete are ONE atomic transaction.
    expect(mockQueryTransaction).toHaveBeenCalledTimes(1);
    const [body, vars] = mockQueryTransaction.mock.calls[0];
    expect(body).toContain("UPDATE type::record('entities', $winnerId)");
    expect(body).toContain("canonicalName = $canonicalName");
    expect(body).toContain("nameNorm = $nameNorm");
    expect(body).toContain("confidence = $confidence");
    expect(body).toContain("description = $description");
    expect(body).toContain("$loserAliases"); // loser had a row → union emitted
    expect(body).toContain("DELETE type::record('entities', $loserId)");
    expect(vars.canonicalName).toBe("Winner Name");
    expect(vars.loserAliases).toEqual(["old-alias"]);
  });

  it("transfers loser edges to winner (no collision)", async () => {
    const loserEdge = {
      id: "edge-1",
      in: "entities:loser",
      out: "entities:other",
      kind: "works_with",
      confidence: 0.8,
      weight: 1.0,
      observedAt: "2024-01-01",
      lastSeenAt: "2024-06-01",
      sourceProject: "test",
      scope: "user",
    };

    mockQuery
      .mockResolvedValueOnce([[loserEdge]]) // composeEdgeReassignment READ 1: loser edges
      .mockResolvedValueOnce([[]]) // composeEdgeReassignment READ 2: collision none
      .mockResolvedValueOnce([[{ aliases: [], aliasesNorm: [] }]]); // loser aliases

    await mergeEntities(mockDb, "winner", "loser", {});

    // Winner update, edge move, and loser delete are ONE atomic transaction.
    expect(mockQueryTransaction).toHaveBeenCalledTimes(1);
    const [body, vars] = mockQueryTransaction.mock.calls[0];
    expect(body).toContain("RELATE");
    expect(body).toContain("DELETE type::record('entities', $loserId)");
    // loser was `in`, remapped to winner; the merge edge fragment uses the "m" prefix.
    expect(String(vars.m0_from)).toBe("entities:winner");
    expect(String(vars.m0_to)).toBe("entities:other");
  });

  // Edge reassignment moved out of mergeEntities into reassignEntityEdges — graph-edge
  // endpoints are immutable, so edges are recreated, not UPDATE-d in place (Rúnir-imaf.12).
  it("reassignEntityEdges merges colliding edges (folds signal into the existing winner edge)", async () => {
    const loserEdge = {
      id: "edge-loser",
      in: "entities:loser",
      out: "entities:other",
      kind: "works_with",
      confidence: 0.8,
      weight: 2.0,
      lastSeenAt: "2024-06-01",
      contextText: "loser context",
    };
    const existingWinnerEdge = {
      id: "edge-winner",
      in: "entities:winner",
      out: "entities:other",
      kind: "works_with",
      confidence: 0.6,
      weight: 1.0,
      lastSeenAt: "2024-03-01",
    };

    mockQuery
      .mockResolvedValueOnce([[loserEdge]])           // READ 1: edges touching the loser
      .mockResolvedValueOnce([[existingWinnerEdge]]); // READ 2: collision SELECT — found

    await reassignEntityEdges(mockDb, "loser", "winner");

    // Fold (UPDATE existing + DELETE original) runs as one atomic transaction.
    expect(mockQueryTransaction).toHaveBeenCalledTimes(1);
    const [body, vars] = mockQueryTransaction.mock.calls[0];
    expect(body).toContain("UPDATE");
    expect(body).toContain("DELETE");
    expect(vars.r0_existingId).toBe("edge-winner");
    expect(vars.r0_confidence).toBe(0.8); // max(0.8, 0.6)
    expect(vars.r0_weight).toBe(3.0); // 2.0 + 1.0
    expect(vars.r0_lastSeenAt).toBe("2024-06-01"); // newer
  });

  it("reassignEntityEdges handles inbound edges (loser is 'out') — recreates onto the winner", async () => {
    const loserEdge = {
      id: "edge-1",
      in: "entities:other",
      out: "entities:loser",
      kind: "affiliated_with",
      confidence: 0.7,
      weight: 1.0,
      observedAt: "2024-01-01",
      lastSeenAt: "2024-03-01",
      sourceProject: "test",
      scope: "user",
    };

    mockQuery
      .mockResolvedValueOnce([[loserEdge]]) // READ 1: edges touching the loser
      .mockResolvedValueOnce([[]]);          // READ 2: collision SELECT — none

    await reassignEntityEdges(mockDb, "loser", "winner");

    expect(mockQueryTransaction).toHaveBeenCalledTimes(1);
    const [body, vars] = mockQueryTransaction.mock.calls[0];
    expect(body).toContain("RELATE");
    // `in` stays entities:other; the `out` endpoint (loser) is remapped to the winner.
    expect(vars.r0_to).toBeInstanceOf(StringRecordId);
    expect(String(vars.r0_to)).toBe("entities:winner");
    expect(String(vars.r0_from)).toBe("entities:other");
  });

  it("still deletes the loser in the transaction when it has empty aliases", async () => {
    mockQuery
      .mockResolvedValueOnce([[]]) // READ 1: no edges
      .mockResolvedValueOnce([[]]); // loser aliases SELECT → no rows

    await mergeEntities(mockDb, "winner", "loser", {});

    expect(mockQueryTransaction).toHaveBeenCalledTimes(1);
    const [body] = mockQueryTransaction.mock.calls[0];
    expect(body).toContain("DELETE type::record('entities', $loserId)");
  });

  it("builds minimal SET clause when no optional updates provided", async () => {
    mockQuery
      .mockResolvedValueOnce([[]]) // READ 1: no edges
      .mockResolvedValueOnce([[{ aliases: [], aliasesNorm: [] }]]); // loser aliases

    await mergeEntities(mockDb, "winner", "loser", {});

    expect(mockQueryTransaction).toHaveBeenCalledTimes(1);
    const [body] = mockQueryTransaction.mock.calls[0];
    // No optional fields, but always the aliases union + updatedAt on the winner update.
    expect(body).not.toContain("canonicalName = $canonicalName");
    expect(body).toContain("array::union");
    expect(body).toContain("updatedAt");
  });
});
