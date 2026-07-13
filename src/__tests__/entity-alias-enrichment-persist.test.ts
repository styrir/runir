/**
 * entity-alias-enrichment-persist.test.ts — Real-DB integration test for the
 * `aliases_enriched_at` schema fix (runaway /admin/export alias-enrichment
 * loop, discovered-from Rúnir-o75n.4).
 *
 * Before ensureEntityTables defined `aliases_enriched_at`, the SCHEMAFULL
 * `entities` table rejected the enricher's WHOLE persist UPDATE
 * ("Found field 'aliases_enriched_at', but no such field exists for table
 * 'entities'"), so nothing ever persisted and every export re-paid the LLM
 * for every alias-less entity (~4,380 in prod). This test exercises the EXACT
 * persist statement the enricher issues (persistEnrichedAliases) against the
 * schema ensureEntityTables creates, in an ISOLATED database. No LLM is
 * involved. Self-skips when no local SurrealDB is reachable (mirrors the
 * entity-consolidation-repro.test.ts pattern).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureEntityTables, upsertEntity } from "../entities/entity-store.js";
import { persistEnrichedAliases } from "../entities/entity-alias-enricher.js";

const TEST_DB = "alias_enrich_persist_test";
const USER = "_alias_persist_test_user";
const NOW = "2026-07-01T00:00:00.000Z";

function makeDb(): SurrealClient {
  return new SurrealClient({
    url: process.env.SURREAL_URL ?? "http://localhost:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

let db: SurrealClient;
let dbAvailable = false;

beforeAll(async () => {
  db = makeDb();
  try {
    await db.query("INFO FOR DB;");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  // Clean slate + the real schema in the isolated test DB.
  await db
    .query("REMOVE TABLE IF EXISTS entities; REMOVE TABLE IF EXISTS entity_edges;")
    .catch(() => {});
  await ensureEntityTables(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

async function seedEntity(name: string): Promise<string> {
  return upsertEntity(db, {
    kind: "concept",
    canonicalName: name,
    nameNorm: name.toLowerCase(),
    aliases: [],
    aliasesNorm: [],
    sourceProject: "alias-persist-test",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    confidence: 0.9,
    scope: "user",
    userId: USER,
  });
}

async function fetchEntity(id: string): Promise<Record<string, unknown>> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM type::record('entities', $id);`,
    { id },
  );
  const rows = (result[0] ?? []) as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("persistEnrichedAliases against the SCHEMAFULL entities table", () => {
  it("persists aliases, aliasesNorm AND aliases_enriched_at (the write the schema used to reject)", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const id = await seedEntity("SurrealDB");
    // Before the DEFINE FIELD fix this UPDATE threw InternalError and NOTHING
    // persisted — the exact runaway-loop failure observed in prod 2026-07-03.
    await persistEnrichedAliases(db, id, ["SRDB", "Surreal"]);

    const row = await fetchEntity(id);
    expect(row.aliases).toEqual(["SRDB", "Surreal"]);
    expect(row.aliasesNorm).toEqual(["srdb", "surreal"]);
    expect(row.aliases_enriched_at).toBeTruthy();
  });

  it("stamps ONLY the attempted marker when the enrichment result is empty", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const id = await seedEntity("Unenrichable Thing");
    await persistEnrichedAliases(db, id, []);

    const row = await fetchEntity(id);
    expect(row.aliases ?? []).toEqual([]);
    expect(row.aliasesNorm ?? []).toEqual([]);
    expect(row.aliases_enriched_at).toBeTruthy();
  });

  it("is idempotent across ensureEntityTables re-runs (IF NOT EXISTS)", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // Re-ensuring the schema must not throw or clobber the persisted stamp.
    await ensureEntityTables(db);
    const id = await seedEntity("Twice Ensured");
    await persistEnrichedAliases(db, id, ["TE"]);
    const row = await fetchEntity(id);
    expect(row.aliases).toEqual(["TE"]);
    expect(row.aliases_enriched_at).toBeTruthy();
  });
});
