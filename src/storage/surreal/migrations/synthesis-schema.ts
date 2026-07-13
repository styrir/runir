/**
 * synthesis-schema.ts — Code-6q9
 * DDL for memory_clusters, synthesis_notes tables and enrichment fields on memories.
 * Run idempotently via ensureSynthesisSchema().
 */

import type { SurrealClient } from "../surreal-store.js";

export async function ensureSynthesisSchema(db: SurrealClient): Promise<void> {
  // memory_clusters table
  await db.query(`DEFINE TABLE IF NOT EXISTS memory_clusters SCHEMAFULL;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS fingerprintId ON TABLE memory_clusters TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS label       ON TABLE memory_clusters TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS memoryIds   ON TABLE memory_clusters TYPE array;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS entityIds   ON TABLE memory_clusters TYPE array;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS size        ON TABLE memory_clusters TYPE int;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS method      ON TABLE memory_clusters TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS synthesisId ON TABLE memory_clusters TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS createdAt   ON TABLE memory_clusters TYPE datetime DEFAULT time::now();`);
  await db.query(`DEFINE FIELD IF NOT EXISTS updatedAt   ON TABLE memory_clusters TYPE datetime DEFAULT time::now() VALUE time::now();`);
  await db.query(`DEFINE INDEX IF NOT EXISTS idx_memory_clusters_fingerprint ON TABLE memory_clusters FIELDS fingerprintId UNIQUE;`);

  // synthesis_notes table
  await db.query(`DEFINE TABLE IF NOT EXISTS synthesis_notes SCHEMAFULL;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS l0              ON TABLE synthesis_notes TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS l1              ON TABLE synthesis_notes TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS l2              ON TABLE synthesis_notes TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS clusterId       ON TABLE synthesis_notes TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS memoryIds       ON TABLE synthesis_notes TYPE array;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS entityIds       ON TABLE synthesis_notes TYPE array;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS entityNames     ON TABLE synthesis_notes TYPE array DEFAULT [];`);
  await db.query(`DEFINE FIELD IF NOT EXISTS tags            ON TABLE synthesis_notes TYPE array;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS para_placement  ON TABLE synthesis_notes TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS lastMemoryCount ON TABLE synthesis_notes TYPE int;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS updateCount     ON TABLE synthesis_notes TYPE int DEFAULT 0;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS createdAt       ON TABLE synthesis_notes TYPE datetime DEFAULT time::now();`);
  await db.query(`DEFINE FIELD IF NOT EXISTS updatedAt       ON TABLE synthesis_notes TYPE datetime DEFAULT time::now() VALUE time::now();`);

  // New fields on memories table (additive)
  await db.query(`DEFINE FIELD IF NOT EXISTS enriched_at ON TABLE memories TYPE option<datetime>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS para_hint   ON TABLE memories TYPE option<string>;`);
}
