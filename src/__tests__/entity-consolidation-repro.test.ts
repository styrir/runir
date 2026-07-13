import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import {
  ensureEntityTables,
  upsertEntity,
  linkEntityToMemory,
  getSupportingMemoryIds,
  findEntityByName,
} from "../entities/entity-store.js";
import { entityIdSlug } from "../entities/entity-arbitrator.js";
import { promoteSessionEntities } from "../lifecycle/semion/entity-consolidation.js";

// Real-DB integration reproduction for Rúnir-imaf.12: forcing consolidation on
// conv-26 dropped entity recall 27 -> 0 because the promoted/merged user-scoped
// canonicals ended up with NO mentioned_in edges. The existing consolidation unit
// tests mock db.query, so they cannot catch this — it only manifests against a real
// SurrealDB (RecordId stringification + graph-edge cascade on vertex delete). This
// test runs in an ISOLATED database and is skipped when no local SurrealDB is up.

const TEST_DB = "imaf12_repro_test";
const USER = "_imaf12_repro_user";
const NOW = "2026-01-01T00:00:00.000Z";

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
  // Clean slate + schema in the isolated test DB.
  await db.query("REMOVE TABLE IF EXISTS entities; REMOVE TABLE IF EXISTS entity_edges; REMOVE TABLE IF EXISTS semiote;").catch(() => {});
  await ensureEntityTables(db);
  await db.query("DEFINE TABLE IF NOT EXISTS semiote SCHEMALESS;");
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

describe("promoteSessionEntities — edge preservation (Rúnir-imaf.12)", () => {
  it("keeps mentioned_in edges on the user canonical after promoting + merging session stubs", async (ctx) => {
    // Report a real SKIP (not a false pass) when no local SurrealDB is reachable, so
    // a DB-less CI run visibly does not exercise this regression (Codex imaf.12 review).
    if (!dbAvailable) ctx.skip();

    const base = {
      kind: "person" as const,
      canonicalName: "TestPerson",
      nameNorm: "testperson",
      userId: USER,
      sourceProject: "imaf12-repro",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      confidence: 0.9,
      aliases: [] as string[],
      aliasesNorm: [] as string[],
    };

    // Two session stubs of the SAME entity across two sessions: the first hits the
    // promote path (creates the user canonical), the second hits the merge path.
    const stub1 = await upsertEntity(db, { ...base, scope: "session", sessionId: "s1" });
    const stub2 = await upsertEntity(db, { ...base, scope: "session", sessionId: "s2" });
    expect(stub1).toBe(entityIdSlug("testperson", "person", USER, "session", "s1"));

    // A memory per session + a mentioned_in edge from each stub to its memory.
    await db.query("CREATE type::record('semiote', 'm1') SET payload = { userId: $u }; CREATE type::record('semiote', 'm2') SET payload = { userId: $u };", { u: USER });
    await linkEntityToMemory(db, stub1, "m1", { confidence: 0.9, sourceProject: "imaf12-repro", scope: "session", sessionId: "s1" });
    await linkEntityToMemory(db, stub2, "m2", { confidence: 0.9, sourceProject: "imaf12-repro", scope: "session", sessionId: "s2" });

    // Pre-condition: both session stubs have their supporting memory.
    expect((await getSupportingMemoryIds(db, stub1)).length).toBe(1);
    expect((await getSupportingMemoryIds(db, stub2)).length).toBe(1);

    // Consolidate.
    await promoteSessionEntities(db, USER);

    // The user-scoped canonical must exist…
    const canonicals = await findEntityByName(db, "testperson", "person", USER, "user");
    expect(canonicals.length).toBe(1);

    // …and it MUST retain the mentioned_in edges (both session memories). This is the
    // imaf.12 regression: pre-fix the canonical comes back with 0 supporting memories.
    const canonId = entityIdSlug("testperson", "person", USER, "user");
    const supporting = await getSupportingMemoryIds(db, canonId);
    const bareMemoryIds = supporting.map((s) => s.replace(/^[^:]+:/, "")).sort();
    expect(bareMemoryIds).toEqual(["m1", "m2"]);

    // And the session stubs should be gone.
    expect((await findEntityByName(db, "testperson", "person", USER, "session")).length).toBe(0);
  }, 20000);
});
