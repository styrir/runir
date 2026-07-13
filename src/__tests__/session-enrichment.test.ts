/**
 * session-enrichment.test.ts — Code-kf2w
 * Tests for session-end enrichment pipeline:
 *   - withConcurrencyLimit (via runSessionEnrichment behavior)
 *   - fetchUnenrichedMemoriesBySession session filter
 *   - runSessionEnrichment returns enriched count
 *   - session-end handler fire-and-forget (non-blocking)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchUnenrichedMemoriesBySession,
  runSessionEnrichment,
} from "../capture/enrichment/memory-enricher.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";
import type { RawMemoryRow } from "../capture/enrichment/memory-enricher.js";

// ---------------------------------------------------------------------------
// fetchUnenrichedMemoriesBySession
// ---------------------------------------------------------------------------

describe("fetchUnenrichedMemoriesBySession", () => {
  it("queries only the specified session, uses payload.l0 predicate, and binds sessionId + limit", async () => {
    const querySpy = vi.fn().mockResolvedValue([
      [{ id: "memories:abc", l2: "test content", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-03-28" }],
    ]);
    const mockDb = { query: querySpy } as unknown as SurrealClient;

    const rows = await fetchUnenrichedMemoriesBySession(mockDb, "session-123", 10);

    // Assert SurrealQL contains session filter
    const sql = querySpy.mock.calls[0][0] as string;
    expect(sql).toContain("payload.sessionId = $sessionId");

    // Assert SurrealQL uses payload.l0 (not top-level l0) in the unenriched predicate
    expect(sql).toContain("payload.l0 IS NONE");
    expect(sql).toContain("payload.l0 = ''");
    // Ensure it is NOT checking a top-level l0 field (no bare "l0 IS NONE" without "payload." prefix)
    expect(sql).not.toMatch(/(?<!payload\.)l0 IS NONE/);

    // Assert correct bindings
    const bindings = querySpy.mock.calls[0][1];
    expect(bindings).toEqual({ sessionId: "session-123", limit: 10 });

    // Assert row normalization
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("memories:abc");
    expect(rows[0].l2).toBe("test content");
  });

  it("returns empty array when no rows found", async () => {
    const querySpy = vi.fn().mockResolvedValue([[]]);
    const mockDb = { query: querySpy } as unknown as SurrealClient;
    const rows = await fetchUnenrichedMemoriesBySession(mockDb, "session-xyz", 5);
    expect(rows).toHaveLength(0);
  });

  it("normalizes object-style id to string", async () => {
    const querySpy = vi.fn().mockResolvedValue([
      [{ id: { id: "mem-uuid-1" }, l2: "content", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-03-28" }],
    ]);
    const mockDb = { query: querySpy } as unknown as SurrealClient;
    const rows = await fetchUnenrichedMemoriesBySession(mockDb, "session-123", 10);
    expect(typeof rows[0].id).toBe("string");
    expect(rows[0].id).toContain("mem-uuid-1");
  });
});

// ---------------------------------------------------------------------------
// withConcurrencyLimit — tested via runSessionEnrichment behavior
// ---------------------------------------------------------------------------

describe("runSessionEnrichment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty result when no unenriched memories", async () => {
    const querySpy = vi.fn().mockResolvedValue([[]]);
    const mockDb = { query: querySpy } as unknown as SurrealClient;

    const result = await runSessionEnrichment(mockDb, "test-key", "empty-session");
    expect(result.processed).toBe(0);
    expect(result.enriched).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.enrichedIds).toHaveLength(0);
  });

  it("enriches all rows and respects concurrency limit of 5", async () => {
    // Track concurrent calls
    let activeCalls = 0;
    let maxConcurrent = 0;

    // Build 10 mock rows
    const mockRows: RawMemoryRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `memories:row-${i}`,
      l2: `content ${i}`,
      l0: "",
      l1: "",
      category: "cases",
      tier: "working",
      tags: [],
      writeSource: "capture",
      createdAt: "2026-03-28",
    }));

    // Make fetchUnenrichedMemoriesBySession return 10 rows
    const querySpy = vi.fn().mockResolvedValue([mockRows.map(r => ({
      id: r.id,
      l2: r.l2,
      category: r.category,
      tier: r.tier,
      tags: r.tags,
      writeSource: r.writeSource,
      createdAt: r.createdAt,
    }))]);

    // Mock fetch (used by callGeminiFlash) with 100ms delay
    const mockFetch = vi.fn().mockImplementation(async () => {
      activeCalls++;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      await new Promise((r) => setTimeout(r, 100));
      activeCalls--;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ l0: "Title", l1: "Summary", para_hint: "resource" }) } }],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    // Mock applyEnrichment (db.query UPDATE calls)
    const mockDb = { query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("LIMIT")) return [mockRows.map(r => ({
        id: r.id,
        l2: r.l2,
        category: r.category,
        tier: r.tier,
        tags: r.tags,
        writeSource: r.writeSource,
        createdAt: r.createdAt,
      }))];
      return [[]];
    }) } as unknown as SurrealClient;

    const result = await runSessionEnrichment(mockDb, "test-key", "session-1", "user-1", 5);

    expect(result.enriched).toBe(10);
    expect(result.failed).toBe(0);
    expect(result.processed).toBe(10);
    // Concurrency should have peaked at 5 (not 10, not 1)
    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(maxConcurrent).toBeGreaterThan(1); // Actually ran concurrently, not sequential

    vi.unstubAllGlobals();
  });

  it("marks superseded rows as archive without calling LLM", async () => {
    const supersededRow: RawMemoryRow = {
      id: "memories:sup1",
      l2: "some content",
      l0: "",
      l1: "",
      category: "cases",
      tier: "working",
      tags: [],
      writeSource: "capture",
      createdAt: "2026-03-28",
      supersededById: "memories:sup2",
    };

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const mockDb = { query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("LIMIT")) return [[{
        id: supersededRow.id,
        l2: supersededRow.l2,
        category: supersededRow.category,
        tier: supersededRow.tier,
        tags: supersededRow.tags,
        writeSource: supersededRow.writeSource,
        createdAt: supersededRow.createdAt,
        supersededById: supersededRow.supersededById,
      }]];
      return [[]];
    }) } as unknown as SurrealClient;

    const result = await runSessionEnrichment(mockDb, "test-key", "session-supersede");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.enriched).toBe(1);
    expect(result.failed).toBe(0);

    vi.unstubAllGlobals();
  });

  it("handles individual LLM call failures without aborting batch", async () => {
    // 2 rows, first LLM call throws
    process.env.ENRICH_MAX_RETRIES = "0";
    process.env.ENRICH_RETRY_DELAY_MS = "0";

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("LLM error");
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ l0: "Title", l1: "Summary", para_hint: "resource" }) } }],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockDb = { query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("LIMIT")) return [[
        { id: "memories:r1", l2: "c1", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-03-28" },
        { id: "memories:r2", l2: "c2", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-03-28" },
      ]];
      return [[]];
    }) } as unknown as SurrealClient;

    const result = await runSessionEnrichment(mockDb, "test-key", "session-fail", undefined, 2);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.enriched).toBe(1);

    vi.unstubAllGlobals();
    delete process.env.ENRICH_MAX_RETRIES;
    delete process.env.ENRICH_RETRY_DELAY_MS;
  });
});
