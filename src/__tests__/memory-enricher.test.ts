/**
 * memory-enricher.test.ts — Code-b5i
 * Tests for memory enrichment pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchUnenrichedMemories,
  buildEnrichmentPrompt,
  applyEnrichment,
  runEnrichment,
  callGeminiFlash,
} from "../capture/enrichment/memory-enricher.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

// ---------------------------------------------------------------------------
// Mock SurrealClient
// ---------------------------------------------------------------------------

function makeMockDb(queryImpl: (sql: string, vars?: any) => any[][] = () => [[]]): SurrealClient {
  return { query: vi.fn(queryImpl) } as unknown as SurrealClient;
}

// ---------------------------------------------------------------------------
// fetchUnenrichedMemories
// ---------------------------------------------------------------------------

describe("fetchUnenrichedMemories", () => {
  it("returns records with null l0", async () => {
    const row = {
      id: { id: "aaaaaaaaa-1111-1111-1111-111111111111" },
      l2: "Some raw content",
      l0: "",
      l1: "",
      category: "cases",
      tier: "working",
      tags: [],
      writeSource: "capture",
      createdAt: "2026-03-01T00:00:00Z",
    };
    const db = makeMockDb((sql) => {
      if (sql.includes("WHERE")) return [[row]];
      return [[]];
    });

    const results = await fetchUnenrichedMemories(db, 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.l2).toBe("Some raw content");
  });

  it("passes limit to query", async () => {
    const db = makeMockDb(() => [[]]);
    await fetchUnenrichedMemories(db, 42);
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]?.limit).toBe(42);
  });

  it("returns empty array when no unenriched memories", async () => {
    const db = makeMockDb(() => [[]]);
    const results = await fetchUnenrichedMemories(db, 10);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildEnrichmentPrompt
// ---------------------------------------------------------------------------

describe("buildEnrichmentPrompt", () => {
  it("includes l2 content in the prompt", () => {
    const row = {
      id: "test-id",
      l2: "This is the raw memory content about JWT tokens",
      l0: "",
      l1: "",
      category: "cases",
      tier: "working",
      tags: ["jwt", "auth"],
      writeSource: "capture",
      createdAt: "2026-03-01T00:00:00Z",
    };
    const prompt = buildEnrichmentPrompt(row);
    expect(prompt).toContain("This is the raw memory content about JWT tokens");
  });

  it("includes category in prompt", () => {
    const row = {
      id: "test-id",
      l2: "content",
      l0: "",
      l1: "",
      category: "patterns",
      tier: "durable",
      tags: [],
      writeSource: "capture",
      createdAt: "2026-03-01T00:00:00Z",
    };
    const prompt = buildEnrichmentPrompt(row);
    expect(prompt).toContain("patterns");
  });

  it("requests JSON output with l0, l1, para_hint fields", () => {
    const row = {
      id: "test-id",
      l2: "content",
      l0: "",
      l1: "",
      category: "cases",
      tier: "working",
      tags: [],
      writeSource: "capture",
      createdAt: "2026-03-01T00:00:00Z",
    };
    const prompt = buildEnrichmentPrompt(row);
    expect(prompt).toContain('"l0"');
    expect(prompt).toContain('"l1"');
    expect(prompt).toContain('"para_hint"');
  });
});

// ---------------------------------------------------------------------------
// applyEnrichment
// ---------------------------------------------------------------------------

describe("applyEnrichment", () => {
  it("calls db.query with UPDATE statement", async () => {
    const db = makeMockDb(() => [[]]);
    await applyEnrichment(db, "memories:abc123", {
      l0: "Test Title",
      l1: "Test summary.",
      para_hint: "resource",
    });
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("UPDATE");
    expect(call[1]?.l0).toBe("Test Title");
    expect(call[1]?.l1).toBe("Test summary.");
    expect(call[1]?.para_hint).toBe("resource");
  });

  it("prepends memories: prefix if not present", async () => {
    const db = makeMockDb(() => [[]]);
    await applyEnrichment(db, "abc123", {
      l0: "Title",
      l1: "Summary",
      para_hint: "area",
    });
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    // applyEnrichment binds a RecordId as `rid` (not `id`) after the hyphenated-UUID fix
    const rid = call[1]?.rid;
    expect(rid).toBeDefined();
    expect(String(rid)).toContain("memories");
  });
});

// ---------------------------------------------------------------------------
// runEnrichment
// ---------------------------------------------------------------------------

describe("runEnrichment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls applyEnrichment for each unenriched memory", async () => {
    const rows = [
      { id: { id: "mem1" }, l2: "content1", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
      { id: { id: "mem2" }, l2: "content2", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
    ];

    // Mock fetch globally
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({ l0: "Test Title", l1: "Test summary.", para_hint: "resource" }),
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const queryFn = vi.fn((sql: string) => {
      if (sql.includes("WHERE")) return [rows];
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const result = await runEnrichment(db, "test-api-key", 10);

    expect(result.processed).toBe(2);
    expect(result.enriched).toBe(2);
    expect(result.failed).toBe(0);

    vi.unstubAllGlobals();
  });

  it("does not abort batch on single record error", async () => {
    const rows = [
      { id: { id: "mem1" }, l2: "content1", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
      { id: { id: "mem2" }, l2: "content2", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
    ];

    // Use 0 retries so the first network error immediately fails the record
    process.env.ENRICH_MAX_RETRIES = "0";
    process.env.ENRICH_RETRY_DELAY_MS = "0";

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Network error");
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ l0: "Title", l1: "Summary", para_hint: "resource" }) } }],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const queryFn = vi.fn((sql: string) => {
      if (sql.includes("WHERE")) return [rows];
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const result = await runEnrichment(db, "test-api-key", 10);

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.enriched).toBe(1);
    expect(result.errors).toHaveLength(1);

    vi.unstubAllGlobals();
    delete process.env.ENRICH_MAX_RETRIES;
    delete process.env.ENRICH_RETRY_DELAY_MS;
  });

  it("returns zero processed when no unenriched memories", async () => {
    const db = makeMockDb(() => [[]]);
    vi.stubGlobal("fetch", vi.fn());

    const result = await runEnrichment(db, "test-api-key", 10);
    expect(result.processed).toBe(0);
    expect(result.enriched).toBe(0);

    vi.unstubAllGlobals();
  });

  it("marks superseded memories as archive without calling LLM", async () => {
    const rows = [
      {
        id: { id: "mem1" },
        l2: "content1",
        l0: "",
        l1: "",
        category: "cases",
        tier: "working",
        tags: [],
        writeSource: "capture",
        createdAt: "2026-01-01",
        supersededById: "memories:mem2",
      },
    ];

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const queryFn = vi.fn((sql: string) => {
      if (sql.includes("WHERE")) return [rows];
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const result = await runEnrichment(db, "test-api-key", 10);

    // fetch should NOT be called for superseded memories
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.enriched).toBe(1);

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// callGeminiFlash
// ---------------------------------------------------------------------------

describe("callGeminiFlash", () => {
  it("parses JSON response and returns l0/l1/para_hint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              l0: "JWT Token Expiry Fix",
              l1: "Fixed JWT expiry to 3600 seconds.",
              para_hint: "project",
            }),
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await callGeminiFlash("test prompt", "test-key");
    expect(result!.l0).toBe("JWT Token Expiry Fix");
    expect(result!.para_hint).toBe("project");

    vi.unstubAllGlobals();
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(callGeminiFlash("prompt", "bad-key")).rejects.toThrow("401");

    vi.unstubAllGlobals();
  });

  it("strips markdown fences from response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: "```json\n" + JSON.stringify({
              l0: "Title",
              l1: "Summary",
              para_hint: "area",
            }) + "\n```",
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await callGeminiFlash("prompt", "key");
    expect(result!.l0).toBe("Title");

    vi.unstubAllGlobals();
  });
});
