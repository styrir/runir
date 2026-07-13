import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SurrealClient,
  upsertMemory,
  supersedeMemory,
} from "../storage/surreal/surreal-store.js";
import type { SimilarCandidate } from "../domain/memory/types";

// Real-DB proof that supersedeMemory runs as ONE atomic transaction
// (Rúnir-n7ze.4 / ADOPT-NOW #4.3): the branch write (EXISTS bookkeeping-only, or
// the inlined fresh upsert) plus both tail UPDATEs either all commit or all roll
// back. Isolated per-file database, dropped in afterAll; self-skips when no
// SurrealDB is reachable.

const TEST_DB = "supersede_txn_test";
const USER = "_supersede_txn_user";
const TABLE = "semiote";
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

type Row = {
  active?: boolean;
  supersedes?: unknown;
  superseded_by?: unknown;
  payload?: { confidence?: number; supersede_provenance?: string };
};

async function getRow(id: string): Promise<Row | undefined> {
  const res = await db.query<Row>(
    `SELECT active, supersedes, superseded_by, payload FROM type::record('${TABLE}', $id);`,
    { id },
  );
  return res[0]?.[0];
}

async function countRows(): Promise<number> {
  const res = await db.query<{ total: number }>(
    `SELECT count() AS total FROM ${TABLE} GROUP ALL;`,
  );
  return res[0]?.[0]?.total ?? 0;
}

const PREV_ID = "11111111-aaaa-4aaa-8aaa-111111111111";
const REPL_ID = "22222222-bbbb-4bbb-8bbb-222222222222";

function prevCandidate(): SimilarCandidate {
  return {
    id: PREV_ID,
    l2: "older fact",
    similarity: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    scope: "user",
  } as SimilarCandidate;
}

describe("supersedeMemory — atomic supersede transaction (Rúnir-n7ze.4)", () => {
  it("commits the FRESH-id branch (new replacement + previous inactivation)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await db.query(`DELETE ${TABLE};`);
    await upsertMemory(db, PREV_ID, "older fact", USER, VEC, {}, "user", undefined, undefined, TABLE);

    await supersedeMemory(
      db,
      prevCandidate(),
      { id: REPL_ID, l2: "newer fact", userId: USER, embedding: VEC, scope: "user", writeSource: "session_summary" },
      "deterministic",
      undefined,
      "superseded",
      TABLE,
    );

    const repl = await getRow(REPL_ID);
    const prev = await getRow(PREV_ID);
    expect(repl?.active).toBe(true);
    expect(repl?.supersedes).toBeTruthy(); // points at the previous lineage
    expect(prev?.active).toBe(false);
    expect(prev?.superseded_by).toBeTruthy();
  }, 20000);

  it("commits the EXISTS branch as bookkeeping-only (survivor payload preserved, Rúnir-xxa9)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await db.query(`DELETE ${TABLE};`);
    await upsertMemory(db, PREV_ID, "older fact", USER, VEC, {}, "user", undefined, undefined, TABLE);
    // Replacement already exists with a rich payload that must NOT be gutted.
    await upsertMemory(db, REPL_ID, "survivor fact", USER, VEC, { confidence: 0.93 }, "user", undefined, undefined, TABLE);

    await supersedeMemory(
      db,
      prevCandidate(),
      { id: REPL_ID, l2: "survivor fact", userId: USER, embedding: VEC, scope: "user", writeSource: "session_summary" },
      "llm-generated",
      true,
      "superseded",
      TABLE,
    );

    const repl = await getRow(REPL_ID);
    const prev = await getRow(PREV_ID);
    expect(repl?.active).toBe(true);
    expect(repl?.supersedes).toBeTruthy();
    // xxa9: bookkeeping-only must preserve the survivor's pre-existing payload.
    expect(repl?.payload?.confidence).toBe(0.93);
    expect(prev?.active).toBe(false);
    expect(prev?.superseded_by).toBeTruthy();
  }, 20000);

  it("rolls back the FRESH branch atomically (previous stays active, replacement absent)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await db.query(`DELETE ${TABLE};`);
    await upsertMemory(db, PREV_ID, "older fact", USER, VEC, {}, "user", undefined, undefined, TABLE);
    const before = await countRows();

    const orig = db.queryTransaction.bind(db);
    (db as unknown as {
      queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
    }).queryTransaction = (body: string, vars?: Record<string, unknown>) =>
      orig(`${body}\nTHROW "supersede rollback probe";`, vars);
    try {
      await expect(
        supersedeMemory(
          db,
          prevCandidate(),
          { id: REPL_ID, l2: "newer fact", userId: USER, embedding: VEC, scope: "user", writeSource: "session_summary" },
          "deterministic",
          undefined,
          "superseded",
          TABLE,
        ),
      ).rejects.toThrow(/transaction failed/);
    } finally {
      (db as unknown as {
        queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
      }).queryTransaction = orig;
    }

    // Replacement was never created; previous is still active.
    expect(await countRows()).toBe(before);
    expect(await getRow(REPL_ID)).toBeUndefined();
    expect((await getRow(PREV_ID))?.active).toBe(true);
  }, 20000);

  it("rolls back the EXISTS branch atomically (previous stays active, survivor un-bookkept)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await db.query(`DELETE ${TABLE};`);
    await upsertMemory(db, PREV_ID, "older fact", USER, VEC, {}, "user", undefined, undefined, TABLE);
    await upsertMemory(db, REPL_ID, "survivor fact", USER, VEC, { confidence: 0.93 }, "user", undefined, undefined, TABLE);

    const orig = db.queryTransaction.bind(db);
    (db as unknown as {
      queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
    }).queryTransaction = (body: string, vars?: Record<string, unknown>) =>
      orig(`${body}\nTHROW "supersede rollback probe";`, vars);
    try {
      await expect(
        supersedeMemory(
          db,
          prevCandidate(),
          { id: REPL_ID, l2: "survivor fact", userId: USER, embedding: VEC, scope: "user", writeSource: "session_summary" },
          "llm-generated",
          true,
          "superseded",
          TABLE,
        ),
      ).rejects.toThrow(/transaction failed/);
    } finally {
      (db as unknown as {
        queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
      }).queryTransaction = orig;
    }

    // Previous stays active; the survivor's supersedes bookkeeping never landed.
    expect((await getRow(PREV_ID))?.active).toBe(true);
    expect((await getRow(REPL_ID))?.supersedes ?? null).toBeNull();
  }, 20000);
});
