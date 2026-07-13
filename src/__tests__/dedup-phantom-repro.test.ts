import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SurrealClient,
  upsertMemory,
  supersedeMemory,
  fetchAllActiveMemoriesForScope,
} from "../storage/surreal/surreal-store.js";

// Real-DB integration reproduction for Rúnir-5jiw: the consolidation dedup sweep
// never deduplicated anything. fetchAllActiveMemoriesForScope mapped ids with
// String(r.id) — for an SDK RecordId that yields 'semiote:uuid' — and
// supersedeMemory's type::record('semiote', $id) double-prefixed it to
// semiote:⟨semiote:uuid⟩. The deactivation UPDATE on the older duplicate hit a
// nonexistent record (silent no-op) while upsertMemory's UPSERT minted an ACTIVE
// phantom clone at the double-prefixed id. Mocked-db unit tests cannot catch
// this — it only manifests against real SurrealDB RecordId stringification —
// so this test runs in an ISOLATED database and skips when no SurrealDB is up.

const TEST_DB = "dedup_phantom_repro_test";
const USER = "_dedup_phantom_repro_user";
const TABLE = "semiote"; // PRIMARY_MEMORY_TABLE in consolidation.ts
const VEC = [1, 0, 0];

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
  await db.query(`REMOVE TABLE IF EXISTS ${TABLE};`).catch(() => {});
  await db.query(`DEFINE TABLE ${TABLE} SCHEMALESS;`);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

async function countRows(): Promise<number> {
  const res = await db.query<{ total: number }>(
    `SELECT count() AS total FROM ${TABLE} GROUP ALL;`,
  );
  return res[0]?.[0]?.total ?? 0;
}

describe("consolidation dedup supersede — no phantom clones (Rúnir-5jiw)", () => {
  it("returns bare ids from fetchAllActiveMemoriesForScope and supersedes in place", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // Two near-duplicate active memories; createdAt override via metadata makes
    // the older/newer ordering deterministic.
    const olderId = "11111111-aaaa-4aaa-8aaa-111111111111";
    const newerId = "22222222-bbbb-4bbb-8bbb-222222222222";
    await upsertMemory(db, olderId, "User lives in Oslo", USER, VEC,
      { createdAt: "2026-01-01T00:00:00.000Z" }, "user", undefined, undefined, TABLE);
    await upsertMemory(db, newerId, "The user lives in Oslo", USER, VEC,
      { createdAt: "2026-01-02T00:00:00.000Z" }, "user", undefined, undefined, TABLE);
    expect(await countRows()).toBe(2);

    // The mapper must hand back BARE ids: a table-prefixed 'semiote:uuid' here is
    // exactly what supersedeMemory double-prefixes into a phantom record.
    const fetched = await fetchAllActiveMemoriesForScope(db, USER, "user", 50, 0, TABLE);
    expect(fetched.map((m) => m.id).sort()).toEqual([olderId, newerId]);

    const older = fetched.find((m) => m.id === olderId)!;
    const newer = fetched.find((m) => m.id === newerId)!;

    // Mirror the consolidation dedup call exactly (consolidation.ts Step 1).
    await supersedeMemory(
      db,
      { id: older.id, l2: older.l2, similarity: 1, createdAt: older.createdAt, scope: "user" },
      {
        id: newer.id,
        l2: newer.l2,
        userId: USER,
        embedding: VEC,
        metadata: { inactive_reason: "consolidation-dedup" },
        scope: "user",
        writeSource: "session_summary",
      },
      "llm-generated",
      true,
      "superseded",
      TABLE,
    );

    // The older duplicate is deactivated for real (pre-fix: silent no-op).
    const olderRows = await db.query<{ active?: boolean; inactive_reason?: string }>(
      `SELECT active, inactive_reason FROM type::record('${TABLE}', $id);`,
      { id: olderId },
    );
    expect(olderRows[0]?.[0]?.active).toBe(false);
    expect(olderRows[0]?.[0]?.inactive_reason).toBe("superseded");

    // The newer survivor stays active, updated in place.
    const newerRows = await db.query<{ active?: boolean }>(
      `SELECT active FROM type::record('${TABLE}', $id);`,
      { id: newerId },
    );
    expect(newerRows[0]?.[0]?.active).toBe(true);

    // NO new record minted (pre-fix: an active phantom clone appears at the
    // double-prefixed id and the table grows to 3+).
    expect(await countRows()).toBe(2);
    const phantoms = await db.query<{ total: number }>(
      `SELECT count() AS total FROM ${TABLE}
       WHERE string::starts_with(<string>record::id(id), '${TABLE}:') GROUP ALL;`,
    );
    expect(phantoms[0]?.[0]?.total ?? 0).toBe(0);
  }, 20000);
});
