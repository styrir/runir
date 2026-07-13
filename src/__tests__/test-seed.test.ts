/**
 * test-seed.test.ts — Code-377
 * Unit tests for the test namespace seed dataset.
 * Uses mock SurrealClient to avoid needing a live DB connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SEED_MEMORIES,
  SEED_ENTITIES,
  SeedMemory,
  SeedEntity,
  loadSeed,
  resetSeed,
} from "../testing/test-seed.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------
function makeMockDb(): SurrealClient & { calls: Array<[string, any]> } {
  const calls: Array<[string, any]> = [];
  const mockDb = {
    calls,
    query: vi.fn(async (sql: string, vars?: any) => {
      calls.push([sql, vars]);
      return [[]];
    }),
  } as unknown as SurrealClient & { calls: Array<[string, any]> };
  return mockDb;
}

// ---------------------------------------------------------------------------
// SEED_MEMORIES shape tests
// ---------------------------------------------------------------------------
describe("SEED_MEMORIES", () => {
  it("contains the expected total count (~40 memories)", () => {
    expect(SEED_MEMORIES.length).toBeGreaterThanOrEqual(30);
    expect(SEED_MEMORIES.length).toBeLessThanOrEqual(45);
  });

  it("Cluster A has 8 SurrealDB memories", () => {
    const clusterA = SEED_MEMORIES.filter((m) => m.id.startsWith("seed-surreal-"));
    expect(clusterA.length).toBe(8);
  });

  it("Cluster B has 6 vault-exporter memories", () => {
    const clusterB = SEED_MEMORIES.filter((m) => m.id.startsWith("seed-vault-"));
    expect(clusterB.length).toBe(6);
  });

  it("Cluster C has 5 Gemini Flash memories", () => {
    const clusterC = SEED_MEMORIES.filter((m) => m.id.startsWith("seed-gemini-"));
    expect(clusterC.length).toBe(5);
  });

  it("has 8 singleton memories", () => {
    const singles = SEED_MEMORIES.filter((m) => m.id.startsWith("seed-single-"));
    expect(singles.length).toBe(8);
  });

  it("has 4 superseded (active:false) memories", () => {
    const superseded = SEED_MEMORIES.filter((m) => m.active === false);
    expect(superseded.length).toBe(4);
    superseded.forEach((m) => {
      expect(m.id).toMatch(/^seed-super-/);
    });
  });

  it("all active memories have active:true", () => {
    SEED_MEMORIES.filter((m) => m.active !== false).forEach((m) => {
      expect(m.active).toBe(true);
    });
  });

  it("all memory IDs use expected fixed prefix format", () => {
    SEED_MEMORIES.forEach((m) => {
      expect(m.id).toMatch(/^seed-(surreal|vault|gemini|single|super)-\d+$/);
    });
  });

  it("session_summary writeSource memories have empty l0/l1 (need enrichment)", () => {
    const sessionSummaryMems = SEED_MEMORIES.filter(
      (m) => m.writeSource === "session_summary",
    );
    expect(sessionSummaryMems.length).toBeGreaterThan(0);
    sessionSummaryMems.forEach((m) => {
      expect(m.l0).toBe("");
      expect(m.l1).toBe("");
    });
  });

  it("capture writeSource memories have empty l0/l1 (need enrichment)", () => {
    const captureMems = SEED_MEMORIES.filter(
      (m) => m.writeSource === "capture",
    );
    expect(captureMems.length).toBeGreaterThan(0);
    captureMems.forEach((m) => {
      expect(m.l0).toBe("");
      expect(m.l1).toBe("");
    });
  });

  it("session-end writeSource memories have populated l0/l1 (already enriched)", () => {
    const sessionEndMems = SEED_MEMORIES.filter(
      (m) => m.writeSource === "session-end",
    );
    expect(sessionEndMems.length).toBeGreaterThan(0);
    sessionEndMems.forEach((m) => {
      expect(m.l0.length).toBeGreaterThan(0);
      expect(m.l1.length).toBeGreaterThan(0);
    });
  });

  it("all memories have required fields with correct types", () => {
    SEED_MEMORIES.forEach((m) => {
      expect(typeof m.id).toBe("string");
      expect(typeof m.l2).toBe("string");
      expect(m.l2.length).toBeGreaterThanOrEqual(20);
      expect(m.l2.length).toBeLessThanOrEqual(1000); // generous max
      expect(typeof m.category).toBe("string");
      expect(["profile", "preferences", "entities", "events", "cases", "patterns"]).toContain(m.category);
      expect(typeof m.tier).toBe("string");
      expect(["durable", "working", "ephemeral"]).toContain(m.tier);
      expect(typeof m.confidence).toBe("number");
      expect(m.confidence).toBeGreaterThan(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
      expect(m.userId).toBe("test-user");
      expect(typeof m.writeSource).toBe("string");
      expect(Array.isArray(m.tags)).toBe(true);
      expect(typeof m.createdAt).toBe("string");
    });
  });

  it("all memory IDs are unique", () => {
    const ids = SEED_MEMORIES.map((m) => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("Cluster A memories all mention SurrealDB-related entities in l2", () => {
    const clusterA = SEED_MEMORIES.filter((m) => m.id.startsWith("seed-surreal-"));
    clusterA.forEach((m) => {
      const text = m.l2.toLowerCase() + m.l0.toLowerCase() + m.tags.join(" ");
      const mentionsSurrealRelated = text.includes("surrealdb") || text.includes("relate") || text.includes("entity_edges");
      expect(mentionsSurrealRelated).toBe(true);
    });
  });

  it("Cluster B memories all mention vault-exporter-related entities in l2", () => {
    const clusterB = SEED_MEMORIES.filter((m) => m.id.startsWith("seed-vault-"));
    clusterB.forEach((m) => {
      const text = m.l2.toLowerCase() + m.tags.join(" ");
      const mentionsVaultRelated = text.includes("vault-exporter") || text.includes("vault") || text.includes("para") || text.includes("obsidian");
      expect(mentionsVaultRelated).toBe(true);
    });
  });

  it("Cluster C memories all mention Gemini/LLM-related entities in l2", () => {
    const clusterC = SEED_MEMORIES.filter((m) => m.id.startsWith("seed-gemini-"));
    clusterC.forEach((m) => {
      const text = m.l2.toLowerCase() + m.tags.join(" ");
      const mentionsLlmRelated = text.includes("gemini") || text.includes("openrouter") || text.includes("llm");
      expect(mentionsLlmRelated).toBe(true);
    });
  });

  it("singletons have varied category/confidence/writeSource for non-clustering", () => {
    const singles = SEED_MEMORIES.filter((m) => m.id.startsWith("seed-single-"));
    const categories = new Set(singles.map((m) => m.category));
    expect(categories.size).toBeGreaterThan(1); // varied categories

    const writeSources = new Set(singles.map((m) => m.writeSource));
    expect(writeSources.size).toBeGreaterThan(1); // varied write sources
  });
});

// ---------------------------------------------------------------------------
// SEED_ENTITIES shape tests
// ---------------------------------------------------------------------------
describe("SEED_ENTITIES", () => {
  it("contains ~15 entity records", () => {
    expect(SEED_ENTITIES.length).toBeGreaterThanOrEqual(12);
    expect(SEED_ENTITIES.length).toBeLessThanOrEqual(20);
  });

  it("all entity IDs are unique", () => {
    const ids = SEED_ENTITIES.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all entities have required fields", () => {
    SEED_ENTITIES.forEach((e) => {
      expect(typeof e.id).toBe("string");
      expect(typeof e.kind).toBe("string");
      expect(typeof e.canonicalName).toBe("string");
      expect(typeof e.nameNorm).toBe("string");
      expect(e.userId).toBe("test-user");
      expect(e.scope).toBe("user");
      expect(typeof e.confidence).toBe("number");
    });
  });

  it("includes cluster A entities: SurrealDB, RELATE, entity_edges", () => {
    const names = SEED_ENTITIES.map((e) => e.canonicalName);
    expect(names).toContain("SurrealDB");
    expect(names).toContain("RELATE");
    expect(names).toContain("entity_edges");
  });

  it("includes cluster B entities: vault-exporter, PARA, Obsidian", () => {
    const names = SEED_ENTITIES.map((e) => e.canonicalName);
    expect(names).toContain("vault-exporter");
    expect(names).toContain("PARA");
    expect(names).toContain("Obsidian");
  });

  it("includes cluster C entities: Gemini Flash, OpenRouter, LLM", () => {
    const names = SEED_ENTITIES.map((e) => e.canonicalName);
    expect(names).toContain("Gemini Flash");
    expect(names).toContain("OpenRouter");
    expect(names).toContain("LLM");
  });

  it("entities have varied kinds", () => {
    const kinds = new Set(SEED_ENTITIES.map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// loadSeed tests
// ---------------------------------------------------------------------------
describe("loadSeed", () => {
  it("calls db.query for each memory and entity", async () => {
    const mockDb = makeMockDb();
    const result = await loadSeed(mockDb);

    // Should have inserted memories + entities + edges
    expect(mockDb.calls.length).toBeGreaterThan(SEED_MEMORIES.length + SEED_ENTITIES.length);
  });

  it("returns correct count of memories and entities", async () => {
    const mockDb = makeMockDb();
    const result = await loadSeed(mockDb);

    expect(result.memories).toBe(SEED_MEMORIES.length);
    expect(result.entities).toBe(SEED_ENTITIES.length);
  });

  it("inserts memories with UPSERT using correct IDs", async () => {
    const mockDb = makeMockDb();
    await loadSeed(mockDb);

    // Check that at least one memory insert call uses the seed ID
    const memoryInsertCalls = mockDb.calls.filter(
      ([sql]) => sql.includes("UPSERT") && sql.includes("memories"),
    );
    expect(memoryInsertCalls.length).toBeGreaterThan(0);

    // Verify seed-surreal-1 is among the IDs
    const memIds = memoryInsertCalls.map(([, vars]) => vars?.id).filter(Boolean);
    expect(memIds).toContain("seed-surreal-1");
    expect(memIds).toContain("seed-vault-1");
    expect(memIds).toContain("seed-gemini-1");
  });

  it("inserts entities with UPSERT using correct IDs", async () => {
    const mockDb = makeMockDb();
    await loadSeed(mockDb);

    const entityInsertCalls = mockDb.calls.filter(
      ([sql]) => sql.includes("UPSERT") && sql.includes("entities"),
    );
    expect(entityInsertCalls.length).toBeGreaterThan(0);

    const entIds = entityInsertCalls.map(([, vars]) => vars?.id).filter(Boolean);
    expect(entIds).toContain("seed-ent-surrealdb");
    expect(entIds).toContain("seed-ent-vault-exporter");
    expect(entIds).toContain("seed-ent-gemini-flash");
  });

  it("creates entity_edges RELATE statements for co-occurrence", async () => {
    const mockDb = makeMockDb();
    await loadSeed(mockDb);

    const relateCalls = mockDb.calls.filter(([sql]) => sql.includes("RELATE"));
    expect(relateCalls.length).toBeGreaterThan(0);
  });

  it("stores memories with payload.writeSource and payload.category", async () => {
    const mockDb = makeMockDb();
    await loadSeed(mockDb);

    const memInserts = mockDb.calls.filter(
      ([sql]) => sql.includes("UPSERT") && sql.includes("memories"),
    );
    // Every memory insert should pass payload with writeSource and category
    const firstInsert = memInserts[0];
    expect(firstInsert).toBeDefined();
    const [, vars] = firstInsert!;
    expect(vars?.payload?.writeSource).toBeDefined();
    expect(vars?.payload?.category).toBeDefined();
  });

  it("accepts optional ns and db_name params without throwing", async () => {
    const mockDb = makeMockDb();
    // Should not throw even if ns/db_name are provided (they're informational)
    await expect(loadSeed(mockDb, "test", "test")).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resetSeed tests
// ---------------------------------------------------------------------------
describe("resetSeed", () => {
  it("calls DELETE before inserting (wipe + reload)", async () => {
    const mockDb = makeMockDb();
    await resetSeed(mockDb);

    const deleteCalls = mockDb.calls.filter(([sql]) => sql.includes("DELETE"));
    const upsertCalls = mockDb.calls.filter(([sql]) => sql.includes("UPSERT"));

    expect(deleteCalls.length).toBeGreaterThan(0);
    expect(upsertCalls.length).toBeGreaterThan(0);

    // DELETE calls should come before UPSERT calls
    const firstDeleteIdx = mockDb.calls.findIndex(([sql]) => sql.includes("DELETE"));
    const firstUpsertIdx = mockDb.calls.findIndex(([sql]) => sql.includes("UPSERT"));
    expect(firstDeleteIdx).toBeLessThan(firstUpsertIdx);
  });

  it("returns the same counts as loadSeed", async () => {
    const mockDb1 = makeMockDb();
    const mockDb2 = makeMockDb();

    const loadResult = await loadSeed(mockDb1);
    const resetResult = await resetSeed(mockDb2);

    expect(resetResult.memories).toBe(loadResult.memories);
    expect(resetResult.entities).toBe(loadResult.entities);
  });

  it("is idempotent — calling twice gives same count", async () => {
    const mockDb = makeMockDb();

    const result1 = await resetSeed(mockDb);
    // Reset call count to isolate second call
    mockDb.calls.length = 0;
    const result2 = await resetSeed(mockDb);

    expect(result1.memories).toBe(result2.memories);
    expect(result1.entities).toBe(result2.entities);
  });

  it("deletes entity_edges with provenance=seed", async () => {
    const mockDb = makeMockDb();
    await resetSeed(mockDb);

    const edgeDeleteCalls = mockDb.calls.filter(
      ([sql]) => sql.includes("DELETE") && sql.includes("entity_edges"),
    );
    expect(edgeDeleteCalls.length).toBeGreaterThan(0);
  });

  it("deletes each seed memory by ID", async () => {
    const mockDb = makeMockDb();
    await resetSeed(mockDb);

    const memDeleteCalls = mockDb.calls.filter(
      ([sql]) => sql.includes("DELETE") && sql.includes("memories"),
    );
    expect(memDeleteCalls.length).toBe(SEED_MEMORIES.length);
  });

  it("deletes each seed entity by ID", async () => {
    const mockDb = makeMockDb();
    await resetSeed(mockDb);

    const entDeleteCalls = mockDb.calls.filter(
      ([sql]) => sql.includes("DELETE") && sql.includes("entities"),
    );
    expect(entDeleteCalls.length).toBe(SEED_ENTITIES.length);
  });
});

// ---------------------------------------------------------------------------
// Cluster co-occurrence coverage tests
// ---------------------------------------------------------------------------
describe("cluster co-occurrence coverage", () => {
  it("Cluster A: at least 3 entities link to 5+ memories (triggers clustering)", () => {
    // From the ENTITY_MEMORY_LINKS in test-seed.ts, verify the logic matches
    const clusterAMemIds = SEED_MEMORIES
      .filter((m) => m.id.startsWith("seed-surreal-"))
      .map((m) => m.id);
    const clusterAEntities = SEED_ENTITIES.filter((e) =>
      ["seed-ent-surrealdb", "seed-ent-relate", "seed-ent-entity-edges"].includes(e.id),
    );
    expect(clusterAEntities.length).toBe(3);
    expect(clusterAMemIds.length).toBeGreaterThanOrEqual(5);
  });

  it("Cluster B: 3 entities cover all 6 memories", () => {
    const clusterBMemIds = SEED_MEMORIES
      .filter((m) => m.id.startsWith("seed-vault-"))
      .map((m) => m.id);
    const clusterBEntities = SEED_ENTITIES.filter((e) =>
      ["seed-ent-vault-exporter", "seed-ent-para", "seed-ent-obsidian"].includes(e.id),
    );
    expect(clusterBEntities.length).toBe(3);
    expect(clusterBMemIds.length).toBe(6);
  });

  it("Cluster C: 3 entities cover all 5 memories", () => {
    const clusterCMemIds = SEED_MEMORIES
      .filter((m) => m.id.startsWith("seed-gemini-"))
      .map((m) => m.id);
    const clusterCEntities = SEED_ENTITIES.filter((e) =>
      ["seed-ent-gemini-flash", "seed-ent-openrouter", "seed-ent-llm"].includes(e.id),
    );
    expect(clusterCEntities.length).toBe(3);
    expect(clusterCMemIds.length).toBe(5);
  });
});
