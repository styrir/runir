/**
 * schema-migrations.test.ts — Real-DB integration test for the versioned schema
 * migration framework (Rúnir-n7ze.13).
 *
 * Uses an isolated SurrealDB database so it cannot corrupt prod/dev state.
 * Self-skips when no local SurrealDB is reachable (mirrors the
 * entity-consolidation-repro.test.ts pattern).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import {
  runSchemaMigrations,
  ensureSchemaMigrationsTable,
  type Migration,
} from "../storage/surreal/migrations.js";

const TEST_DB = "schema_migrations_test";

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
  // Clean slate: remove the bookkeeping table and semiote so each test subcase
  // starts fresh.  REMOVE TABLE IF EXISTS is idempotent.
  await db
    .query(
      "REMOVE TABLE IF EXISTS schema_migrations; REMOVE TABLE IF EXISTS semiote;",
    )
    .catch(() => {});
  await db.query("DEFINE TABLE IF NOT EXISTS semiote SCHEMALESS;");
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

describe("runSchemaMigrations", () => {
  // (a) First run: applies migration v1, records the row, index is absent.
  it(
    "applies version 1 and records it in schema_migrations",
    async (ctx) => {
      if (!dbAvailable) ctx.skip();

      // Use a tiny registry containing only v1 (the real migration 1).
      const registry: Migration[] = [
        {
          version: 1,
          name: "drop-redundant-idx-semiote-fact-key",
          up: async (d) => {
            await d.query(
              "REMOVE INDEX IF EXISTS idx_semiote_fact_key ON TABLE semiote;",
            );
          },
        },
      ];

      const result = await runSchemaMigrations(db, registry);
      expect(result.applied).toEqual([1]);
      expect(result.skipped).toEqual([]);

      // schema_migrations must have exactly one row for version 1.
      // db.query<T> returns T[][] — rows[0] is the row array for statement 0.
      const rows = await db.query<{ version: number; name: string }>(
        "SELECT version, name FROM schema_migrations;",
      );
      const records = Array.isArray(rows[0])
        ? (rows[0] as unknown as { version: number; name: string }[])
        : [];
      expect(records).toHaveLength(1);
      expect(records[0].version).toBe(1);
      expect(records[0].name).toBe("drop-redundant-idx-semiote-fact-key");

      // The index should not exist (REMOVE IF EXISTS already handled it).
      // INFO FOR TABLE returns index definitions; idx_semiote_fact_key must be absent.
      const info = await db.query<Record<string, unknown>[]>(
        "INFO FOR TABLE semiote;",
      );
      const infoObj = Array.isArray(info[0]) ? info[0][0] : info[0];
      const indexes =
        (infoObj as { indexes?: Record<string, unknown> } | undefined)
          ?.indexes ?? {};
      expect(Object.keys(indexes)).not.toContain("idx_semiote_fact_key");
    },
    20000,
  );

  // (b) Second run: idempotent — returns skipped:[1], no duplicate row.
  it(
    "second run is a no-op (skipped:[1], no duplicate schema_migrations row)",
    async (ctx) => {
      if (!dbAvailable) ctx.skip();

      const registry: Migration[] = [
        {
          version: 1,
          name: "drop-redundant-idx-semiote-fact-key",
          up: async (d) => {
            await d.query(
              "REMOVE INDEX IF EXISTS idx_semiote_fact_key ON TABLE semiote;",
            );
          },
        },
      ];

      const result = await runSchemaMigrations(db, registry);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual([1]);

      // Still exactly one row — no duplicate created.
      const rows = await db.query<{ version: number }>(
        "SELECT version FROM schema_migrations;",
      );
      const records = Array.isArray(rows[0])
        ? (rows[0] as unknown as { version: number }[])
        : [];
      expect(records).toHaveLength(1);
    },
    20000,
  );

  // (c) Registry with a duplicate version must throw a clear config error.
  it(
    "throws on duplicate version in registry",
    async (ctx) => {
      if (!dbAvailable) ctx.skip();

      const badRegistry: Migration[] = [
        { version: 2, name: "alpha", up: async () => {} },
        { version: 2, name: "beta", up: async () => {} },
      ];

      await expect(
        runSchemaMigrations(db, badRegistry),
      ).rejects.toThrow(/duplicate version 2/i);
    },
    20000,
  );

  // (d) A migration whose up() throws: not recorded, later migrations don't run,
  //     error propagates.
  it(
    "stops on up() failure, does not record the failed migration, skips later ones",
    async (ctx) => {
      if (!dbAvailable) ctx.skip();

      // Clean the bookkeeping table so v10/v11 are fresh.
      await db.query(
        "DELETE schema_migrations WHERE version IN [10, 11];",
      );

      let laterRan = false;
      const registry: Migration[] = [
        {
          version: 10,
          name: "will-fail",
          up: async () => {
            throw new Error("intentional failure for test");
          },
        },
        {
          version: 11,
          name: "should-not-run",
          up: async () => {
            laterRan = true;
          },
        },
      ];

      await expect(
        runSchemaMigrations(db, registry),
      ).rejects.toThrow("intentional failure for test");

      // v10 must NOT be recorded.
      const rows = await db.query<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version IN [10, 11];",
      );
      const records = Array.isArray(rows[0])
        ? (rows[0] as unknown as { version: number }[])
        : [];
      expect(records.map((r) => r.version)).not.toContain(10);

      // v11 must not have run.
      expect(laterRan).toBe(false);
    },
    20000,
  );
});
