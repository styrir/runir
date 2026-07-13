import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RecordId } from "surrealdb";
import { SurrealClient, extractId } from "../storage/surreal/surreal-store.js";
import { ensureEntityTables, upsertEntity, linkEntityToMemory } from "../entities/entity-store.js";
import { fetchMentionCounts } from "../lifecycle/archive/vault-exporter.js";

// Real-DB integration reproduction for Rúnir-78sy.6 C3: fetchMentionCounts
// replaces 4,347 sequential per-entity fetchMentionCount queries with ONE
// aggregation (`SELECT in, count() AS count FROM entity_edges WHERE kind =
// "mentioned_in" GROUP BY in`). A mocked-db unit test can only assert the SQL
// string shape; it cannot prove the aggregation's `in` field — which arrives
// as a RecordId OBJECT over the app's real WebSocket/CBOR driver, not a plain
// string (F9) — normalizes to the SAME bare id as a per-entity legacy-shape
// query. Edges are seeded via linkEntityToMemory's real `RELATE` write path
// (not hand-written string fixtures), so genuine SurrealDB relation-id shapes
// are exercised (Codex MINOR-3/MINOR-4). Runs in an ISOLATED database and
// skips when no local SurrealDB is reachable (the entity-consolidation-repro /
// table-defaults-repro pattern).

const TEST_DB = "vault_exporter_mention_counts_repro_test";
const USER = "_78sy6_mention_counts_repro_user";
const NOW = "2026-01-01T00:00:00.000Z";

function makeDb(): SurrealClient {
  return new SurrealClient({
    // 127.0.0.1 (IPv4), not localhost — the native install binds IPv4 only.
    url: process.env.SURREAL_URL ?? "http://127.0.0.1:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

/** The pre-C3 per-entity legacy-shape query, run directly here (not imported
 *  — the production fetchMentionCount was deleted by C3) as the independent
 *  comparison oracle for fetchMentionCounts' batched result. Binds a real
 *  RecordId (not a bare-slug string) — `in` is a genuine record link, and the
 *  production caller's entityId always came off a SELECT row (RecordId object
 *  or `table:bareid` string, per F9), never a bare slug. */
async function legacyMentionCount(db: SurrealClient, bareEntityId: string): Promise<number> {
  const results = await db.query<{ count: number }>(
    `SELECT count() AS count FROM entity_edges WHERE kind = "mentioned_in" AND in = $entityId GROUP ALL`,
    { entityId: new RecordId("entities", bareEntityId) },
  );
  return results[0]?.[0]?.count ?? 0;
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
  await db.query("REMOVE TABLE IF EXISTS entities; REMOVE TABLE IF EXISTS entity_edges; REMOVE TABLE IF EXISTS semiote;").catch(() => {});
  await ensureEntityTables(db);
  await db.query("DEFINE TABLE IF NOT EXISTS semiote SCHEMALESS;");
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
    await db.close().catch(() => {});
  }
});

describe("fetchMentionCounts — batched aggregation vs. per-entity legacy shape (Rúnir-78sy.6 C3 live-DB proof)", () => {
  it("matches the per-entity legacy-shape count for both a nonzero-count and a zero-count entity", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const base = {
      kind: "concept" as const,
      sourceProject: "78sy6-repro",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      confidence: 0.9,
      aliases: [] as string[],
      aliasesNorm: [] as string[],
      scope: "user" as const,
      userId: USER,
    };

    // Mentioned entity: gets 3 mentioned_in edges from 3 distinct memories.
    const mentionedId = await upsertEntity(db, {
      ...base,
      canonicalName: "Mentioned Concept",
      nameNorm: "mentioned concept",
    });
    // Never-mentioned entity: exists in `entities` but has zero edges — must
    // resolve via the Map's `.get(key) ?? 0` default, not a lookup miss/throw.
    const unmentionedId = await upsertEntity(db, {
      ...base,
      canonicalName: "Unmentioned Concept",
      nameNorm: "unmentioned concept",
    });

    await db.query(
      "CREATE type::record('semiote', 'm1') SET payload = { userId: $u }; CREATE type::record('semiote', 'm2') SET payload = { userId: $u }; CREATE type::record('semiote', 'm3') SET payload = { userId: $u };",
      { u: USER },
    );
    // Real RELATE write path (linkEntityToMemory) — exercises the genuine
    // RecordId-shaped `in` field the aggregation's GROUP BY reads back.
    await linkEntityToMemory(db, mentionedId, "m1", { confidence: 0.9, sourceProject: "78sy6-repro", scope: "user" });
    await linkEntityToMemory(db, mentionedId, "m2", { confidence: 0.9, sourceProject: "78sy6-repro", scope: "user" });
    await linkEntityToMemory(db, mentionedId, "m3", { confidence: 0.9, sourceProject: "78sy6-repro", scope: "user" });

    // --- The batched aggregation under test ---
    const counts = await fetchMentionCounts(db);

    // --- Independent per-entity legacy-shape oracle ---
    const legacyMentioned = await legacyMentionCount(db, mentionedId);
    const legacyUnmentioned = await legacyMentionCount(db, unmentionedId);

    expect(legacyMentioned).toBe(3);
    expect(legacyUnmentioned).toBe(0);

    expect(counts.get(extractId(mentionedId))).toBe(legacyMentioned);
    expect(counts.get(extractId(mentionedId))).toBe(3);
    // Zero-count id is ABSENT from the aggregation's result set (GROUP BY only
    // returns groups that exist) — the caller's `?? 0` default must supply it.
    expect(counts.has(extractId(unmentionedId))).toBe(false);
    expect(counts.get(extractId(unmentionedId)) ?? 0).toBe(legacyUnmentioned);
  });

  it("issues exactly ONE query for the whole export, not one per entity", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const queries: string[] = [];
    const countingDb = {
      query: (async (sql: string, vars?: Record<string, unknown>) => {
        queries.push(sql);
        return db.query(sql, vars);
      }) as SurrealClient["query"],
    } as SurrealClient;

    await fetchMentionCounts(countingDb);

    const aggregationQueries = queries.filter((sql) => sql.includes("GROUP BY in"));
    expect(aggregationQueries).toHaveLength(1);
  });
});
