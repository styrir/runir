import { describe, it, expect, vi } from "vitest";
import { ensureSalienceSchema } from "../src/capture/continuity/salience-schema.js";

type MockDb = { query: ReturnType<typeof vi.fn> };

function makeDb(): MockDb {
  return {
    query: vi.fn(async () => [] as unknown[]),
  };
}

function joinedQueries(db: MockDb): string {
  return db.query.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("ensureSalienceSchema", () => {
  it("issues DEFINE TABLE statements for all three salience tables", async () => {
    const db = makeDb();
    await ensureSalienceSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(/DEFINE TABLE IF NOT EXISTS salience_prototypes\s+SCHEMAFULL/);
    expect(sql).toMatch(/DEFINE TABLE IF NOT EXISTS salience_centroids\s+SCHEMAFULL/);
    expect(sql).toMatch(/DEFINE TABLE IF NOT EXISTS salience_audit_log\s+SCHEMAFULL/);
  });

  it("defines core fields on salience_prototypes", async () => {
    const db = makeDb();
    await ensureSalienceSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(/embedding ON TABLE salience_prototypes TYPE array<float>/);
    expect(sql).toMatch(/polarity ON TABLE salience_prototypes TYPE string/);
    expect(sql).toMatch(/active ON TABLE salience_prototypes TYPE bool/);
    expect(sql).toMatch(/salience_type ON TABLE salience_prototypes TYPE option<string>/);
  });

  it("defines core fields on salience_centroids", async () => {
    const db = makeDb();
    await ensureSalienceSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(/embedding ON TABLE salience_centroids TYPE array<float>/);
    expect(sql).toMatch(/member_count ON TABLE salience_centroids TYPE int/);
    expect(sql).toMatch(/prototype_version ON TABLE salience_centroids TYPE string/);
  });

  it("defines core fields on salience_audit_log including final_score and decision", async () => {
    const db = makeDb();
    await ensureSalienceSchema(db as unknown as never);
    const sql = joinedQueries(db);
    expect(sql).toMatch(/final_score ON TABLE salience_audit_log TYPE float/);
    expect(sql).toMatch(/decision ON TABLE salience_audit_log TYPE string/);
    expect(sql).toMatch(/scorer_version ON TABLE salience_audit_log TYPE string/);
    expect(sql).toMatch(/human_label ON TABLE salience_audit_log TYPE option<string>/);
  });
});
