import { describe, it, expect, vi } from "vitest";
import { ensureSynthesisSchema } from "../src/storage/surreal/migrations/synthesis-schema.js";

type MockDb = { query: ReturnType<typeof vi.fn> };

function makeDb(): MockDb {
  return { query: vi.fn(async () => [] as unknown[]) };
}

function joinedQueries(db: MockDb): string {
  return db.query.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("ensureSynthesisSchema", () => {
  it("defines memory_clusters and synthesis_notes tables", async () => {
    const db = makeDb();
    await ensureSynthesisSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(/DEFINE TABLE IF NOT EXISTS memory_clusters/);
    expect(sql).toMatch(/DEFINE TABLE IF NOT EXISTS synthesis_notes/);
  });

  it("defines required fields on memory_clusters", async () => {
    const db = makeDb();
    await ensureSynthesisSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(/fingerprintId ON TABLE memory_clusters TYPE string/);
    expect(sql).toMatch(/memoryIds\s+ON TABLE memory_clusters TYPE array/);
    expect(sql).toMatch(/method\s+ON TABLE memory_clusters TYPE string/);
  });

  it("declares the unique fingerprint index on memory_clusters", async () => {
    const db = makeDb();
    await ensureSynthesisSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(
      /DEFINE INDEX IF NOT EXISTS idx_memory_clusters_fingerprint ON TABLE memory_clusters FIELDS fingerprintId UNIQUE/,
    );
  });

  it("defines required fields on synthesis_notes", async () => {
    const db = makeDb();
    await ensureSynthesisSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(/clusterId\s+ON TABLE synthesis_notes TYPE string/);
    expect(sql).toMatch(/para_placement\s+ON TABLE synthesis_notes TYPE string/);
    expect(sql).toMatch(/lastMemoryCount ON TABLE synthesis_notes TYPE int/);
  });

  it("adds additive enrichment fields on the memories table", async () => {
    const db = makeDb();
    await ensureSynthesisSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(/enriched_at ON TABLE memories TYPE option<datetime>/);
    expect(sql).toMatch(/para_hint\s+ON TABLE memories TYPE option<string>/);
  });
});
