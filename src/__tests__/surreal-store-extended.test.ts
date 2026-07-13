import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWouldCreateCycle = vi.fn().mockResolvedValue(false);
vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: (...args: unknown[]) => mockWouldCreateCycle(...args),
}));

import {
  supersedeMemory,
  extractId,
  ensureBm25Index,
  upsertMemory,
  listMemories,
  getMemoryById,
  deleteMemoryById,
  listRecentMemories,
  findSimilarMemories,
  updateMemoryText,
  restoreMemoryById,
  getMemoryLineage,
  getMemoryHealth,
  getBm25CorpusStats,
  ensureSessionWatermarksTable,
  getLastWatermark,
  createWatermark,
  fetchAllActiveMemoriesForScope,
  softArchiveInactiveOlderThan,
  ensureEmbeddingMetadataTable,
  getEmbeddingFingerprint,
  setEmbeddingFingerprint,
  ensureRejectionLogTable,
  logRejection,
  ensureMemoryEnrichmentSchema,
  ensureAttributionFields,
  backfillHasPath,
  ACTIVE_MEMORY_FILTER,
  DEFAULT_FINGERPRINT_TTL_MS,
} from "../storage/surreal/surreal-store.js";

function mockDb(rows: any[] = []) {
  return {
    query: vi.fn().mockResolvedValue([rows]),
    queryTransaction: vi.fn().mockResolvedValue(undefined),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── ensureAttributionFields (MIM-69 Task 1) ─────────────────────────────────

describe("ensureAttributionFields", () => {
  it("defines staleness and hasPath fields", async () => {
    const db = mockDb();
    await ensureAttributionFields(db);
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("payload.isStale");
    expect(sql).toContain("payload.staleSince");
    expect(sql).toContain("payload.contradictedBy");
    expect(sql).toContain("payload.hasPath");
  });
});

// ── extractId ────────────────────────────────────────────────────────────────

describe("extractId", () => {
  it("extracts id from object with id property", () => {
    expect(extractId({ id: "abc" })).toBe("abc");
  });

  it("strips table prefix from string", () => {
    expect(extractId("memories:abc")).toBe("abc");
  });

  it("handles plain string", () => {
    expect(extractId("abc")).toBe("abc");
  });
});

// ── ACTIVE_MEMORY_FILTER ─────────────────────────────────────────────────────

describe("ACTIVE_MEMORY_FILTER", () => {
  it("is defined", () => {
    expect(ACTIVE_MEMORY_FILTER).toContain("active");
  });
});

// ── ensureBm25Index ──────────────────────────────────────────────────────────

describe("ensureBm25Index", () => {
  it("creates analyzer, fields, and index", async () => {
    const db = mockDb();
    await ensureBm25Index(db);
    const calls = db.query.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("DEFINE ANALYZER"))).toBe(true);
    expect(calls.some((s: string) => s.includes("text_norm"))).toBe(true);
    expect(calls.some((s: string) => s.includes("BM25"))).toBe(true);
    expect(calls.some((s: string) => s.includes("scope"))).toBe(true);
    expect(calls.some((s: string) => s.includes("superseded_by"))).toBe(true);
    expect(calls.some((s: string) => s.includes("archived"))).toBe(true);
  });
});

// ── upsertMemory ─────────────────────────────────────────────────────────────

describe("upsertMemory", () => {
  it("inserts a memory with default lifecycle", async () => {
    const db = mockDb();
    const id = await upsertMemory(db, "m1", "hello", "u1", [1, 0]);
    expect(id).toBe("m1");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("UPSERT");
    expect(db.query.mock.calls[0][1].active).toBe(true);
  });

  it("uses custom scope, sessionId, and lifecycle", async () => {
    const db = mockDb();
    await upsertMemory(db, "m1", "hello", "u1", [1], { tags: ["test"] }, "session", "s1", {
      active: false,
      inactiveAt: "2024-01-01",
      inactiveReason: "superseded",
      supersededById: "m2",
      supersedesId: "m0",
      lineageRootId: "m0",
    });
    const params = db.query.mock.calls[0][1];
    expect(params.scope).toBe("session");
    expect(params.sessionId).toBe("s1");
    expect(params.active).toBe(false);
    expect(params.lineageRootId).toBe("m0");
  });
});

// ── listMemories ─────────────────────────────────────────────────────────────

describe("listMemories", () => {
  it("returns memories for user", async () => {
    const db = mockDb([{ id: "m1", payload: { l2: "hi" } }]);
    const result = await listMemories(db, "u1");
    expect(result).toHaveLength(1);
  });

  it("applies scope filter", async () => {
    const db = mockDb([]);
    await listMemories(db, "u1", { whereClause: "AND scope = $scope", vars: { scope: "user" } });
    expect(db.query.mock.calls[0][0]).toContain("AND scope = $scope");
  });

  it("returns empty when result[0] is undefined", async () => {
    const db = { query: vi.fn().mockResolvedValue([undefined]) } as any;
    const result = await listMemories(db, "u1");
    expect(result).toEqual([]);
  });
});

// ── getMemoryById ────────────────────────────────────────────────────────────

describe("getMemoryById", () => {
  it("returns memory rows", async () => {
    const db = mockDb([{ id: "m1", payload: {} }]);
    const result = await getMemoryById(db, "m1", "u1", "memories");
    expect(result).toHaveLength(1);
  });
});

// ── deleteMemoryById ─────────────────────────────────────────────────────────

describe("deleteMemoryById", () => {
  it("soft-inactivates by default", async () => {
    const db = mockDb();
    await deleteMemoryById(db, "m1", "u1");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE");
    expect(sql).toContain("active = false");
  });

  it("hard-deletes when mode is hard-delete", async () => {
    const db = mockDb();
    await deleteMemoryById(db, "m1", "u1", "hard-delete");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("DELETE");
  });
});

// ── listRecentMemories ───────────────────────────────────────────────────────

describe("listRecentMemories", () => {
  it("queries with cutoff and limit", async () => {
    const db = mockDb([]);
    await listRecentMemories(db, "u1", "2024-01-01T00:00:00Z", 50);
    const params = db.query.mock.calls[0][1];
    expect(params.cutoff).toBe("2024-01-01T00:00:00Z");
    expect(params.limit).toBe(50);
  });
});

// ── findSimilarMemories ──────────────────────────────────────────────────────

describe("findSimilarMemories — scope variants", () => {
  it("adds session scope clause", async () => {
    const db = mockDb([]);
    await findSimilarMemories(db, "u1", [1], 24, 10, "session", "s1");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("AND scope = $scope AND session_id = $sessionId");
  });

  it("adds user scope clause", async () => {
    const db = mockDb([]);
    await findSimilarMemories(db, "u1", [1], 24, 10, "user");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("scope = NONE OR scope = $scope");
  });

  it("adds global scope clause", async () => {
    const db = mockDb([]);
    await findSimilarMemories(db, "u1", [1], 24, 10, "global");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("AND scope = $scope");
  });

  it("returns mapped results", async () => {
    const db = mockDb([{
      id: "m1", payload: { l2: "hi", createdAt: "2024-01-01" }, sim: 0.9,
      scope: "user", session_id: null, lineage_root_id: null,
    }]);
    const result = await findSimilarMemories(db, "u1", [1], 24, 10);
    expect(result[0].id).toBe("m1");
    expect(result[0].l2).toBe("hi");
    expect(result[0].similarity).toBe(0.9);
  });
});

// ── updateMemoryText ─────────────────────────────────────────────────────────

describe("updateMemoryText", () => {
  it("updates text and embedding", async () => {
    const db = mockDb();
    await updateMemoryText(db, "m1", "updated text", [0, 1], "session_summary", "retain");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE");
    expect(sql).toContain("payload.l2 = $newText");
    const params = db.query.mock.calls[0][1];
    expect(params.newText).toBe("updated text");
    expect(params.writeSource).toBe("session_summary");
  });
});

// ── restoreMemoryById ────────────────────────────────────────────────────────

describe("restoreMemoryById", () => {
  it("returns true when rows are updated", async () => {
    const db = mockDb([{ id: "m1" }]);
    const result = await restoreMemoryById(db, "m1", "u1", "memories");
    expect(result).toBe(true);
  });

  it("returns false when no rows match", async () => {
    const db = mockDb([]);
    const result = await restoreMemoryById(db, "m1", "u1", "memories");
    expect(result).toBe(false);
  });
});

// ── getMemoryLineage ─────────────────────────────────────────────────────────

describe("getMemoryLineage", () => {
  it("returns empty for unknown memory", async () => {
    const db = mockDb([]);
    const result = await getMemoryLineage(db, "m1", "u1", "memories");
    expect(result).toEqual([]);
  });

  it("returns lineage chain", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "m1", lineage_root_id: "m0", payload: {} }]])
        .mockResolvedValueOnce([[
          { id: "m0", payload: { l2: "first" }, active: false, superseded_by: "m1" },
          { id: "m1", payload: { l2: "second" }, active: true },
        ]]),
    } as any;

    const result = await getMemoryLineage(db, "m1", "u1", "memories");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("m0");
  });
});

// ── getMemoryHealth ──────────────────────────────────────────────────────────

describe("getMemoryHealth", () => {
  it("returns health stats", async () => {
    const db = mockDb([{
      total: 10, active_count: 8, inactive_count: 2,
      oldest: "2024-01-01", newest: "2024-06-01",
    }]);
    const result = await getMemoryHealth(db, "u1", "memories");
    expect(result).toEqual({
      total: 10, active: 8, inactive: 2,
      oldest: "2024-01-01", newest: "2024-06-01",
      maintenance: { lastRunAt: null, lastDecayPruned: null, lastPromoted: null, lastDeduped: null },
    });
  });

  it("returns zeros when no data", async () => {
    const db = mockDb([]);
    const result = await getMemoryHealth(db, "u1", "memories");
    expect(result).toEqual({ total: 0, active: 0, inactive: 0, oldest: null, newest: null, maintenance: { lastRunAt: null, lastDecayPruned: null, lastPromoted: null, lastDeduped: null } });
  });
});

// ── getBm25CorpusStats ───────────────────────────────────────────────────────

describe("getBm25CorpusStats", () => {
  it("returns cached stats when fresh", async () => {
    const cache = new Map();
    cache.set("memories:u1", { totalDocs: 5, avgDocLength: 10, refreshedAtMs: Date.now() });
    const db = mockDb();
    const stats = await getBm25CorpusStats(db, "u1", cache, 60000, "memories");
    expect(stats.totalDocs).toBe(5);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("fetches from DB when cache is stale", async () => {
    const cache = new Map();
    cache.set("memories:u1", { totalDocs: 5, avgDocLength: 10, refreshedAtMs: Date.now() - 120000 });
    const db = mockDb([{ total_docs: 20, avg_doc_length: 15 }]);
    const stats = await getBm25CorpusStats(db, "u1", cache, 60000, "memories");
    expect(stats.totalDocs).toBe(20);
    expect(stats.avgDocLength).toBe(15);
  });

  it("fetches from DB when cache is empty", async () => {
    const db = mockDb([{ total_docs: 10, avg_doc_length: 0 }]);
    const stats = await getBm25CorpusStats(db, "u1", new Map(), 60000, "memories");
    expect(stats.totalDocs).toBe(10);
    expect(stats.avgDocLength).toBe(1); // fallback when avg is 0
  });
});

// ── session watermarks ───────────────────────────────────────────────────────

describe("ensureSessionWatermarksTable", () => {
  it("defines fields and index", async () => {
    const db = mockDb();
    await ensureSessionWatermarksTable(db);
    expect(db.query).toHaveBeenCalledTimes(5);
  });
});

describe("getLastWatermark", () => {
  it("returns null when no watermark exists", async () => {
    const db = mockDb([]);
    const result = await getLastWatermark(db, "sk", "u1");
    expect(result).toBeNull();
  });

  it("returns watermark object", async () => {
    const db = mockDb([{
      id: "w1", session_key: "sk", user_id: "u1",
      captured_at: "2024-01-01T00:00:00Z", message_count: 5,
    }]);
    const result = await getLastWatermark(db, "sk", "u1");
    expect(result).toEqual({
      id: "w1", session_key: "sk", user_id: "u1",
      captured_at: "2024-01-01T00:00:00Z", message_count: 5,
    });
  });

  it("converts Date object captured_at to ISO string", async () => {
    const db = mockDb([{
      id: "w1", session_key: "sk", user_id: "u1",
      captured_at: new Date("2024-01-01T00:00:00Z"), message_count: 3,
    }]);
    const result = await getLastWatermark(db, "sk", "u1");
    expect(result!.captured_at).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("createWatermark", () => {
  it("deletes old watermark and creates new", async () => {
    const db = mockDb();
    await createWatermark(db, "sk", "u1", 10);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][0]).toContain("DELETE");
    expect(db.query.mock.calls[1][0]).toContain("CREATE");
  });
});

// ── fetchAllActiveMemoriesForScope ───────────────────────────────────────────

describe("fetchAllActiveMemoriesForScope", () => {
  it("returns mapped memories", async () => {
    const db = mockDb([{
      id: "m1", payload: { l2: "hello", createdAt: "2024-01-01" },
    }]);
    const result = await fetchAllActiveMemoriesForScope(db, "u1", "user");
    expect(result[0].id).toBe("m1");
    expect(result[0].l2).toBe("hello");
  });
});

// ── softArchiveInactiveOlderThan ─────────────────────────────────────────────

describe("softArchiveInactiveOlderThan", () => {
  it("returns 0 when no records match", async () => {
    const db = mockDb([]);
    const count = await softArchiveInactiveOlderThan(db, "u1", "user", "2024-01-01", "memories");
    expect(count).toBe(0);
  });

  it("archives matching records and returns count", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "m1" }, { id: "m2" }]])
        .mockResolvedValueOnce([[]]),
    } as any;
    const count = await softArchiveInactiveOlderThan(db, "u1", "user", "2024-01-01", "memories");
    expect(count).toBe(2);
  });
});

// ── embedding metadata ───────────────────────────────────────────────────────

describe("ensureEmbeddingMetadataTable", () => {
  it("defines fields", async () => {
    const db = mockDb();
    await ensureEmbeddingMetadataTable(db);
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});

describe("getEmbeddingFingerprint", () => {
  it("returns null when no fingerprint exists", async () => {
    const db = mockDb([]);
    const result = await getEmbeddingFingerprint(db);
    expect(result).toBeNull();
  });

  it("returns fingerprint string", async () => {
    const db = mockDb([{ fingerprint: "fp-1" }]);
    const result = await getEmbeddingFingerprint(db);
    expect(result).toBe("fp-1");
  });

  it("returns null when row has no fingerprint", async () => {
    const db = mockDb([{}]);
    const result = await getEmbeddingFingerprint(db);
    expect(result).toBeNull();
  });
});

describe("setEmbeddingFingerprint", () => {
  it("upserts fingerprint", async () => {
    const db = mockDb();
    await setEmbeddingFingerprint(db, "new-fp");
    expect(db.query.mock.calls[0][0]).toContain("UPSERT");
    expect(db.query.mock.calls[0][1].fp).toBe("new-fp");
  });
});

// ── fingerprint cache ────────────────────────────────────────────────────────

describe("getEmbeddingFingerprint — in-process cache", () => {
  it("returns cached value on second call (no extra DB query)", async () => {
    const db = mockDb([{ fingerprint: "fp-cached" }]);
    await getEmbeddingFingerprint(db);
    await getEmbeddingFingerprint(db);
    // Only one DB query despite two calls
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("caches null (fresh-tenant branch) and avoids repeated DB queries", async () => {
    const db = mockDb([]); // no rows → null fingerprint
    const first = await getEmbeddingFingerprint(db);
    const second = await getEmbeddingFingerprint(db);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("re-queries DB after TTL expiry", async () => {
    vi.useFakeTimers();
    try {
      const db = mockDb([{ fingerprint: "fp-old" }]);
      await getEmbeddingFingerprint(db);
      expect(db.query).toHaveBeenCalledTimes(1);

      // Advance past TTL
      vi.advanceTimersByTime(DEFAULT_FINGERPRINT_TTL_MS + 1);

      await getEmbeddingFingerprint(db);
      // Second DB query after expiry
      expect(db.query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates cache on setEmbeddingFingerprint so next read re-queries", async () => {
    const db = mockDb([{ fingerprint: "fp-before" }]);
    // Prime the cache
    await getEmbeddingFingerprint(db);
    expect(db.query).toHaveBeenCalledTimes(1);

    // Set a new fingerprint — should invalidate the entry
    await setEmbeddingFingerprint(db, "fp-after");

    // Next get must hit the DB again
    await getEmbeddingFingerprint(db);
    // 1 (initial get) + 1 (set UPSERT) + 1 (post-invalidation get) = 3
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("caches independently per client instance (no cross-client poisoning)", async () => {
    const dbA = mockDb([{ fingerprint: "fp-a" }]);
    const dbB = mockDb([{ fingerprint: "fp-b" }]);
    const a = await getEmbeddingFingerprint(dbA);
    const b = await getEmbeddingFingerprint(dbB);
    expect(a).toBe("fp-a");
    expect(b).toBe("fp-b");
    // Each client queried exactly once
    expect(dbA.query).toHaveBeenCalledTimes(1);
    expect(dbB.query).toHaveBeenCalledTimes(1);
    // Second call for A should still hit cache, not dbB
    await getEmbeddingFingerprint(dbA);
    expect(dbA.query).toHaveBeenCalledTimes(1);
  });
});

// ── rejection logging ────────────────────────────────────────────────────────

describe("ensureRejectionLogTable", () => {
  it("defines table and fields", async () => {
    const db = mockDb();
    await ensureRejectionLogTable(db);
    expect(db.query).toHaveBeenCalledTimes(7);
  });
});

describe("logRejection", () => {
  it("creates rejection log entry", async () => {
    const db = mockDb();
    await logRejection(db, {
      reason: "low-confidence",
      candidateText: "test",
      confidence: 0.1,
      sessionId: "s1",
      userId: "u1",
    });
    expect(db.query.mock.calls[0][0]).toContain("CREATE rejection_log");
  });

  it("truncates candidate text to 200 chars", async () => {
    const db = mockDb();
    await logRejection(db, {
      reason: "noise",
      candidateText: "x".repeat(300),
      userId: "u1",
    });
    expect(db.query.mock.calls[0][1].text).toHaveLength(200);
  });

  it("swallows errors (fire-and-forget)", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("fail")) } as any;
    await logRejection(db, { reason: "test", candidateText: "x", userId: "u1" });
    // Should not throw
  });
});

// ── ensureMemoryEnrichmentSchema ─────────────────────────────────────────────

describe("ensureMemoryEnrichmentSchema", () => {
  it("runs multi-statement schema query", async () => {
    const db = mockDb();
    await ensureMemoryEnrichmentSchema(db);
    expect(db.query).toHaveBeenCalledTimes(2);
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("payload.category");
    expect(sql).toContain("payload.tier");
    expect(sql).toContain("idx_memories_factKey");
    const semioteSql = db.query.mock.calls[1][0] as string;
    expect(semioteSql).toContain("payload.semiosis");
    expect(semioteSql).toContain("idx_semiote_factKey");
  });
});

// ── supersedeMemory ─────────────────────────────────────────────────────────

describe("supersedeMemory", () => {
  it("throws on global scope without isInternalCaller", async () => {
    const db = mockDb();
    await expect(
      supersedeMemory(
        db,
        { id: "prev-1", l2: "old", similarity: 0.9, createdAt: "2024-01-01" },
        { id: "new-1", text: "new", userId: "u1", embedding: [1, 0], scope: "global", writeSource: "memory_store" },
        "deterministic",
      ),
    ).rejects.toThrow("global scope requires isInternalCaller");
  });

  it("throws when cycle is detected", async () => {
    mockWouldCreateCycle.mockResolvedValueOnce(true);
    const db = mockDb();
    await expect(
      supersedeMemory(
        db,
        { id: "prev-1", l2: "old", similarity: 0.9, createdAt: "2024-01-01" },
        { id: "new-1", text: "new", userId: "u1", embedding: [1, 0], scope: "user", writeSource: "memory_store" },
        "deterministic",
      ),
    ).rejects.toThrow("cycle detected");
  });

  it("succeeds with isInternalCaller for global scope", async () => {
    const db = mockDb();
    await supersedeMemory(
      db,
      { id: "prev-1", l2: "old", similarity: 0.9, createdAt: "2024-01-01" },
      { id: "new-1", text: "new", userId: "u1", embedding: [1, 0], scope: "global", writeSource: "session_summary" },
      "llm-generated",
      true,
    );
    // Should have called upsert and update queries
    expect(db.query).toHaveBeenCalled();
  });

  it("uses previous.id as lineageRootId when previous has no lineageRootId", async () => {
    const db = mockDb();
    await supersedeMemory(
      db,
      { id: "prev-1", l2: "old", similarity: 0.9, createdAt: "2024-01-01" },
      { id: "new-1", text: "new", userId: "u1", embedding: [1, 0], scope: "user", writeSource: "memory_store" },
      "deterministic",
    );
    // FRESH branch: the inlined upsert (sup_ prefix) inside the transaction
    // carries the lineage root. The xxa9 exists-check SELECT precedes BEGIN.
    const [body, vars] = db.queryTransaction.mock.calls[0];
    expect(body).toContain("UPSERT");
    expect((vars as Record<string, unknown>).sup_lineageRootId).toBe("prev-1");
  });

  it("preserves existing lineageRootId from previous", async () => {
    const db = mockDb();
    await supersedeMemory(
      db,
      { id: "prev-1", l2: "old", similarity: 0.9, createdAt: "2024-01-01", lineageRootId: "root-0" },
      { id: "new-1", text: "new", userId: "u1", embedding: [1, 0], scope: "user", writeSource: "memory_store" },
      "deterministic",
    );
    const [body, vars] = db.queryTransaction.mock.calls[0];
    expect(body).toContain("UPSERT");
    expect((vars as Record<string, unknown>).sup_lineageRootId).toBe("root-0");
  });

  it("passes custom inactiveReason", async () => {
    const db = mockDb();
    await supersedeMemory(
      db,
      { id: "prev-1", l2: "old", similarity: 0.9, createdAt: "2024-01-01" },
      { id: "new-1", text: "new", userId: "u1", embedding: [1, 0], scope: "user", writeSource: "memory_store" },
      "deterministic",
      false,
      "consolidation-dedup",
    );
    // The previous-row inactivation runs inside the transaction with the custom reason.
    const [body, vars] = db.queryTransaction.mock.calls[0];
    expect(body).toContain("inactive_reason");
    expect((vars as Record<string, unknown>).inactiveReason).toBe("consolidation-dedup");
  });
});

// ── findSimilarMemories fallback paths ──────────────────────────────────────

describe("findSimilarMemories — fallback paths", () => {
  it("handles missing payload fields gracefully", async () => {
    const db = mockDb([{
      id: "m1", payload: null, sim: null,
      scope: null, session_id: null, lineage_root_id: null,
    }]);
    const result = await findSimilarMemories(db, "u1", [1], 24, 10);
    expect(result[0].l2).toBe("");
    expect(result[0].similarity).toBe(0);
  });

  it("handles no scope parameter (undefined)", async () => {
    const db = mockDb([]);
    await findSimilarMemories(db, "u1", [1], 24, 10);
    const sql = db.query.mock.calls[0][0] as string;
    // No scope clause added
    expect(sql).not.toContain("AND scope = $scope");
  });
});

// ── getMemoryLineage fallback ──────────────────────────────────────────────

describe("getMemoryLineage — seed without lineage_root_id", () => {
  it("uses extractId(seed.id) as lineageRootId when lineage_root_id is null", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "memories:m1", lineage_root_id: null, payload: {} }]])
        .mockResolvedValueOnce([[{ id: "memories:m1", payload: { l2: "only" }, active: true }]]),
    } as any;

    const result = await getMemoryLineage(db, "m1", "u1", "memories");
    expect(result).toHaveLength(1);
    // The second query should use extractId("memories:m1") = "m1" as lineageRootId
    expect(db.query.mock.calls[1][1].lineageRootId).toBe("m1");
  });
});
