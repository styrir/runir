import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dag-guard
vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

// ---------------------------------------------------------------------------
// We test by inspecting the SQL strings passed to db.query()
// ---------------------------------------------------------------------------

import {
  findSimilarMemories,
  deleteMemoryById,
  supersedeMemory,
  upsertMemory,
} from "../storage/surreal/surreal-store.js";
import { bm25Search } from "../recall/query/memory-query.js";
import type { Bm25CorpusStats, SimilarCandidate } from "../domain/memory/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDb() {
  const mockQuery = vi.fn().mockResolvedValue([[]]);
  const mockQueryTransaction = vi.fn().mockResolvedValue(undefined);
  return { query: mockQuery, queryTransaction: mockQueryTransaction } as any;
}

function makeCandidate(overrides: Partial<SimilarCandidate> = {}): SimilarCandidate {
  const now = new Date().toISOString();
  return {
    id: "existing-id",
    l2: "existing memory text",
    similarity: 0.9,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("surreal-store integration (MIM-60)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scope=session filtering emits AND scope = $scope AND session_id = $sessionId", async () => {
    const db = makeDb();
    const embedding = [1, 0, 0, 0, 0, 0, 0, 0];

    await findSimilarMemories(db, "user1", embedding, 72, 5, "session", "sess-123");

    expect(db.query).toHaveBeenCalled();
    const [sql, vars] = db.query.mock.calls[0]!;
    expect(sql).toContain("scope = $scope");
    expect(sql).toContain("session_id = $sessionId");
    expect(vars.scope).toBe("session");
    expect(vars.sessionId).toBe("sess-123");
  });

  it("scope=user filtering emits AND (scope = NONE OR scope = $scope)", async () => {
    const db = makeDb();
    const embedding = [1, 0, 0, 0, 0, 0, 0, 0];

    await findSimilarMemories(db, "user1", embedding, 72, 5, "user");

    expect(db.query).toHaveBeenCalled();
    const [sql, vars] = db.query.mock.calls[0]!;
    expect(sql).toContain("scope = NONE OR scope = $scope");
    expect(vars.scope).toBe("user");
  });

  it("deleteMemoryById soft-inactivation sets payload.active=false not hard-delete", async () => {
    const db = makeDb();

    await deleteMemoryById(db, "mem-123", "user1", "soft-inactivate");

    expect(db.query).toHaveBeenCalled();
    const [sql] = db.query.mock.calls[0]!;
    expect(sql).toContain("active = false");
    expect(sql).toContain("payload.active = false");
    expect(sql).not.toContain("DELETE");
  });

  it("deleteMemoryById hard-delete uses DELETE statement", async () => {
    const db = makeDb();

    await deleteMemoryById(db, "mem-123", "user1", "hard-delete");

    expect(db.query).toHaveBeenCalled();
    const [sql] = db.query.mock.calls[0]!;
    expect(sql).toContain("DELETE");
    expect(sql).not.toContain("active = false");
  });

  it("supersedeMemory populates lineage chain", async () => {
    const db = makeDb();

    const previous = makeCandidate({ id: "prev-id", lineageRootId: "root-id" });
    const replacement = {
      id: "new-id",
      text: "new memory text",
      userId: "user1",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      scope: "user" as const,
      writeSource: "memory_store" as const,
    };

    await supersedeMemory(db, previous, replacement, "deterministic");

    // supersedeMemory runs the upsert + provenance + previous-row inactivation
    // as ONE transaction; the previous-row UPDATE carries the lineage chain.
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
    const [body, vars] = db.queryTransaction.mock.calls[0];
    expect(body).toContain("superseded_by");
    expect(body).toContain("lineage_root_id");
    expect((vars as Record<string, unknown>).lineageRootId).toBe("root-id");
  });

  it("BM25 query uses inline text not bound param for MATCHES", async () => {
    const db = makeDb();
    db.query.mockResolvedValue([[]]); // For both the query and stats query

    const statsCache = new Map<string, Bm25CorpusStats>();
    statsCache.set("user1", {
      totalDocs: 100,
      avgDocLength: 50,
      refreshedAtMs: 1_700_000_000_000,
    });

    await bm25Search(db, "user1", "test query", 10, statsCache);

    expect(db.query).toHaveBeenCalled();
    // Find the MATCHES query call
    const matchesCalls = db.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes("@0@") || sql.includes("MATCHES")
    );

    expect(matchesCalls.length).toBeGreaterThan(0);
    const [sql] = matchesCalls[0]!;
    // The query text should be inlined in the SQL string
    expect(sql).toContain("test");
    expect(sql).toContain("query");
    // Should use @0@ syntax with inline query
    expect(sql).toContain("@0@");
  });

  it("findSimilarMemories vector literal is inlined not bound", async () => {
    const db = makeDb();
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

    await findSimilarMemories(db, "user1", embedding, 72, 5);

    expect(db.query).toHaveBeenCalled();
    const [sql] = db.query.mock.calls[0]!;

    // The embedding should be inlined as a JSON array in the SQL
    expect(sql).toContain("0.1");
    expect(sql).toContain("0.8");
    // Should contain the full vector literal
    expect(sql).toMatch(/\[[\d.,\s]+\]/);
  });

  it("findSimilarMemories returns properly shaped results", async () => {
    const db = makeDb();
    const embedding = [1, 0, 0, 0];

    // Mock the query to return a realistic row
    db.query.mockResolvedValue([
      [
        {
          id: "memories:test-123",
          payload: {
            l2: "test memory text",
            createdAt: "2026-03-01T00:00:00Z",
            updatedAt: "2026-03-02T00:00:00Z",
            scope: "user",
          },
          sim: 0.92,
          scope: "user",
          session_id: null,
          lineage_root_id: null,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-02T00:00:00Z",
        },
      ],
    ]);

    const results = await findSimilarMemories(db, "user1", embedding, 72, 5);

    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe("test-123");
    expect(results[0]!.l2).toBe("test memory text");
    expect(results[0]!.similarity).toBe(0.92);
    expect(results[0]!.scope).toBe("user");
  });

  // Rúnir-pn1l.13.4: the mapper previously dropped the referent-identity keys,
  // so proveReferentIdentity's key-equality arms always got empty keys. Assert
  // they are surfaced from a payload-bearing row.
  it("findSimilarMemories surfaces referent-identity keys from the payload", async () => {
    const db = makeDb();
    const embedding = [1, 0, 0, 0];

    db.query.mockResolvedValue([
      [
        {
          id: "memories:keyed-1",
          payload: {
            l2: "runir local service uses port 7700",
            createdAt: "2026-03-01T00:00:00Z",
            factKey: "config:port-a1b2c3",
            noemaClaimKey: "claim:runir-port",
            continuitySubjectKey: "subject:runir-port",
            atomicFact: { subject: "Runir local service", predicate: "uses_port", value: "7700" },
          },
          sim: 0.9,
          scope: "user",
          session_id: null,
          lineage_root_id: null,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
      ],
    ]);

    const [hit] = await findSimilarMemories(db, "user1", embedding, 72, 5);

    expect(hit!.factKey).toBe("config:port-a1b2c3");
    expect(hit!.noemaClaimKey).toBe("claim:runir-port");
    expect(hit!.continuitySubjectKey).toBe("subject:runir-port");
    expect(hit!.atomicFact).toEqual({
      subject: "Runir local service",
      predicate: "uses_port",
      value: "7700",
    });
  });

  // Rúnir-pn1l.13.4: absent payload keys must map to undefined, never crash.
  it("findSimilarMemories leaves referent keys undefined when the payload omits them", async () => {
    const db = makeDb();
    const embedding = [1, 0, 0, 0];

    db.query.mockResolvedValue([
      [
        {
          id: "memories:keyless-1",
          payload: { l2: "no keys here", createdAt: "2026-03-01T00:00:00Z" },
          sim: 0.8,
          scope: "user",
          session_id: null,
          lineage_root_id: null,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
      ],
    ]);

    const [hit] = await findSimilarMemories(db, "user1", embedding, 72, 5);

    expect(hit!.factKey).toBeUndefined();
    expect(hit!.noemaClaimKey).toBeUndefined();
    expect(hit!.continuitySubjectKey).toBeUndefined();
    expect(hit!.atomicFact).toBeUndefined();
  });

  it("upsertMemory generates proper SQL with all fields", async () => {
    const db = makeDb();

    await upsertMemory(
      db,
      "new-mem-id",
      "test memory text",
      "user1",
      [1, 0, 0, 0, 0, 0, 0, 0],
      { writeSource: "memory_store" },
      "user",
      undefined,
      { active: true }
    );

    expect(db.query).toHaveBeenCalled();
    const [sql, vars] = db.query.mock.calls[0]!;

    expect(sql).toContain("UPSERT");
    expect(sql).toContain("embedding");
    expect(sql).toContain("payload");
    expect(sql).toContain("text_norm");
    expect(sql).toContain("scope");
    expect(vars.userId).toBe("user1");
    expect(vars.scope).toBe("user");
  });
});
