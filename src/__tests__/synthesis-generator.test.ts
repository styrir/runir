/**
 * synthesis-generator.test.ts — Code-2ba
 * Tests for synthesis note generation pipeline.
 */

import { describe, it, expect, vi } from "vitest";
import {
  qualifiesForSynthesis,
  buildSynthesisPrompt,
  callGeminiFlash,
  inferParaPlacement,
  upsertSynthesis,
} from "../lifecycle/synthesis/synthesis-generator.js";
import type { MemoryCluster } from "../lifecycle/compaction/memory-clusterer.js";
import type { SynthesisNote } from "../lifecycle/synthesis/synthesis-generator.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

function makeMockDb(queryImpl: (sql: string, vars?: any) => any[][]): SurrealClient {
  return { query: vi.fn(queryImpl) } as unknown as SurrealClient;
}

function makeCluster(overrides: Partial<MemoryCluster> = {}): MemoryCluster {
  return {
    id: "memory_clusters:test",
    fingerprintId: "fp123",
    label: "Test Cluster",
    memoryIds: ["mem1", "mem2", "mem3", "mem4"],
    entityIds: ["ent1", "ent2"],
    size: 4,
    method: "entity_cooccurrence",
    ...overrides,
  };
}

function makeSynthesis(overrides: Partial<SynthesisNote> = {}): SynthesisNote {
  return {
    id: "synthesis_notes:syn1",
    l0: "Existing Title",
    l1: "Existing summary",
    l2: "Existing body",
    clusterId: "memory_clusters:test",
    memoryIds: ["mem1", "mem2", "mem3", "mem4"],
    entityIds: ["ent1", "ent2"],
    tags: [],
    para_placement: "02 Areas",
    lastMemoryCount: 4,
    updateCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// qualifiesForSynthesis
// ---------------------------------------------------------------------------

describe("qualifiesForSynthesis", () => {
  it("returns false for cluster.size < 4", () => {
    const cluster = makeCluster({ size: 3, memoryIds: ["m1", "m2", "m3"] });
    expect(qualifiesForSynthesis(cluster, null)).toBe(false);
  });

  it("returns true for cluster.size >= 4 with no prior synthesis", () => {
    const cluster = makeCluster({ size: 4 });
    expect(qualifiesForSynthesis(cluster, null)).toBe(true);
  });

  it("returns false when no new memories since last synthesis", () => {
    const cluster = makeCluster({ size: 4 });
    const existing = makeSynthesis({ lastMemoryCount: 4 });
    expect(qualifiesForSynthesis(cluster, existing)).toBe(false);
  });

  it("returns true when >= 3 new memories since last synthesis", () => {
    const cluster = makeCluster({ size: 7 });
    const existing = makeSynthesis({ lastMemoryCount: 4 });
    expect(qualifiesForSynthesis(cluster, existing)).toBe(true);
  });

  it("returns false for singleton clusters", () => {
    const cluster = makeCluster({ size: 4, method: "singleton" });
    expect(qualifiesForSynthesis(cluster, null)).toBe(false);
  });

  it("returns false when delta is 2 (below threshold of 3)", () => {
    const cluster = makeCluster({ size: 6 });
    const existing = makeSynthesis({ lastMemoryCount: 4 });
    expect(qualifiesForSynthesis(cluster, existing)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSynthesisPrompt
// ---------------------------------------------------------------------------

describe("buildSynthesisPrompt", () => {
  it("includes memory content in prompt", () => {
    const memories = [{
      id: "mem1",
      l2: "Critical JWT configuration detail",
      l0: "JWT Config Fix",
      l1: "JWT summary",
      category: "cases",
      tier: "working",
      tags: ["jwt"],
      writeSource: "capture",
      createdAt: "2026-03-01T00:00:00Z",
    }];
    const prompt = buildSynthesisPrompt(memories);
    expect(prompt.user).toContain("Critical JWT configuration detail");
  });

  it("requests JSON with l0, l1, l2 fields", () => {
    const memories = [{
      id: "mem1",
      l2: "content",
      l0: "Title",
      l1: "Summary",
      category: "cases",
      tier: "working",
      tags: [],
      writeSource: "capture",
      createdAt: "2026-03-01T00:00:00Z",
    }];
    const prompt = buildSynthesisPrompt(memories);
    expect(prompt.system).toContain('"l0"');
    expect(prompt.system).toContain('"l1"');
    expect(prompt.system).toContain('"l2"');
  });

  it("sorts memories by createdAt (oldest first)", () => {
    const memories = [
      { id: "mem2", l2: "newer", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-03-02T00:00:00Z" },
      { id: "mem1", l2: "older", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-03-01T00:00:00Z" },
    ];
    const prompt = buildSynthesisPrompt(memories);
    const olderPos = prompt.user.indexOf("older");
    const newerPos = prompt.user.indexOf("newer");
    expect(olderPos).toBeLessThan(newerPos);
  });
});

// ---------------------------------------------------------------------------
// callGeminiFlash
// ---------------------------------------------------------------------------

describe("callGeminiFlash (synthesis)", () => {
  it("parses {l0, l1, l2} from LLM JSON response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              l0: "Synthesis Title",
              l1: "Synthesis summary",
              l2: "Full synthesis body content",
            }),
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await callGeminiFlash({ system: "system prompt", user: "user prompt" }, "key");
    expect(result).not.toBeNull();
    expect(result!.l0).toBe("Synthesis Title");
    expect(result!.l1).toBe("Synthesis summary");
    expect(result!.l2).toBe("Full synthesis body content");

    vi.unstubAllGlobals();
  });

  it("returns null on JSON parse failure without throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: "This is not valid JSON {{}" },
        }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await callGeminiFlash({ system: "system prompt", user: "user prompt" }, "key");
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it("returns null on network error without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await callGeminiFlash({ system: "system prompt", user: "user prompt" }, "key");
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// inferParaPlacement
// ---------------------------------------------------------------------------

describe("inferParaPlacement", () => {
  it("returns 04 Archives when any memory is superseded", () => {
    const memories = [
      { id: "m1", l2: "content", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01", supersededById: "mem:m2" },
    ];
    expect(inferParaPlacement("some body", memories)).toBe("04 Archives");
  });

  it("returns 04 Archives when any memory has archive para_hint", () => {
    const memories = [
      { id: "m1", l2: "content", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01", para_hint: "archive" },
    ];
    expect(inferParaPlacement("some body", memories)).toBe("04 Archives");
  });

  it("returns 01 Projects with majority project hints", () => {
    const memories = [
      { id: "m1", l2: "x", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01", para_hint: "project" },
      { id: "m2", l2: "x", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01", para_hint: "project" },
      { id: "m3", l2: "x", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01", para_hint: "area" },
    ];
    // 2/3 = 66% project -> majority
    expect(inferParaPlacement("body", memories)).toBe("01 Projects");
  });

  it("returns 03 Resources with majority resource hints", () => {
    const memories = [
      { id: "m1", l2: "x", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01", para_hint: "resource" },
      { id: "m2", l2: "x", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01", para_hint: "resource" },
      { id: "m3", l2: "x", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01", para_hint: "resource" },
    ];
    expect(inferParaPlacement("body", memories)).toBe("03 Resources");
  });

  it("falls back to 01 Projects with ticket regex", () => {
    const memories = [
      { id: "m1", l2: "Fixed Code-6q9 ticket", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
    ];
    expect(inferParaPlacement("Fixed Code-6q9 ticket issue", memories)).toBe("01 Projects");
  });

  it("falls back to 02 Areas with preference regex", () => {
    const memories = [
      { id: "m1", l2: "prefer tabs over spaces always", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
    ];
    expect(inferParaPlacement("I prefer tabs over spaces always", memories)).toBe("02 Areas");
  });

  it("defaults to 03 Resources when no signals match (developer KB default)", () => {
    const memories = [
      { id: "m1", l2: "random content", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
    ];
    expect(inferParaPlacement("generic body text with no signals", memories)).toBe("03 Resources");
  });

  it("returns 03 Resources for SurrealDB syntax note with 'always' as technical rule", () => {
    const memories = [
      {
        id: "m1",
        l2: "Using SurrealDB RELATE with type::record() always required on both sides.",
        l0: "", l1: "",
        category: "cases",
        tier: "working",
        tags: ["surrealdb", "relate"],
        writeSource: "capture",
        createdAt: "2026-01-01",
      },
    ];
    expect(inferParaPlacement("SurrealDB RELATE always requires type::record()", memories)).toBe("03 Resources");
  });

  it("returns 02 Areas for personal preference with first-person signal", () => {
    const memories = [
      { id: "m1", l2: "tabs are my preference", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
    ];
    expect(inferParaPlacement("I prefer tabs over spaces for my workflow", memories)).toBe("02 Areas");
  });

  it("returns 01 Projects for sprint decision reference", () => {
    const memories = [
      { id: "m1", l2: "We decided in sprint planning to ship the vault exporter first.", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
    ];
    expect(inferParaPlacement("Sprint decision: vault exporter ships in milestone 2", memories)).toBe("01 Projects");
  });

  it("returns 03 Resources for schema definition note with DEFINE keyword", () => {
    const memories = [
      { id: "m1", l2: "DEFINE INDEX idx_entities ON entities COLUMNS nameNorm UNIQUE", l0: "", l1: "", category: "cases", tier: "working", tags: [], writeSource: "capture", createdAt: "2026-01-01" },
    ];
    expect(inferParaPlacement("Entity schema definition", memories)).toBe("03 Resources");
  });
});

// ---------------------------------------------------------------------------
// upsertSynthesis
// ---------------------------------------------------------------------------

describe("upsertSynthesis", () => {
  it("creates new synthesis_notes record when no existingId", async () => {
    const queryFn = vi.fn((sql: string) => {
      if (sql.includes("SELECT canonicalName FROM entities")) {
        return [[]];
      }
      if (sql.includes("CREATE")) {
        return [[{ id: "synthesis_notes:new1" }]];
      }
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const cluster = makeCluster();
    const memories = [{
      id: "mem1",
      l2: "content",
      l0: "Title",
      l1: "Summary",
      category: "cases",
      tier: "working",
      tags: ["jwt"],
      writeSource: "capture",
      createdAt: "2026-01-01",
    }];

    const id = await upsertSynthesis(db, cluster, "Title", "Summary", "Body", "02 Areas", memories);
    expect(typeof id).toBe("string");

    const calls = queryFn.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((sql: string) => sql.includes("CREATE"))).toBe(true);
  });

  it("increments updateCount on update", async () => {
    const queryFn = vi.fn((sql: string, params?: any) => {
      if (sql.includes("SELECT canonicalName FROM entities")) return [[]];
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const cluster = makeCluster();
    const memories = [{
      id: "mem1",
      l2: "content",
      l0: "Title",
      l1: "Summary",
      category: "cases",
      tier: "working",
      tags: [],
      writeSource: "capture",
      createdAt: "2026-01-01",
    }];

    await upsertSynthesis(db, cluster, "Title", "Summary", "Body", "02 Areas", memories, "synthesis_notes:existing1", 2);

    const calls = queryFn.mock.calls;
    const updateCall = calls.find((c: any[]) => (c[0] as string).includes("UPDATE"));
    expect(updateCall).toBeDefined();
    expect(updateCall![1]?.updateCount).toBe(3); // 2 + 1
  });

  it("uses UPDATE path when existingId provided", async () => {
    const queryFn = vi.fn((sql: string) => {
      if (sql.includes("SELECT canonicalName FROM entities")) return [[]];
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const cluster = makeCluster();
    const memories: any[] = [];

    await upsertSynthesis(db, cluster, "T", "S", "B", "01 Projects", memories, "synthesis_notes:old1", 0);

    const calls = queryFn.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((sql: string) => sql.includes("UPDATE"))).toBe(true);
    expect(calls.every((sql: string) => !sql.includes("CREATE"))).toBe(true);
  });

  it("collects union of tags from all source memories", async () => {
    const queryFn = vi.fn((sql: string, params?: any) => {
      if (sql.includes("SELECT canonicalName FROM entities")) return [[]];
      if (sql.includes("CREATE")) return [[{ id: "synthesis_notes:new1" }]];
      return [[]];
    });
    const db = { query: queryFn } as unknown as SurrealClient;

    const cluster = makeCluster();
    const memories = [
      { id: "m1", l2: "c", l0: "", l1: "", category: "cases", tier: "working", tags: ["jwt", "auth"], writeSource: "capture", createdAt: "2026-01-01" },
      { id: "m2", l2: "c", l0: "", l1: "", category: "cases", tier: "working", tags: ["auth", "security"], writeSource: "capture", createdAt: "2026-01-01" },
    ];

    await upsertSynthesis(db, cluster, "T", "S", "B", "02 Areas", memories);

    const createCall = queryFn.mock.calls.find((c: any[]) => (c[0] as string).includes("CREATE"));
    expect(createCall).toBeDefined();
    const tags = createCall![1]?.tags as string[];
    expect(tags).toContain("jwt");
    expect(tags).toContain("auth");
    expect(tags).toContain("security");
    // No duplicates
    expect(tags.filter((t: string) => t === "auth")).toHaveLength(1);
  });

  it("upsertSynthesis stores entityNames from entity DB lookup", async () => {
    const mockDb = {
      query: vi.fn()
        // First call: SELECT canonicalName FROM entities
        .mockResolvedValueOnce([[
          { canonicalName: "SurrealDB" },
          { canonicalName: "RELATE" },
        ]])
        // Second call: CREATE synthesis_notes
        .mockResolvedValueOnce([{ id: "synth:new1" }])
        // Third call: UPDATE cluster synthesisId
        .mockResolvedValueOnce([[]]),
    };

    const cluster = makeCluster({
      entityIds: ["seed-ent-surrealdb", "seed-ent-relate"],
    });
    const memories: any[] = [];

    await upsertSynthesis(mockDb as any, cluster, "Title", "L1", "L2", "02 Areas", memories);

    // Verify SELECT query was called with BARE IDs (stripped of any "entities:" prefix)
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT canonicalName FROM entities"),
      expect.objectContaining({ ids: ["seed-ent-surrealdb", "seed-ent-relate"] }),
    );

    // Verify CREATE query included entityNames
    const createCall = (mockDb.query as any).mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && (c[0] as string).includes("CREATE synthesis_notes"),
    );
    expect(createCall).toBeDefined();
    expect(createCall![1]).toHaveProperty("entityNames", ["SurrealDB", "RELATE"]);
  });

  it("upsertSynthesis normalizes bare entityIds to full record IDs for entity lookup", async () => {
    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ canonicalName: "SurrealDB" }]])
        .mockResolvedValueOnce([{ id: "synth:new1" }])
        .mockResolvedValueOnce([[]]),
    };

    const cluster = makeCluster({
      entityIds: ["seed-ent-surrealdb"], // bare ID — no "entities:" prefix
    });

    await upsertSynthesis(mockDb as any, cluster, "Title", "L1", "L2", "02 Areas", []);

    // Must have been called with bare ID (no "entities:" prefix)
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT canonicalName FROM entities"),
      expect.objectContaining({ ids: ["seed-ent-surrealdb"] }),
    );
  });

  it("upsertSynthesis strips entities: prefix when entityId already has it", async () => {
    const mockDb = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ canonicalName: "SurrealDB" }]])
        .mockResolvedValueOnce([{ id: "synth:new2" }])
        .mockResolvedValueOnce([[]]),
    };

    const cluster = makeCluster({
      entityIds: ["entities:seed-ent-surrealdb"], // already has prefix
    });

    await upsertSynthesis(mockDb as any, cluster, "Title", "L1", "L2", "02 Areas", []);

    // Should strip "entities:" prefix to get bare "seed-ent-surrealdb"
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT canonicalName FROM entities"),
      expect.objectContaining({ ids: ["seed-ent-surrealdb"] }),
    );
  });
});
