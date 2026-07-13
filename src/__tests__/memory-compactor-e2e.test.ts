/**
 * MIM-55: memory-compactor runCompaction() end-to-end tests.
 * Tests dry-run, scan limit, full cycle, fire-and-forget safety, and disabled/cooldown states.
 */
import { describe, it, expect, vi } from "vitest";
import { runCompaction, type CompactionConfig } from "../lifecycle/compaction/memory-compactor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: CompactionConfig = {
  enabled: true,
  minAgeDays: 7,
  similarityThreshold: 0.88,
  minClusterSize: 2,
  maxMemoriesToScan: 200,
  dryRun: false,
  cooldownHours: 24,
};

const DRY_RUN_CONFIG: CompactionConfig = { ...BASE_CONFIG, dryRun: true };
const DISABLED_CONFIG: CompactionConfig = { ...BASE_CONFIG, enabled: false };

/** Creates similar 3D embeddings — cosine similarity > 0.99 */
function makeSimilarEmbedding(i: number): number[] {
  return [1, 0.001 * i, 0];
}

function makeMemoryRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: { id: `mem-${i}` },
    embedding: makeSimilarEmbedding(i),
    payload: {
      l2: `Memory entry ${i} about user preferences`,
      userId: "user1",
      confidence: 0.9,
      category: "preferences",
      tags: ["test"],
    },
  }));
}

const mockLogger = { warn: vi.fn() };

/**
 * Creates a mock DB for runCompaction.
 * runCompaction calls in order:
 *   1. isCooldownActive → SELECT from compaction_state
 *   2. fetchForCompaction → SELECT from memories
 *   3+ (dryRun=false only): UPSERT merged memory, UPDATE sources, UPSERT cooldown
 */
function makeMockDb(memoryRows?: any[], cooldownRows?: any[]) {
  const queryMock = vi.fn();
  queryMock
    .mockResolvedValueOnce([cooldownRows ?? []])  // isCooldownActive
    .mockResolvedValueOnce([memoryRows ?? []])     // fetchForCompaction
    .mockResolvedValue([[]])                        // all subsequent (writes, cooldown update)
  ;
  return { query: queryMock };
}

function makeEmbedder() {
  return {
    embedDocument: vi.fn().mockResolvedValue([0.5, 0.5, 0.5]),
  };
}

// ---------------------------------------------------------------------------
// disabled compaction
// ---------------------------------------------------------------------------
describe("disabled compaction", () => {
  it("config.enabled=false: returns null without any DB queries", async () => {
    const db = { query: vi.fn() };
    const result = await runCompaction(db, makeEmbedder(), DISABLED_CONFIG, "user1", mockLogger);
    expect(result).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cooldown active
// ---------------------------------------------------------------------------
describe("cooldown active", () => {
  it("recent lastRunAt within cooldownHours: returns null", async () => {
    const recentRun = new Date(Date.now() - 1 * 3600_000).toISOString(); // 1 hour ago
    const db = { query: vi.fn().mockResolvedValue([[{ lastRunAt: recentRun }]]) };
    const result = await runCompaction(db, makeEmbedder(), { ...BASE_CONFIG, cooldownHours: 24 }, "user1", mockLogger);
    expect(result).toBeNull();
  });

  it("old lastRunAt past cooldownHours: proceeds normally", async () => {
    const oldRun = new Date(Date.now() - 48 * 3600_000).toISOString(); // 48 hours ago
    const rows = makeMemoryRows(4);
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ lastRunAt: oldRun }]])  // isCooldownActive
        .mockResolvedValueOnce([rows])                     // fetchForCompaction
        .mockResolvedValue([[]])                           // writes
    };
    const result = await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dry-run mode
// ---------------------------------------------------------------------------
describe("dry-run mode", () => {
  it("returns stats with memoriesMerged > 0 for 4 similar memories", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    const result = await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);
    expect(result).not.toBeNull();
    expect(result!.memoriesMerged).toBeGreaterThan(0);
    expect(result!.memoriesCreated).toBeGreaterThan(0);
    expect(result!.dryRun).toBe(true);
  });

  it("dry-run: NO memory UPSERT queries executed (only cooldown state UPSERT allowed)", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);
    // In dry-run, no memory records should be upserted — only compaction_state may be updated
    const memoryUpsertCalls = (db.query as any).mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("UPSERT") && call[0].includes("memories"),
    );
    expect(memoryUpsertCalls).toHaveLength(0);
  });

  it("dry-run: still executes the cooldown and fetch SELECT queries", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);

    expect((db.query as any).mock.calls).toHaveLength(3);
    expect((db.query as any).mock.calls[0][0]).toContain("SELECT lastRunAt FROM compaction_state");
    expect((db.query as any).mock.calls[1][0]).toContain("SELECT id, embedding, payload, created_at FROM memories");
    expect((db.query as any).mock.calls[2][0]).toContain("UPSERT type::record('compaction_state', $userId)");
  });

  it("dry-run: NO UPDATE active=false queries executed", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);
    const updateCalls = (db.query as any).mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("active = false"),
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("dry-run: scanned count matches number of rows returned by DB", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    const result = await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);
    expect(result!.scanned).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// scan limit
// ---------------------------------------------------------------------------
describe("scan limit", () => {
  it("maxMemoriesToScan=10: LIMIT $limit param in fetchForCompaction is 10", async () => {
    const db = makeMockDb([]);
    await runCompaction(db, makeEmbedder(), { ...DRY_RUN_CONFIG, maxMemoriesToScan: 10 }, "user1", mockLogger);
    // Second call is fetchForCompaction
    const fetchCall = (db.query as any).mock.calls[1];
    expect(fetchCall[1]).toMatchObject({ limit: 10 });
  });

  it("maxMemoriesToScan=3: at most 3 memories processed", async () => {
    const rows = makeMemoryRows(3);
    const db = makeMockDb(rows);
    const result = await runCompaction(db, makeEmbedder(), { ...DRY_RUN_CONFIG, maxMemoriesToScan: 3 }, "user1", mockLogger);
    expect(result!.scanned).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// full cycle (dryRun=false)
// ---------------------------------------------------------------------------
describe("full cycle — dryRun=false", () => {
  it("4 similar memories: returns stats with clustersFound >= 1", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    const result = await runCompaction(db, makeEmbedder(), BASE_CONFIG, "user1", mockLogger);
    expect(result).not.toBeNull();
    expect(result!.clustersFound).toBeGreaterThanOrEqual(1);
    expect(result!.memoriesMerged).toBeGreaterThan(0);
  });

  it("UPSERT query executed for merged memory", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    await runCompaction(db, makeEmbedder(), BASE_CONFIG, "user1", mockLogger);
    const upsertCalls = (db.query as any).mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("UPSERT"),
    );
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("UPDATE active=false executed for source memories", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    await runCompaction(db, makeEmbedder(), BASE_CONFIG, "user1", mockLogger);
    const inactivateCalls = (db.query as any).mock.calls.filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("active = false"),
    );
    expect(inactivateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("embedder.embedDocument called once per cluster merged", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    const embedder = makeEmbedder();
    const result = await runCompaction(db, embedder, BASE_CONFIG, "user1", mockLogger);
    expect(result?.clustersFound).toBe(1);
    expect(embedder.embedDocument).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// fire-and-forget safety
// ---------------------------------------------------------------------------
describe("fire-and-forget safety", () => {
  it("db.query throws: runCompaction returns null, does NOT throw", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("DB connection error")) };
    const result = await runCompaction(db, makeEmbedder(), BASE_CONFIG, "user1", mockLogger);
    expect(result).toBeNull();
  });

  it("embedder.embedDocument throws: runCompaction returns null, does NOT throw", async () => {
    const rows = makeMemoryRows(4);
    const db = makeMockDb(rows);
    const badEmbedder = { embedDocument: vi.fn().mockRejectedValue(new Error("embedder offline")) };
    const result = await runCompaction(db, badEmbedder, BASE_CONFIG, "user1", mockLogger);
    expect(result).toBeNull();
  });

  it("logger.warn called on failure (caller gets notification)", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("DB error")) };
    const logger = { warn: vi.fn() };
    await runCompaction(db, makeEmbedder(), BASE_CONFIG, "user1", logger);
    expect(logger.warn).toHaveBeenCalled();
    const msg: string = logger.warn.mock.calls[0][0];
    expect(msg).toContain("error");
  });
});

// ---------------------------------------------------------------------------
// too few memories for compaction
// ---------------------------------------------------------------------------
describe("insufficient memories", () => {
  it("only 1 memory (below minClusterSize=2): returns stats with 0 clusters", async () => {
    const rows = makeMemoryRows(1);
    const db = makeMockDb(rows);
    const result = await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);
    expect(result).not.toBeNull();
    expect(result!.clustersFound).toBe(0);
    expect(result!.memoriesMerged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchForCompaction edge cases (row parsing fallbacks)
// ---------------------------------------------------------------------------
import { fetchForCompaction } from "../lifecycle/compaction/memory-compactor.js";

describe("fetchForCompaction row parsing", () => {
  it("handles string ID (not object)", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[
        {
          id: "memories:mem-str",
          embedding: [1, 0, 0],
          payload: { l2: "some text", confidence: 0.9, category: "preferences", tags: ["t1"] },
        },
      ]]),
    };
    const result = await fetchForCompaction(db, "user1", "2020-01-01T00:00:00Z", 10);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mem-str");
  });

  it("handles missing payload fields with defaults", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[
        {
          id: { id: "mem-1" },
          embedding: [1, 0, 0],
          payload: {},  // no data, confidence, category, or tags
        },
      ]]),
    };
    const result = await fetchForCompaction(db, "user1", "2020-01-01T00:00:00Z", 10);
    expect(result[0].text).toBe("");
    expect(result[0].confidence).toBe(0.5);
    expect(result[0].category).toBe("cases");
    expect(result[0].tags).toEqual([]);
  });

  it("handles non-array embedding", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[
        {
          id: { id: "mem-1" },
          embedding: "not-an-array",
          payload: { l2: "text", confidence: 0.9, category: "preferences", tags: [] },
        },
      ]]),
    };
    const result = await fetchForCompaction(db, "user1", "2020-01-01T00:00:00Z", 10);
    expect(result[0].embedding).toEqual([]);
  });

  it("handles null payload", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[
        {
          id: { id: "mem-1" },
          embedding: [1, 0],
          payload: null,
        },
      ]]),
    };
    const result = await fetchForCompaction(db, "user1", "2020-01-01T00:00:00Z", 10);
    expect(result[0].text).toBe("");
    expect(result[0].tags).toEqual([]);
  });

  it("handles empty outer results array", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([]),
    };
    const result = await fetchForCompaction(db, "user1", "2020-01-01T00:00:00Z", 10);
    expect(result).toEqual([]);
  });

  it("handles non-array tags in payload", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[
        {
          id: { id: "mem-1" },
          embedding: [1, 0],
          payload: { l2: "text", confidence: 0.8, category: "profile", tags: "not-array" },
        },
      ]]),
    };
    const result = await fetchForCompaction(db, "user1", "2020-01-01T00:00:00Z", 10);
    expect(result[0].tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cooldown edge cases
// ---------------------------------------------------------------------------
describe("cooldown edge cases", () => {
  it("cooldown row exists but lastRunAt is null: proceeds normally", async () => {
    const rows = makeMemoryRows(4);
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ lastRunAt: null }]])  // isCooldownActive — lastRunAt null
        .mockResolvedValueOnce([rows])                    // fetchForCompaction
        .mockResolvedValue([[]])                          // writes
    };
    const result = await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);
    expect(result).not.toBeNull();
    expect(result!.scanned).toBe(4);
  });

  it("cooldown query returns empty outer array: proceeds normally", async () => {
    const rows = makeMemoryRows(4);
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([])       // isCooldownActive — empty outer results
        .mockResolvedValueOnce([rows])   // fetchForCompaction
        .mockResolvedValue([[]])         // writes
    };
    const result = await runCompaction(db, makeEmbedder(), DRY_RUN_CONFIG, "user1", mockLogger);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// non-Error throw in catch block
// ---------------------------------------------------------------------------
describe("non-Error throw handling", () => {
  it("non-Error thrown: logs String(err), returns null", async () => {
    const db = { query: vi.fn().mockRejectedValue("string error") };
    const logger = { warn: vi.fn() };
    const result = await runCompaction(db, makeEmbedder(), BASE_CONFIG, "user1", logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain("string error");
  });
});
