/**
 * migrations.ts — Versioned schema migration framework (Rúnir-n7ze.13)
 *
 * Runs on every prod boot via runDeploymentPreflight. Each migration's `up`
 * function MUST be idempotent (safe to re-run), since a crash after `up`
 * succeeds but before the schema_migrations row is recorded will cause the
 * next boot to re-execute `up`. Use `db.queryTransaction` for multi-statement
 * atomicity within a migration.
 *
 * Boot safety:
 * - Under strict=true (prod default) a migration failure throws and halts boot.
 * - Under strict=false the runCheck caller logs the failure and continues.
 * - Migrations run in ascending version order; a failure stops the sequence
 *   (later migrations are NOT applied out-of-order).
 */

import type { SurrealClient } from "./surreal-store.js";

export interface Migration {
  /** Positive integer, unique across MIGRATIONS. Used as the schema_migrations record id. */
  version: number;
  /** Human-readable label stored with the migration record. */
  name: string;
  /**
   * Apply this migration. MUST be idempotent — if `up` succeeds but the
   * schema_migrations record write fails (crash window), the next boot will
   * re-run `up`. All `up` implementations must tolerate that scenario.
   *
   * Use `db.queryTransaction(body, vars)` when the migration contains multiple
   * dependent statements that must be atomic.
   */
  up: (db: SurrealClient) => Promise<void>;
}

/**
 * Registry of all versioned migrations. Add new entries here; versions must be
 * unique positive integers. The runner sorts ascending and validates uniqueness
 * at startup — a duplicate/invalid version is a hard config error.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "drop-redundant-idx-semiote-fact-key",
    up: async (db: SurrealClient): Promise<void> => {
      // Idempotent: REMOVE IF EXISTS is a no-op when the index is absent.
      // On prod the index was already dropped live (Rúnir-n7ze.8); this
      // migration records that fact durably so it never runs again.
      await db.query("REMOVE INDEX IF EXISTS idx_semiote_fact_key ON TABLE semiote;");
    },
  },
];

/**
 * Ensure the schema_migrations bookkeeping table exists.
 * Idempotent — safe to call on every boot.
 */
export async function ensureSchemaMigrationsTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS schema_migrations SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS version ON TABLE schema_migrations TYPE int;");
  await db.query("DEFINE FIELD IF NOT EXISTS name ON TABLE schema_migrations TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS applied_at ON TABLE schema_migrations TYPE datetime;");
}

/**
 * Run pending schema migrations against `db`.
 *
 * @param db        - SurrealClient connected to the target namespace/database.
 * @param migrations - Migration registry (defaults to MIGRATIONS). Override in tests.
 * @param logger    - Optional single-arg logging function (receives a string message).
 * @returns { applied, skipped } — version numbers applied this run vs already present.
 *
 * Fail-safe: if any migration's `up` throws, the error is re-thrown immediately and
 * no subsequent migrations are executed. A failed migration is NOT recorded
 * (the next boot will retry it).
 */
export async function runSchemaMigrations(
  db: SurrealClient,
  migrations: Migration[] = MIGRATIONS,
  logger?: (msg: string) => void,
): Promise<{ applied: number[]; skipped: number[] }> {
  // (a) Validate the registry FIRST — before any DB I/O. A bad in-process
  //     registry is a programming error; failing here ensures it cannot mutate
  //     prod (e.g. create the schema_migrations table) before throwing.
  //     Versions must be unique, positive integers.
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new Error(
        `schema migration registry error: version ${m.version} on "${m.name}" is not a positive integer`,
      );
    }
    if (seen.has(m.version)) {
      throw new Error(
        `schema migration registry error: duplicate version ${m.version} (appears more than once)`,
      );
    }
    seen.add(m.version);
  }

  // Sort ascending so migrations always apply in version order.
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  // (b) Ensure the bookkeeping table exists.
  await ensureSchemaMigrationsTable(db);

  // (c) Read which versions have already been applied.
  const rows = await db.query<{ version: number }>("SELECT version FROM schema_migrations;");
  // db.query<T> returns T[][] — outer array is per-statement, inner array is rows.
  const appliedRows: { version: number }[] = Array.isArray(rows[0]) ? (rows[0] as unknown as { version: number }[]) : [];
  const appliedSet = new Set<number>(appliedRows.map((r) => r.version));

  const applied: number[] = [];
  const skipped: number[] = [];

  // (d) Apply un-applied migrations in order; fail-fast on error.
  for (const m of sorted) {
    if (appliedSet.has(m.version)) {
      skipped.push(m.version);
      continue;
    }

    // Run the migration. If this throws, we re-throw immediately — do NOT
    // record the migration and do NOT attempt later ones.
    await m.up(db);

    // Record that this migration was applied. Use the version as the record
    // id so a duplicate CREATE (crash+retry window) would error rather than
    // silently insert a second row — callers should treat this as idempotent
    // because the next boot would skip an already-present version.
    await db.query(
      "CREATE type::record('schema_migrations', $v) SET version = $v, name = $name, applied_at = time::now();",
      { v: m.version, name: m.name },
    );

    logger?.(`schema migration ${m.version} (${m.name}) applied`);
    applied.push(m.version);
  }

  return { applied, skipped };
}
