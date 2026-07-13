// Real-DB integration test for the continuity builder's evidence fetch
// (Rúnir-78sy.12). Exercises the REAL fetchNewSemiotes SQL against a real
// SurrealDB — the mocked-db builder tests (continuity-build.test.ts) cannot
// catch SurrealDB parse errors, which is exactly how this bug shipped:
// `SELECT id, session_id, payload FROM semiote ... ORDER BY payload.createdAt
// ASC` fails on real SurrealDB v3 with "Missing order idiom `payload.createdAt`
// in statement selection" (the ORDER BY idiom must appear in the projection).
// Skipped when no local SurrealDB is reachable (the entity-consolidation-repro
// pattern).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { fetchNewSemiotes } from "../lifecycle/semion/continuity-build.js";

const TEST_DB = "continuity_78sy12_repro_test";
const USER = "_78sy12_repro_user";
const PROJECT_KEY = "project:runir";

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
  await db.query("REMOVE TABLE IF EXISTS semiote;").catch(() => {});
  await db.query("DEFINE TABLE IF NOT EXISTS semiote SCHEMALESS;");
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
    await db.close().catch(() => {});
  }
});

describe("fetchNewSemiotes (Rúnir-78sy.12)", () => {
  it("executes the real SQL without a SurrealDB parse error and returns cursor-filtered rows ascending by createdAt", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Three rows, different payload.createdAt: one strictly below the cursor
    // (excluded), two above (included, returned oldest-first). project_key is
    // a TOP-LEVEL semiote field (phase2-store.ts:365), not nested in payload.
    await db.query(
      `CREATE type::record('semiote', 'sem_old') SET project_key = $pk, payload = { userId: $u, l2: 'old fact', createdAt: '2026-06-01T00:00:00.000Z' };
       CREATE type::record('semiote', 'sem_mid') SET project_key = $pk, payload = { userId: $u, l2: 'mid fact', createdAt: '2026-07-02T00:00:00.000Z' };
       CREATE type::record('semiote', 'sem_new') SET project_key = $pk, payload = { userId: $u, l2: 'new fact', createdAt: '2026-07-03T00:00:00.000Z' };`,
      { u: USER, pk: PROJECT_KEY },
    );

    const cursor = "2026-06-15T00:00:00.000Z"; // excludes sem_old, includes sem_mid + sem_new
    const rows = await fetchNewSemiotes(db, USER, { projectIdKey: PROJECT_KEY }, cursor, 40);

    expect(rows.map((r) => r.id)).toEqual(["sem_mid", "sem_new"]); // cursor-filtered, ascending (extractId strips the table prefix)
    expect(rows.map((r) => r.text)).toEqual(["mid fact", "new fact"]);
    expect(rows.map((r) => r.createdAt)).toEqual(["2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z"]);
  });

  it("returns all rows ascending when no cursor is set (first run)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const rows = await fetchNewSemiotes(db, USER, { projectIdKey: PROJECT_KEY }, null, 40);
    // All 3 seeded rows from the prior test (same isolated DB, ascending order).
    expect(rows.map((r) => r.id)).toEqual(["sem_old", "sem_mid", "sem_new"]);
  });
});
