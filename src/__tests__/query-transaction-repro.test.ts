import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";

// Real-DB proof for the queryTransaction helper (Rúnir-n7ze.1 / ADOPT-NOW #4.0).
// Isolated by a unique per-file database on the shared "main" namespace; the
// whole DB is dropped in afterAll. Self-skips (ctx.skip) when no SurrealDB is
// reachable so it reports a SKIP rather than a false pass.

const TEST_DB = "txn_helper_repro_test";
const TABLE = "txn_probe";

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

describe("SurrealClient.queryTransaction — atomic BEGIN/COMMIT (Rúnir-n7ze.1)", () => {
  it("commits every statement (commit path == per-statement writes)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await db.query(`DELETE ${TABLE};`);

    await db.queryTransaction(
      `CREATE ${TABLE} SET n = 1;
       CREATE ${TABLE} SET n = 2;`,
    );

    expect(await countRows()).toBe(2);
  }, 20000);

  it("rolls back ALL writes when a later statement fails (zero partial rows)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await db.query(`DELETE ${TABLE};`);

    await expect(
      db.queryTransaction(
        `CREATE ${TABLE} SET n = 1;
         THROW "forced mid-transaction failure";`,
      ),
    ).rejects.toThrow(/transaction failed/);

    // The CREATE issued before the THROW must NOT have landed — the whole
    // transaction rolls back, so the probe table is empty.
    expect(await countRows()).toBe(0);
  }, 20000);

  it("rejects with the underlying error as cause", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    let caught: unknown;
    try {
      await db.queryTransaction(`THROW "boom";`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/transaction failed/);
    expect((caught as Error).cause).toBeDefined();
  }, 20000);

  it("does NOT false-positive a rollback on result DATA containing status:'ERR'", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await db.query(`DELETE ${TABLE};`);

    // A statement whose RESULT VALUE legitimately contains `status: "ERR"` must
    // commit normally — it is data, not an RPC error envelope. (Regression for
    // the removed per-statement status scan that would have mis-thrown here.)
    await db.queryTransaction(
      `CREATE ${TABLE} SET n = 1;
       RETURN { status: "ERR", note: "legit data, not a transaction failure" };`,
    );

    expect(await countRows()).toBe(1);
  }, 20000);
});

describe("SurrealClient.queryTransaction — no reconnect-retry (idempotency safety)", () => {
  it("does NOT retry on a connection error — raw driver called exactly once", async () => {
    // Bypass the constructor (no real network) so this runs without a DB and
    // deterministically proves the retry-once path in query() is NOT shared.
    let queryCalls = 0;
    let reconnectCalls = 0;
    const client = Object.create(SurrealClient.prototype) as SurrealClient;
    (client as unknown as { ready: Promise<void> }).ready = Promise.resolve();
    (client as unknown as {
      surreal: { query: () => Promise<unknown[]> };
    }).surreal = {
      query: async () => {
        queryCalls += 1;
        // The exact substring query() reconnect-retries on.
        throw new Error("ConnectionUnavailable");
      },
    };
    (client as unknown as { reconnect: () => Promise<void> }).reconnect =
      async () => {
        reconnectCalls += 1;
      };

    await expect(
      client.queryTransaction(`CREATE foo SET n = 1;`),
    ).rejects.toThrow(/transaction failed/);

    // query() would reconnect + re-run on "ConnectionUnavailable"; a
    // non-idempotent transaction must not be double-applied, so queryTransaction
    // calls the raw driver exactly once and never reconnects.
    expect(queryCalls).toBe(1);
    expect(reconnectCalls).toBe(0);
  });
});
