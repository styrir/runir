import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock dynamic imports ─────────────────────────────────────────────────────

const mockAcquireLock = vi.fn();
const mockExtendLock = vi.fn();
const mockReleaseLock = vi.fn();
const mockRunStalenessCoreNoLock = vi.fn();
const mockFetchAllActiveMemoriesForScope = vi.fn();
const mockSoftArchiveInactiveOlderThan = vi.fn();
const mockSupersedeMemory = vi.fn();
const mockPromoteSessionEntities = vi.fn();

vi.mock("../lifecycle/semion/lock.js", () => ({
  acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
  extendLock: (...args: unknown[]) => mockExtendLock(...args),
  releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
  ensureStalenessBacklogTable: vi.fn(),
}));

vi.mock("../lifecycle/semion/staleness-pass.js", () => ({
  runStalenessCoreNoLock: (...args: unknown[]) => mockRunStalenessCoreNoLock(...args),
}));

vi.mock("../storage/surreal/surreal-store.js", () => ({
  fetchAllActiveMemoriesForScope: (...args: unknown[]) => mockFetchAllActiveMemoriesForScope(...args),
  softArchiveInactiveOlderThan: (...args: unknown[]) => mockSoftArchiveInactiveOlderThan(...args),
  supersedeMemory: (...args: unknown[]) => mockSupersedeMemory(...args),
}));

vi.mock("../lifecycle/semion/entity-consolidation.js", () => ({
  promoteSessionEntities: (...args: unknown[]) => mockPromoteSessionEntities(...args),
}));

import {
  ensureConsolidationLogTable,
  ensureConsolidationStateTable,
  ensureDedupStateTable,
  runConsolidationForScope,
  startConsolidationScheduler,
} from "../lifecycle/semion/consolidation";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}

function embedText(text: string): Promise<number[]> {
  // Deterministic embeddings: use large spread to avoid accidental high cosine
  const hash = text.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  // Use 10-dim vectors with hash-rotated basis to minimize collisions
  const vec = new Array(10).fill(0);
  vec[hash % 10] = 1;
  vec[(hash * 7 + 3) % 10] = 0.5;
  return Promise.resolve(vec);
}

// Embed function that always returns identical vectors (for dedup testing)
function identicalEmbedText(_text: string): Promise<number[]> {
  return Promise.resolve([1, 0, 0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireLock.mockResolvedValue("holder-uuid");
  mockExtendLock.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);
  mockFetchAllActiveMemoriesForScope.mockResolvedValue([]);
  mockSoftArchiveInactiveOlderThan.mockResolvedValue(0);
  mockSupersedeMemory.mockResolvedValue(undefined);
  mockRunStalenessCoreNoLock.mockResolvedValue(undefined);
  mockPromoteSessionEntities.mockResolvedValue({ promoted: 0, merged: 0 });
});

// ── run_status values ────────────────────────────────────────────────────────

const VALID_RUN_STATUSES = ["completed", "skipped_lock", "skipped_no_sessions", "failed"];

describe("consolidation_log run_status values", () => {
  it("defines all required run_status values", () => {
    expect(VALID_RUN_STATUSES).toContain("completed");
    expect(VALID_RUN_STATUSES).toContain("skipped_lock");
    expect(VALID_RUN_STATUSES).toContain("skipped_no_sessions");
    expect(VALID_RUN_STATUSES).toContain("failed");
    expect(VALID_RUN_STATUSES).toHaveLength(4);
  });
});

// ── ensureConsolidationLogTable ──────────────────────────────────────────────

describe("ensureConsolidationLogTable", () => {
  it("runs all schema definition queries", async () => {
    const db = mockDb();
    await ensureConsolidationLogTable(db);
    // Table + 13 fields + 2 indexes (idx_clog_user_scope + idx_clog_completed_at).
    // The 12th field is continuity_built_count (Rúnir-78sy.3); the 13th is
    // continuity_gaps_count (Rúnir-78sy.4).
    expect(db.query).toHaveBeenCalledTimes(16);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DEFINE TABLE"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("user_id"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("idx_clog_user_scope"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("idx_clog_completed_at"));
  });
});

// ── ensureConsolidationStateTable ────────────────────────────────────────────

describe("ensureConsolidationStateTable", () => {
  it("runs all schema definition queries", async () => {
    const db = mockDb();
    await ensureConsolidationStateTable(db);
    // Should define table + 3 fields + 1 index = 5 queries
    expect(db.query).toHaveBeenCalledTimes(6);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DEFINE TABLE"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("consolidation_state"));
  });
});

// ── ensureDedupStateTable ────────────────────────────────────────────────────

describe("ensureDedupStateTable", () => {
  it("runs all schema definition queries", async () => {
    const db = mockDb();
    await ensureDedupStateTable(db);
    // table + 4 fields + 1 unique index = 6 queries
    expect(db.query).toHaveBeenCalledTimes(6);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DEFINE TABLE IF NOT EXISTS dedup_state"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("swept_through"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("idx_ds_user_scope"));
  });
});

// ── runConsolidationForScope ─────────────────────────────────────────────────

describe("runConsolidationForScope", () => {
  it("returns skipped_lock when lock cannot be acquired", async () => {
    mockAcquireLock.mockResolvedValue(null);
    const db = mockDb();
    const logger = vi.fn();
    const result = await runConsolidationForScope(
      db, "user1", "user", embedText, new Map(), "api-key", logger,
    );
    expect(result.status).toBe("skipped_lock");
    expect(result.deduped).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("lock held"));
  });

  it("completes with zero changes when no memories exist", async () => {
    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key",
    );
    expect(result.status).toBe("completed");
    expect(result.deduped).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.backlogReplayed).toBe(0);
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it("deduplicates memories with cosine >= 0.90", async () => {
    // Return two memories with identical text (will have cos=1.0 with identicalEmbedText)
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      { id: "mem-1", text: "hello world", similarity: 1, createdAt: "2024-01-01T00:00:00Z" },
      { id: "mem-2", text: "hello world", similarity: 1, createdAt: "2024-01-02T00:00:00Z" },
    ]);

    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "session", identicalEmbedText, new Map(), "api-key",
    );
    expect(result.deduped).toBe(1);
    expect(mockSupersedeMemory).toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  it("does not dedup when cosine < 0.90", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      { id: "mem-1", text: "aaa", similarity: 1, createdAt: "2024-01-01T00:00:00Z" },
      { id: "mem-2", text: "zzz", similarity: 1, createdAt: "2024-01-02T00:00:00Z" },
    ]);

    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key",
    );
    expect(result.deduped).toBe(0);
    expect(mockSupersedeMemory).not.toHaveBeenCalled();
  });

  it("handles dedup errors gracefully", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      { id: "mem-1", text: "hello", similarity: 1, createdAt: "2024-01-01T00:00:00Z" },
      { id: "mem-2", text: "hello", similarity: 1, createdAt: "2024-01-02T00:00:00Z" },
    ]);
    mockSupersedeMemory.mockRejectedValue(new Error("db error"));

    const db = mockDb();
    const logger = vi.fn();
    const result = await runConsolidationForScope(
      db, "user1", "session", identicalEmbedText, new Map(), "api-key", logger,
    );
    expect(result.deduped).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("dedup error"));
  });

  it("fetches the dedup snapshot in a single query (atomic — no page-boundary skips)", async () => {
    const batch1 = Array.from({ length: 50 }, (_, i) => ({
      id: `mem-${i}`, text: `text-${i}`, similarity: 1, createdAt: "2024-01-01T00:00:00Z",
    }));
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce(batch1);

    const db = mockDb();
    await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key",
    );
    expect(mockFetchAllActiveMemoriesForScope).toHaveBeenCalledTimes(1);
    expect(mockFetchAllActiveMemoriesForScope).toHaveBeenCalledWith(db, "user1", "session", 100000, 0, "semiote");
  });

  it("archives old inactive memories", async () => {
    mockSoftArchiveInactiveOlderThan.mockResolvedValue(5);
    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key",
    );
    expect(result.archived).toBe(5);
  });

  it("replays staleness backlog entries", async () => {
    const db = mockDb();
    // First query returns empty memories, then backlog entries
    db.query
      .mockResolvedValueOnce([[]]) // consolidation_log (from logConsolidationRun... no, query ordering)
      .mockResolvedValue([[]]); // default

    // We need to handle the backlog query specifically
    // The third query in the function is the backlog SELECT
    const backlogEntries = [
      { id: "bl-1", facts: [{ text: "fact", confidence: 0.9, replacementMemoryId: "r1" }], session_id: "sess-1" },
    ];
    // fetchAllActiveMemoriesForScope returns empty, softArchive returns 0
    // Then db.query for backlog should return entries
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT")) {
        return Promise.resolve([backlogEntries]);
      }
      return Promise.resolve([[]]);
    });

    const result = await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key",
    );
    expect(result.backlogReplayed).toBe(1);
    expect(mockRunStalenessCoreNoLock).toHaveBeenCalled();
    // Tick-path replay scans PRIMARY_MEMORY_TABLE; locks symmetry with the
    // startup catch-up path (Rúnir-6btb).
    expect(mockRunStalenessCoreNoLock).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: "semiote" }),
    );
  });

  it("handles backlog replay errors and marks as failed", async () => {
    mockRunStalenessCoreNoLock.mockRejectedValue(new Error("staleness fail"));
    const db = mockDb();
    const backlogEntries = [
      { id: "bl-1", facts: [], session_id: null },
    ];
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT")) {
        return Promise.resolve([backlogEntries]);
      }
      return Promise.resolve([[]]);
    });

    const logger = vi.fn();
    const result = await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key", logger,
    );
    expect(result.backlogReplayed).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("backlog replay error"));
  });

  it("runs the stored-memory staleness pass over new-since-watermark rows with tableName semiote (D1 relocation, Rúnir-y5on/Rúnir-sq3s)", async () => {
    // Session-end no longer runs runStalenessPass — the relocated stored-memory
    // pass feeds the rows written since the last dedup sweep as the "new facts"
    // and MUST pass tableName:"semiote" explicitly (the staleness helpers
    // default to the legacy "memories" table). Orthogonal embeddings keep the
    // dedup sweep from merging the two rows away first.
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      { id: "recent-1", l2: "Brooks switched the runir repo to pnpm", similarity: 0, createdAt: "2026-07-01T00:00:00.000Z", embedding: [1, 0, 0] },
      { id: "recent-2", l2: "The extractor model is gemini flash-lite", similarity: 0, createdAt: "2026-07-02T00:00:00.000Z", embedding: [0, 1, 0] },
    ]);
    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "user", embedText, new Map(), "api-key",
    );

    expect(result.status).toBe("completed");
    // Exactly ONE staleness call: the stored-memory pass (no backlog rows).
    expect(mockRunStalenessCoreNoLock).toHaveBeenCalledTimes(1);
    const args = mockRunStalenessCoreNoLock.mock.calls[0][0] as any;
    expect(args.tableName).toBe("semiote");
    expect(args.userId).toBe("user1");
    expect(args.scope).toBe("user");
    expect(args.apiKey).toBe("api-key");
    expect(args.facts).toEqual([
      expect.objectContaining({ text: "Brooks switched the runir repo to pnpm", replacementMemoryId: "recent-1" }),
      expect.objectContaining({ text: "The extractor model is gemini flash-lite", replacementMemoryId: "recent-2" }),
    ]);
  });

  it("does not feed unswept rows to the stored-memory staleness pass on a partial (budget-exhausted) sweep", async () => {
    // Codex re-review finding #1: a budget-exhausted sweep parks the dedup
    // watermark BEFORE firstUnsweptW — feeding the unswept tail would re-feed
    // the same rows on the next run. With a 0ms budget nothing is swept
    // (sweptThrough stays null), so the staleness pass must not fire at all.
    const priorBudget = process.env.CONSOLIDATION_DEDUP_BUDGET_MS;
    process.env.CONSOLIDATION_DEDUP_BUDGET_MS = "0";
    try {
      mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
        { id: "recent-1", l2: "An unswept row that must not feed staleness yet", similarity: 0, createdAt: "2026-07-01T00:00:00.000Z", embedding: [1, 0, 0] },
        { id: "recent-2", l2: "Another unswept row behind the parked watermark", similarity: 0, createdAt: "2026-07-02T00:00:00.000Z", embedding: [0, 1, 0] },
      ]);
      const db = mockDb();
      const result = await runConsolidationForScope(
        db, "user1", "user", embedText, new Map(), "api-key",
      );

      expect(result.status).toBe("completed");
      expect(mockRunStalenessCoreNoLock).not.toHaveBeenCalled();
    } finally {
      if (priorBudget === undefined) delete process.env.CONSOLIDATION_DEDUP_BUDGET_MS;
      else process.env.CONSOLIDATION_DEDUP_BUDGET_MS = priorBudget;
    }
  });

  it("skips the stored-memory staleness pass for the global scope", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      { id: "recent-1", l2: "A global-scope row that must not feed staleness", similarity: 0, createdAt: "2026-07-01T00:00:00.000Z", embedding: [1, 0, 0] },
    ]);
    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "global", embedText, new Map(), "api-key",
    );

    expect(result.status).toBe("completed");
    expect(mockRunStalenessCoreNoLock).not.toHaveBeenCalled();
  });

  it("runs entity consolidation for 'user' scope", async () => {
    const db = mockDb();
    await runConsolidationForScope(
      db, "user1", "user", embedText, new Map(), "api-key", vi.fn(),
    );
    expect(mockPromoteSessionEntities).toHaveBeenCalledWith(db, "user1", expect.any(Function));
  });

  it("skips entity consolidation for non-user scopes", async () => {
    const db = mockDb();
    await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key",
    );
    expect(mockPromoteSessionEntities).not.toHaveBeenCalled();
  });

  it("handles entity consolidation errors gracefully", async () => {
    mockPromoteSessionEntities.mockRejectedValue(new Error("entity fail"));
    const db = mockDb();
    const logger = vi.fn();
    const result = await runConsolidationForScope(
      db, "user1", "user", embedText, new Map(), "api-key", logger,
    );
    expect(result.status).toBe("completed");
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("entity consolidation error"));
  });

  it("invalidates BM25 stats cache", async () => {
    const statsCache = new Map([["user1", { avgDl: 10, docCount: 5, df: {} }]]);
    const db = mockDb();
    await runConsolidationForScope(
      db, "user1", "session", embedText, statsCache as any, "api-key",
    );
    expect(statsCache.has("user1")).toBe(false);
  });

  it("releases lock even on failure", async () => {
    mockFetchAllActiveMemoriesForScope.mockRejectedValue(new Error("crash"));
    const db = mockDb();
    const logger = vi.fn();
    const result = await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key", logger,
    );
    expect(result.status).toBe("failed");
    expect(mockReleaseLock).toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("consolidation failed"));
  });

  it("keeps older memory as the one superseded in dedup", async () => {
    // mem-2 is older, mem-1 is newer
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      { id: "mem-1", text: "same", similarity: 1, createdAt: "2024-06-01T00:00:00Z" },
      { id: "mem-2", text: "same", similarity: 1, createdAt: "2024-01-01T00:00:00Z" },
    ]);

    const db = mockDb();
    await runConsolidationForScope(
      db, "user1", "session", identicalEmbedText, new Map(), "api-key",
    );
    // The first arg to supersedeMemory should be the older memory (mem-2)
    const call = mockSupersedeMemory.mock.calls[0];
    expect(call[1].id).toBe("mem-2"); // older
    expect(call[2].id).toBe("mem-1"); // newer
  });
});

// ── startConsolidationScheduler ──────────────────────────────────────────────

describe("startConsolidationScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a stop function that clears the interval", async () => {
    const db = mockDb();
    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key",
    );
    expect(typeof stop).toBe("function");
    stop(); // Should not throw
  });

  it("runs startup catch-up and skips users with too few sessions", async () => {
    const db = mockDb();
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("GROUP BY") && sql.includes("userId")) {
        return Promise.resolve([[{ userId: "user1" }]]);
      }
      if (sql.includes("consolidation_state")) {
        return Promise.resolve([[]]); // no previous state
      }
      if (sql.includes("session_watermarks")) {
        return Promise.resolve([[{ count: 1 }]]); // too few sessions
      }
      return Promise.resolve([[]]);
    });

    const logger = vi.fn();
    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key", logger,
    );
    stop();
    // Should not have called runConsolidationForScope (user not eligible)
    expect(mockAcquireLock).not.toHaveBeenCalled();
    // Ineligibility is a logger line, NOT a consolidation_log row (xxa9 spam fix)
    const logRowWrites = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("CREATE consolidation_log"),
    );
    expect(logRowWrites).toHaveLength(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("1/5 new sessions"));
  });

  it("handles startup backlog replay", async () => {
    const db = mockDb();
    const backlogEntry = {
      id: "bl-1",
      user_id: "user1",
      scope: "user",
      session_id: null,
      facts: [{ text: "fact", confidence: 0.9, replacementMemoryId: "r1" }],
    };
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT")) {
        const result = [backlogEntry];
        // Only return entries once
        db.query = vi.fn().mockResolvedValue([[]]);
        return Promise.resolve([result]);
      }
      return Promise.resolve([[]]);
    });

    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key",
    );
    stop();
    expect(mockRunStalenessCoreNoLock).toHaveBeenCalled();
  });

  it("startup backlog replay targets the semiote table, not the legacy 'memories' default (Rúnir-6btb)", async () => {
    const db = mockDb();
    const backlogEntry = {
      id: "bl-1",
      user_id: "user1",
      scope: "user",
      session_id: null,
      facts: [{ text: "fact", confidence: 0.9, replacementMemoryId: "r1" }],
    };
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT")) {
        db.query = vi.fn().mockResolvedValue([[]]);
        return Promise.resolve([[backlogEntry]]);
      }
      return Promise.resolve([[]]);
    });

    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key",
    );
    stop();
    // The startup catch-up must scan PRIMARY_MEMORY_TABLE ("semiote"), matching the
    // tick path — omitting tableName silently falls back to the legacy "memories" table.
    expect(mockRunStalenessCoreNoLock).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: "semiote" }),
    );
  });

  it("handles startup backlog lock contention", async () => {
    mockAcquireLock.mockResolvedValue(null);
    const db = mockDb();
    const backlogEntry = {
      id: "bl-1", user_id: "user1", scope: "user", session_id: null, facts: [],
    };
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT")) {
        db.query = vi.fn().mockResolvedValue([[]]);
        return Promise.resolve([[backlogEntry]]);
      }
      return Promise.resolve([[]]);
    });

    const logger = vi.fn();
    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key", logger,
    );
    stop();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("startup backlog replay skipped"));
  });

  it("handles startup backlog replay errors", async () => {
    mockAcquireLock.mockResolvedValue("holder");
    mockRunStalenessCoreNoLock.mockRejectedValue(new Error("replay fail"));
    const db = mockDb();
    const backlogEntry = {
      id: "bl-1", user_id: "user1", scope: "user", session_id: "s1", facts: [],
    };
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT")) {
        db.query = vi.fn().mockResolvedValue([[]]);
        return Promise.resolve([[backlogEntry]]);
      }
      return Promise.resolve([[]]);
    });

    const logger = vi.fn();
    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key", logger,
    );
    stop();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("startup backlog replay error"));
  });

  it("handles startup query errors", async () => {
    const db = mockDb();
    db.query = vi.fn().mockRejectedValue(new Error("db down"));

    const logger = vi.fn();
    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key", logger,
    );
    stop();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("startup backlog query error"));
  });

  it("runs consolidation for eligible users and advances state", async () => {
    const db = mockDb();
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT") && !sql.includes("WHERE user_id")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("GROUP BY") && sql.includes("userId")) {
        return Promise.resolve([[{ userId: "user1" }]]);
      }
      if (sql.includes("consolidation_state") && sql.includes("SELECT")) {
        return Promise.resolve([[]]); // no previous state → eligible
      }
      if (sql.includes("session_watermarks") && sql.includes("count")) {
        return Promise.resolve([[{ count: 10 }]]); // enough sessions
      }
      return Promise.resolve([[]]);
    });

    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key", vi.fn(),
    );
    stop();
    // Should have acquired lock (ran consolidation for user1)
    expect(mockAcquireLock).toHaveBeenCalled();
  });

  it("interval tick runs eligible users", async () => {
    vi.useFakeTimers();
    const db = mockDb();
    let tickCount = 0;
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT") && !sql.includes("WHERE user_id")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("GROUP BY") && sql.includes("userId")) {
        // Return a user only on the interval tick
        if (tickCount > 0) {
          return Promise.resolve([[{ userId: "tick-user" }]]);
        }
        return Promise.resolve([[]]);
      }
      if (sql.includes("consolidation_state") && sql.includes("SELECT")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("session_watermarks") && sql.includes("count")) {
        return Promise.resolve([[{ count: 10 }]]);
      }
      return Promise.resolve([[]]);
    });

    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 1000, "api-key",
    );
    tickCount++;
    await vi.advanceTimersByTimeAsync(1100);
    stop();
    // The tick should have triggered consolidation
    expect(mockAcquireLock).toHaveBeenCalled();
  });

  it("interval tick handles errors gracefully", async () => {
    vi.useFakeTimers();
    const db = mockDb();
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT") && !sql.includes("WHERE user_id")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("GROUP BY")) {
        return Promise.reject(new Error("tick error"));
      }
      return Promise.resolve([[]]);
    });

    const logger = vi.fn();
    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 1000, "api-key", logger,
    );
    await vi.advanceTimersByTimeAsync(1100);
    stop();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("consolidation tick error"));
  });

  it("skips user with recent consolidation run", async () => {
    const db = mockDb();
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT") && !sql.includes("WHERE user_id")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("GROUP BY") && sql.includes("userId")) {
        return Promise.resolve([[{ userId: "user1" }]]);
      }
      if (sql.includes("consolidation_state") && sql.includes("SELECT")) {
        // Recent run — less than MIN_HOURS ago
        return Promise.resolve([[{ last_run_at: new Date().toISOString(), session_count_at_last_run: 5 }]]);
      }
      return Promise.resolve([[]]);
    });

    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key",
    );
    stop();
    // Should not have run consolidation
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("runForUser handles scope-level errors without aborting other scopes", async () => {
    const db = mockDb();
    // Make the first scope fail but others succeed
    let scopeCallCount = 0;
    mockAcquireLock.mockImplementation(async () => {
      scopeCallCount++;
      if (scopeCallCount === 1) throw new Error("scope fail");
      return "holder-uuid";
    });

    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT") && !sql.includes("WHERE user_id")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("GROUP BY") && sql.includes("userId")) {
        return Promise.resolve([[{ userId: "user1" }]]);
      }
      if (sql.includes("consolidation_state") && sql.includes("SELECT")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("session_watermarks") && sql.includes("count")) {
        return Promise.resolve([[{ count: 10 }]]);
      }
      return Promise.resolve([[]]);
    });

    const logger = vi.fn();
    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key", logger,
    );
    stop();
    // Logger should have recorded the scope error
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("consolidation error"));
  });

  it("handles eligible users startup catch-up error", async () => {
    const db = mockDb();
    let callCount = 0;
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog")) return Promise.resolve([[]]);
      if (sql.includes("GROUP BY")) {
        return Promise.reject(new Error("catch-up fail"));
      }
      return Promise.resolve([[]]);
    });

    const logger = vi.fn();
    const stop = await startConsolidationScheduler(
      db, embedText, new Map(), 60000, "api-key", logger,
    );
    stop();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("consolidation startup catch-up error"));
  });
});

// ── Rúnir-x46j: bounded incremental dedup + lock heartbeat + tick guard ──────

describe("x46j: incremental budgeted dedup sweep", () => {
  const ROWS = {
    old1: { id: "old-1", l2: "alpha fact", similarity: 0, createdAt: "2024-01-01T00:00:00.000Z", embedding: [1, 0, 0] },
    old2: { id: "old-2", l2: "alpha fact again", similarity: 0, createdAt: "2024-01-02T00:00:00.000Z", embedding: [1, 0, 0] },
    newOrthogonal: { id: "new-1", l2: "beta fact", similarity: 0, createdAt: "2024-03-01T00:00:00.000Z", embedding: [0, 1, 0] },
    newDuplicate: { id: "new-2", l2: "alpha fact newest", similarity: 0, createdAt: "2024-03-02T00:00:00.000Z", embedding: [1, 0, 0] },
  };

  it("dedups from stored embeddings without calling embedText", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([ROWS.old1, ROWS.old2]);
    const embedSpy = vi.fn();
    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "user", embedSpy as any, new Map(), "api-key",
    );
    expect(result.status).toBe("completed");
    expect(result.deduped).toBe(1);
    expect(embedSpy).not.toHaveBeenCalled();
    // The replacement carries the stored vector of the surviving (newer) row
    const call = mockSupersedeMemory.mock.calls[0];
    expect(call[1].id).toBe("old-1");
    expect(call[2].id).toBe("old-2");
    expect(call[2].embedding).toEqual([1, 0, 0]);
  });

  it("falls back to embedText only for rows without a stored embedding", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      ROWS.old1,
      { ...ROWS.old2, embedding: [] },
    ]);
    const embedSpy = vi.fn().mockResolvedValue([1, 0, 0]);
    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "user", embedSpy as any, new Map(), "api-key",
    );
    expect(result.deduped).toBe(1);
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy).toHaveBeenCalledWith(ROWS.old2.l2);
  });

  it("skips pairs entirely below the dedup watermark and advances it through processed candidates", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([ROWS.old1, ROWS.old2, ROWS.newOrthogonal]);
    const db = mockDb();
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT swept_through FROM dedup_state")) {
        return Promise.resolve([[{ swept_through: "2024-02-01T00:00:00.000Z" }]]);
      }
      return Promise.resolve([[]]);
    });
    const result = await runConsolidationForScope(
      db, "user1", "user", vi.fn() as any, new Map(), "api-key",
    );
    // old-1/old-2 ARE near-duplicates but both predate the watermark — not candidates
    expect(result.deduped).toBe(0);
    expect(mockSupersedeMemory).not.toHaveBeenCalled();
    const upserts = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("UPSERT dedup_state"),
    );
    expect(upserts).toHaveLength(1);
    expect((upserts[0][1] as Record<string, unknown>).sweptThrough).toBe(ROWS.newOrthogonal.createdAt);
  });

  it("compares a new candidate against the FULL active set, including pre-watermark rows", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([ROWS.old1, ROWS.old2, ROWS.newDuplicate]);
    const db = mockDb();
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT swept_through FROM dedup_state")) {
        return Promise.resolve([[{ swept_through: "2024-02-01T00:00:00.000Z" }]]);
      }
      return Promise.resolve([[]]);
    });
    const result = await runConsolidationForScope(
      db, "user1", "user", vi.fn() as any, new Map(), "api-key",
    );
    // new-2 matches both old rows; both get superseded by the newest
    expect(result.deduped).toBe(2);
    const supersededIds = mockSupersedeMemory.mock.calls.map((c) => (c[1] as { id: string }).id).sort();
    expect(supersededIds).toEqual(["old-1", "old-2"]);
    for (const call of mockSupersedeMemory.mock.calls) {
      expect((call[2] as { id: string }).id).toBe("new-2");
    }
  });

  it("parks the watermark strictly below a failed candidate — and below its same-millisecond peers", async () => {
    const T1 = "2024-03-01T00:00:00.000Z";
    const T2 = "2024-03-02T00:00:00.000Z";
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      // Pre-watermark rows (compared as "other" only)
      { id: "o-1", l2: "old alpha", similarity: 0, createdAt: "2024-01-01T00:00:00.000Z", embedding: [1, 0, 0] },
      { id: "o-2", l2: "old gamma", similarity: 0, createdAt: "2024-01-02T00:00:00.000Z", embedding: [0, 0, 1] },
      // Candidates: A succeeds (no match), B's merge FAILS transiently, C (tied
      // with B at T2) merges successfully
      { id: "cand-a", l2: "beta", similarity: 0, createdAt: T1, embedding: [0, 1, 0] },
      { id: "cand-b", l2: "alpha again", similarity: 0, createdAt: T2, embedding: [1, 0, 0] },
      { id: "cand-c", l2: "gamma again", similarity: 0, createdAt: T2, embedding: [0, 0, 1] },
    ]);
    mockSupersedeMemory
      .mockRejectedValueOnce(new Error("transient db hiccup"))
      .mockResolvedValueOnce(undefined);
    const db = mockDb();
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT swept_through FROM dedup_state")) {
        return Promise.resolve([[{ swept_through: "2024-02-01T00:00:00.000Z" }]]);
      }
      return Promise.resolve([[]]);
    });
    const logger = vi.fn();
    const result = await runConsolidationForScope(
      db, "user1", "user", vi.fn() as any, new Map(), "api-key", logger,
    );
    // C's merge landed despite B's failure
    expect(result.deduped).toBe(1);
    expect(result.status).toBe("completed");
    // Watermark parks at T1: not at T2 (B must be retried) and not between —
    // C shares T2, so parking on it would also be wrong for B under strict '>'
    const upserts = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("UPSERT dedup_state"),
    );
    expect(upserts).toHaveLength(1);
    expect((upserts[0][1] as Record<string, unknown>).sweptThrough).toBe(T1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("failed=1"));
  });

  it("never merges value-conflicting template claims, even at cosine 1.0 (Rúnir-dnpp)", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      // Identical embeddings (cosine 1.0) but conflicting value tokens
      { id: "fact-a", l2: "The payments service in production runs on port 8001.", similarity: 0, createdAt: "2024-03-01T00:00:00.000Z", embedding: [1, 0, 0] },
      { id: "fact-b", l2: "The sessions service in production runs on port 8011.", similarity: 0, createdAt: "2024-03-02T00:00:00.000Z", embedding: [1, 0, 0] },
      // The READY/PONG instruction class (caps-code value tokens)
      { id: "inst-a", l2: "User asked to reply with exactly the word PONG.", similarity: 0, createdAt: "2024-03-03T00:00:00.000Z", embedding: [0, 1, 0] },
      { id: "inst-b", l2: "User asked to reply with exactly the word READY.", similarity: 0, createdAt: "2024-03-04T00:00:00.000Z", embedding: [0, 1, 0] },
    ]);
    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "user", vi.fn() as any, new Map(), "api-key",
    );
    expect(result.deduped).toBe(0);
    expect(mockSupersedeMemory).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  it("still merges when the survivor preserves the loser's value tokens (Rúnir-dnpp)", async () => {
    mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([
      // Same value restated → true redundancy, merges
      { id: "dup-a", l2: "The server runs on port 7700 locally.", similarity: 0, createdAt: "2024-03-01T00:00:00.000Z", embedding: [1, 0, 0] },
      { id: "dup-b", l2: "Locally the server listens on port 7700.", similarity: 0, createdAt: "2024-03-02T00:00:00.000Z", embedding: [1, 0, 0] },
      // Newer compound subsumes the older single fact's value → may absorb it
      { id: "single", l2: "The flags service runs on port 8022.", similarity: 0, createdAt: "2024-03-03T00:00:00.000Z", embedding: [0, 1, 0] },
      { id: "compound", l2: "The flags service runs on port 8022. The queue service runs on port 8023.", similarity: 0, createdAt: "2024-03-04T00:00:00.000Z", embedding: [0, 1, 0] },
    ]);
    const db = mockDb();
    const result = await runConsolidationForScope(
      db, "user1", "user", vi.fn() as any, new Map(), "api-key",
    );
    expect(result.deduped).toBe(2);
    const supersededIds = mockSupersedeMemory.mock.calls.map((c) => (c[1] as { id: string }).id).sort();
    expect(supersededIds).toEqual(["dup-a", "single"]);
  });

  it("lands a completed run WITHOUT advancing the watermark when the budget is exhausted", async () => {
    process.env.CONSOLIDATION_DEDUP_BUDGET_MS = "0";
    try {
      mockFetchAllActiveMemoriesForScope.mockResolvedValueOnce([ROWS.old1, ROWS.old2]);
      const db = mockDb();
      const result = await runConsolidationForScope(
        db, "user1", "user", vi.fn() as any, new Map(), "api-key",
      );
      expect(result.status).toBe("completed");
      expect(result.deduped).toBe(0);
      expect(mockSupersedeMemory).not.toHaveBeenCalled();
      const upserts = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => String(c[0]).includes("UPSERT dedup_state"),
      );
      expect(upserts).toHaveLength(0);
      // Completion still lands so scheduler eligibility clears
      const logRows = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => String(c[0]).includes("CREATE consolidation_log"),
      );
      expect((logRows[logRows.length - 1][1] as Record<string, unknown>).status).toBe("completed");
    } finally {
      delete process.env.CONSOLIDATION_DEDUP_BUDGET_MS;
    }
  });
});

describe("x46j: lock heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extends the lease while the run is in flight and stops after it completes", async () => {
    vi.useFakeTimers();
    let releaseArchive!: () => void;
    mockSoftArchiveInactiveOlderThan.mockImplementation(
      () => new Promise<number>((resolve) => { releaseArchive = () => resolve(0); }),
    );
    const db = mockDb();
    const runPromise = runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key",
    );
    // Default TTL 300s → heartbeat every 100s
    await vi.advanceTimersByTimeAsync(100_000);
    expect(mockExtendLock).toHaveBeenCalledWith(db, "user1::session", "holder-uuid", 300);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(mockExtendLock).toHaveBeenCalledTimes(2);

    releaseArchive();
    const result = await runPromise;
    expect(result.status).toBe("completed");
    expect(mockReleaseLock).toHaveBeenCalled();

    // Heartbeat interval is cleared once the run finishes
    const callsAfterRun = mockExtendLock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(400_000);
    expect(mockExtendLock.mock.calls.length).toBe(callsAfterRun);
  });

  it("logs and continues when the lease was already reaped", async () => {
    vi.useFakeTimers();
    mockExtendLock.mockResolvedValue(false);
    let releaseArchive!: () => void;
    mockSoftArchiveInactiveOlderThan.mockImplementation(
      () => new Promise<number>((resolve) => { releaseArchive = () => resolve(0); }),
    );
    const db = mockDb();
    const logger = vi.fn();
    const runPromise = runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key", logger,
    );
    await vi.advanceTimersByTimeAsync(100_000);
    releaseArchive();
    const result = await runPromise;
    expect(result.status).toBe("completed");
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("lock lease lost"));
  });
});

describe("x46j: scheduler in-flight guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the interval consolidation pass while the startup catch-up is still running", async () => {
    vi.useFakeTimers();
    let unblockFirstAcquire!: () => void;
    const firstAcquire = new Promise<string>((resolve) => {
      unblockFirstAcquire = () => resolve("holder-uuid");
    });
    let acquireCalls = 0;
    mockAcquireLock.mockImplementation(() => (++acquireCalls === 1 ? firstAcquire : Promise.resolve("holder-uuid")));

    const db = mockDb();
    db.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("staleness_backlog") && sql.includes("SELECT") && !sql.includes("WHERE user_id")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("GROUP BY") && sql.includes("userId")) {
        return Promise.resolve([[{ userId: "user1" }]]);
      }
      if (sql.includes("consolidation_state") && sql.includes("SELECT")) {
        return Promise.resolve([[]]);
      }
      if (sql.includes("session_watermarks") && sql.includes("count")) {
        return Promise.resolve([[{ count: 10 }]]);
      }
      return Promise.resolve([[]]);
    });

    const logger = vi.fn();
    const startPromise = startConsolidationScheduler(
      db, embedText, new Map(), 1000, "api-key", logger,
    );
    // Tick fires while the catch-up is stuck on its first lock acquisition
    await vi.advanceTimersByTimeAsync(1100);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("tick pass skipped"));

    unblockFirstAcquire();
    const stop = await startPromise;
    stop();
  });
});

// ── Bead 4: sweep_id flows through to consolidation_log ──────────────────────

const mockRunDecayPass = vi.fn().mockResolvedValue({ scored: 0, pruned: 0, skipped_durable: 0, skipped_pinned: 0, rate_capped: 0 });
const mockRunPromotionPass = vi.fn().mockResolvedValue({ promoted_to_working: 0, promoted_to_durable: 0 });

vi.mock("../lifecycle/semion/decay-pass.js", () => ({
  runDecayPass: (...args: unknown[]) => mockRunDecayPass(...args),
  runPromotionPass: (...args: unknown[]) => mockRunPromotionPass(...args),
}));

describe("Bead 4: sweep_id tracking in consolidation_log", () => {
  let db: ReturnType<typeof mockDb>;

  beforeEach(() => {
    db = mockDb();
    mockAcquireLock.mockResolvedValue("lock-holder");
    mockReleaseLock.mockResolvedValue(undefined);
    mockFetchAllActiveMemoriesForScope.mockResolvedValue([]);
    mockSoftArchiveInactiveOlderThan.mockResolvedValue(0);
    mockPromoteSessionEntities.mockResolvedValue({ promoted: 0, merged: 0 });
    mockRunDecayPass.mockClear();
    mockRunPromotionPass.mockClear();
  });

  it("writes sweep_id to consolidation_log when sweepId is passed", async () => {
    const sweepId = "test-sweep-uuid-1234";
    const result = await runConsolidationForScope(
      db, "user1", "user", embedText, new Map(), "api-key", undefined, sweepId,
    );
    expect(result.status).toBe("completed");

    // Find the CREATE consolidation_log query
    const logQueries = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("CREATE consolidation_log"),
    );
    expect(logQueries.length).toBeGreaterThan(0);
    const lastLog = logQueries[logQueries.length - 1];
    const params = lastLog[1];
    expect(params.sweepId).toBe(sweepId);
  });

  it("omits optional consolidation_log fields when values are undefined", async () => {
    await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key",
    );

    const logQueries = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("CREATE consolidation_log"),
    );
    expect(logQueries.length).toBeGreaterThan(0);

    const [sql, params] = logQueries[logQueries.length - 1];
    expect(sql).not.toContain("error_message = $errorMessage");
    expect(sql).not.toContain("sweep_id = $sweepId");
    expect((params as Record<string, unknown>).errorMessage).toBeUndefined();
    expect((params as Record<string, unknown>).sweepId).toBeUndefined();
  });

  it("includes error_message in consolidation_log when a run fails", async () => {
    mockFetchAllActiveMemoriesForScope.mockRejectedValueOnce(new Error("crash"));

    await runConsolidationForScope(
      db, "user1", "session", embedText, new Map(), "api-key", vi.fn(),
    );

    const logQueries = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).includes("CREATE consolidation_log"),
    );
    expect(logQueries.length).toBeGreaterThan(0);

    const [sql, params] = logQueries[logQueries.length - 1];
    expect(sql).toContain("error_message = $errorMessage");
    expect((params as Record<string, unknown>).errorMessage).toContain("crash");
  });

  it("runConsolidationForScope returns decayPruned and promoted in result", async () => {
    mockRunDecayPass.mockResolvedValueOnce({ scored: 5, pruned: 2, skipped_durable: 0, skipped_pinned: 0, rate_capped: 0 });
    mockRunPromotionPass.mockResolvedValueOnce({ promoted_to_working: 1, promoted_to_durable: 1 });

    const result = await runConsolidationForScope(
      db, "user1", "user", embedText, new Map(), "api-key",
    );
    expect(result.decayPruned).toBe(2);
    expect(result.promoted).toBe(2);
  });
});
