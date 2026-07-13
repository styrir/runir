import { describe, it, expect, vi } from "vitest";
import { ensureMemoryEnrichmentSchema, SurrealClient } from "../storage/surreal/surreal-store.js";

vi.mock("surrealdb", () => {
  return {
    Surreal: vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      use: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
    })),
  };
});

describe("schema-migration", () => {
  it("ensureMemoryEnrichmentSchema is idempotent (no errors on second run)", async () => {
    const mockQuery = vi.fn().mockResolvedValue([]);
    const db = { query: mockQuery } as unknown as SurrealClient;

    await ensureMemoryEnrichmentSchema(db);
    await ensureMemoryEnrichmentSchema(db);

    // Both calls should succeed without error
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it("schema defines all expected fields", async () => {
    const mockQuery = vi.fn().mockResolvedValue([]);
    const db = { query: mockQuery } as unknown as SurrealClient;

    await ensureMemoryEnrichmentSchema(db);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("payload.l0");
    expect(sql).toContain("payload.l1");
    expect(sql).toContain("payload.category");
    expect(sql).toContain("payload.tier");
    expect(sql).toContain("payload.factKey");
    expect(sql).toContain("payload.writeSource");
    expect(sql).toContain("payload.accessCount");
    expect(sql).toContain("payload.lastAccessedAt");
    expect(sql).toContain("payload.tags");
    expect(sql).toContain("idx_memories_factKey");
    expect(sql).toContain("idx_memories_category");
    expect(sql).toContain("idx_memories_tier");
    const semioteSql = mockQuery.mock.calls[1][0] as string;
    expect(semioteSql).toContain("payload.semiosis");
    expect(semioteSql).toContain("idx_semiote_factKey");
  });
});
