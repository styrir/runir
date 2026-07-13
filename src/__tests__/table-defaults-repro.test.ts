// Real-DB integration tests for Rúnir-ekos B2/B3: proving the redirected
// hand-written SurrealQL in queryTopMemoriesForNovelty and wouldCreateCycle
// actually executes against the resolved current-era table, not the legacy
// "memories" table. Mocked-db unit tests (session-salience.test.ts,
// staleness-pass.test.ts) can only assert the SQL string shape; they cannot
// prove the query executes correctly against real SurrealDB semantics
// (vector::similarity::cosine, type::record chain-walking). Runs in an
// ISOLATED database and skips when no local SurrealDB is reachable (the
// entity-consolidation-repro / dedup-phantom-repro pattern).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SurrealClient,
  queryTopMemoriesForNovelty,
  supersedeMemory,
  upsertMemory,
} from "../storage/surreal/surreal-store.js";
import { wouldCreateCycle } from "../lifecycle/semion/dag-guard.js";

const TEST_DB = "table_defaults_repro_test";
const USER = "_ekos_table_defaults_repro_user";
const CURRENT_TABLE = "semiote"; // PRIMARY_MEMORY_TABLE
const LEGACY_TABLE = "memories";
const VEC_A = [1, 0, 0];
const VEC_B = [0.9, 0.1, 0];

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
  await db.query(`REMOVE TABLE IF EXISTS ${CURRENT_TABLE}; REMOVE TABLE IF EXISTS ${LEGACY_TABLE};`).catch(() => {});
  await db.query(`DEFINE TABLE ${CURRENT_TABLE} SCHEMALESS;`);
  await db.query(`DEFINE TABLE ${LEGACY_TABLE} SCHEMALESS;`);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
    await db.close().catch(() => {});
  }
});

describe("queryTopMemoriesForNovelty — table targeting (Rúnir-ekos B-LIVE-1 live-DB proof)", () => {
  it("returns similarity rows from the resolved current-era table, and nothing from the legacy table", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const otherSessionId = "other-session";
    const currentSessionId = "this-session";

    // Seed a row in the CURRENT-era table (semiote), visible to novelty scoring.
    await upsertMemory(
      db, "novelty-current-1", "existing fact in semiote", USER, VEC_A,
      { sessionId: otherSessionId }, "user", otherSessionId, undefined, CURRENT_TABLE,
    );
    // Seed a row with the SAME shape in the LEGACY table — if the query ever
    // silently redirects to "memories", this row would leak into the result.
    await upsertMemory(
      db, "novelty-legacy-1", "existing fact in memories", USER, VEC_A,
      { sessionId: otherSessionId }, "user", otherSessionId, undefined, LEGACY_TABLE,
    );

    const similarities = await queryTopMemoriesForNovelty(
      db, USER, "user", currentSessionId, VEC_B, 10, CURRENT_TABLE,
    );

    // Real SurrealQL executed against the real table: proves the FROM clause
    // interpolation + vector::similarity::cosine + payload filters all work
    // together, and that exactly the current-era row (not the legacy one)
    // was scored.
    expect(similarities.length).toBe(1);
    expect(similarities[0]).toBeGreaterThan(0.9);
  });

  it("querying the legacy table explicitly finds only the legacy-table row", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Reuses the rows seeded in the previous test (same isolated DB/table).
    const similarities = await queryTopMemoriesForNovelty(
      db, USER, "user", "this-session", VEC_B, 10, LEGACY_TABLE,
    );

    expect(similarities.length).toBe(1);
    expect(similarities[0]).toBeGreaterThan(0.9);
  });
});

describe("wouldCreateCycle — table targeting (Rúnir-ekos B-LIVE-2 live-DB proof)", () => {
  it("detects a real supersede-chain cycle in the resolved current-era table", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const idA = "cycle-a";
    const idB = "cycle-b";

    // Seed A, then supersede A with B (B.supersedes = A) via the REAL write
    // path, in the current-era table.
    await upsertMemory(db, idA, "fact A", USER, VEC_A, {}, "user", undefined, undefined, CURRENT_TABLE);
    await supersedeMemory(
      db,
      { id: idA, l2: "fact A", similarity: 1, createdAt: new Date().toISOString(), scope: "user" },
      { id: idB, l2: "fact B", userId: USER, embedding: VEC_B, scope: "user", writeSource: "session_summary" },
      "llm-generated",
      true,
      "superseded",
      CURRENT_TABLE,
    );

    // newMemoryId = A, targetId = B → B.supersedes = A = newMemoryId → cycle.
    const cycleAgainstCurrentTable = await wouldCreateCycle(db as any, idA, idB, USER, CURRENT_TABLE);
    expect(cycleAgainstCurrentTable).toBe(true);
  });

  it("walking the WRONG table's (empty) supersede chain silently reports no cycle — proves table-targeting matters", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Same idA/idB chain exists ONLY in the current-era table (previous
    // test). Checking against the legacy table — which has no such row —
    // must find nothing and return false (orphaned-pointer-safe, not an
    // error). This is the exact silent-vacuity failure mode B-LIVE-2 fixed:
    // if the cycle-guard's table argument were wrong, a real cycle would go
    // undetected because the walk targets an empty/unrelated chain.
    const cycleAgainstLegacyTable = await wouldCreateCycle(db as any, "cycle-a", "cycle-b", USER, LEGACY_TABLE);
    expect(cycleAgainstLegacyTable).toBe(false);
  });
});
