/**
 * Rúnir-h435.1 Unit A — A-3(iii) LIVE SQL merge-clear against native SurrealDB.
 *
 * Boundary: REAL updateMemoryText against 127.0.0.1:8000, isolated TEST_DB.
 * Do NOT start Docker (standing repo rule). Self-skips only when native DB is down
 * after a real connectivity probe (brief: report + stop; tests skip rather than fail
 * the suite when infra is absent so the rest of Unit A still gates).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SurrealClient,
  updateMemoryText,
  upsertMemory,
} from "../../surreal/surreal-store.js";
import { PRIMARY_MEMORY_TABLE } from "../../../domain/memory/types.js";

const TEST_DB = "h435_1_unit_a_merge_clear_test";
const USER = "_h435_1_merge_clear_user";
const TABLE = PRIMARY_MEMORY_TABLE; // "semiote"
const EMB = [0.1, 0.2, 0.3, 0.4];

const STORED_TRIPLE = {
  subject: "Atlas datastore",
  predicate: "primary_engine",
  value: "SurrealDB",
};

function makeDb(): SurrealClient {
  return new SurrealClient({
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
    // Brief: if native SurrealDB is down for A-3(iii), report and stop starting Docker.
    console.log(
      JSON.stringify({
        step: "A-3(iii)-live-sql",
        status: "skip",
        detail: "native SurrealDB 127.0.0.1:8000 unreachable — not starting Docker",
      }),
    );
    return;
  }
  await db.query(`REMOVE TABLE IF EXISTS ${TABLE};`).catch(() => {});
  await db.query(`DEFINE TABLE ${TABLE} SCHEMALESS;`);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
    await db.close().catch(() => {});
  }
});

async function readPayloadAtomicFact(id: string): Promise<unknown> {
  const rows = await db.query(
    `SELECT payload FROM type::record('${TABLE}', $id);`,
    { id },
  );
  const first = (rows as any)?.[0]?.[0];
  return first?.payload?.atomicFact;
}

describe("A-3(iii) updateMemoryText live SQL — atomicFact clear/retain", () => {
  it("clear → payload.atomicFact absent/NONE; retain → stored triple unchanged", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Seed row WITH a stored atomicFact via upsertMemory.
    const clearId = "merge-clear-live-1";
    await upsertMemory(
      db,
      clearId,
      "seeded text for clear path",
      USER,
      EMB,
      { atomicFact: { ...STORED_TRIPLE } },
      "user",
      undefined,
      undefined,
      TABLE,
    );
    expect(await readPayloadAtomicFact(clearId)).toEqual(STORED_TRIPLE);

    // REAL updateMemoryText with "clear".
    await updateMemoryText(
      db,
      clearId,
      "updated text after clear",
      EMB,
      "memory_store",
      "clear",
      undefined,
      TABLE,
    );
    const afterClear = await readPayloadAtomicFact(clearId);
    // Surreal may return null / undefined / absent for NONE.
    expect(afterClear === null || afterClear === undefined).toBe(true);

    // Seed another row for retain.
    const retainId = "merge-retain-live-1";
    await upsertMemory(
      db,
      retainId,
      "seeded text for retain path",
      USER,
      EMB,
      { atomicFact: { ...STORED_TRIPLE } },
      "user",
      undefined,
      undefined,
      TABLE,
    );
    expect(await readPayloadAtomicFact(retainId)).toEqual(STORED_TRIPLE);

    await updateMemoryText(
      db,
      retainId,
      "updated text after retain",
      EMB,
      "memory_store",
      "retain",
      undefined,
      TABLE,
    );
    expect(await readPayloadAtomicFact(retainId)).toEqual(STORED_TRIPLE);

    // Rest of SET behavior still updates l2.
    const l2Rows = await db.query(
      `SELECT payload FROM type::record('${TABLE}', $id);`,
      { id: retainId },
    );
    expect((l2Rows as any)?.[0]?.[0]?.payload?.l2).toBe("updated text after retain");
  });
});
