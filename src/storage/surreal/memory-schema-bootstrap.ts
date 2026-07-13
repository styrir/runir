import type { SurrealClient } from "./surreal-client.js";

export async function ensureBm25Index(db: SurrealClient): Promise<void> {
  await db.query(
    "DEFINE ANALYZER IF NOT EXISTS mem_analyzer TOKENIZERS blank,class FILTERS lowercase,snowball(english);",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS text_norm ON TABLE memories TYPE option<string>;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS memories_text_bm25 ON TABLE memories COLUMNS text_norm FULLTEXT ANALYZER mem_analyzer BM25;",
  );
  // 52e.6: scope metadata fields — option<string> so existing records (scope=NONE) remain valid.
  await db.query(
    "DEFINE FIELD IF NOT EXISTS scope ON TABLE memories TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS session_id ON TABLE memories TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS active ON TABLE memories TYPE option<bool>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS inactive_at ON TABLE memories TYPE option<datetime>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS inactive_reason ON TABLE memories TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS superseded_by ON TABLE memories TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS supersedes ON TABLE memories TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS lineage_root_id ON TABLE memories TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS supersede_provenance ON TABLE memories TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS archived ON TABLE memories TYPE option<bool>;",
  );
}

export async function ensureMemoryEnrichmentSchema(db: SurrealClient): Promise<void> {
  await db.query(`
    DEFINE FIELD IF NOT EXISTS payload.l0 ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.l1 ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.category ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.tier ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.factKey ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.writeSource ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.accessCount ON TABLE memories TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS payload.lastAccessedAt ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.tags ON TABLE memories TYPE option<array>;
    DEFINE FIELD IF NOT EXISTS payload.directives ON TABLE memories TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS payload.path ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.memoryRole ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.validAt ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.invalidAt ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.continuitySubjectKey ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.confidence ON TABLE memories TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS payload.raw_source_text ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.rawSpan ON TABLE memories TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS payload.rawSpans ON TABLE memories TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS payload.atomicFact ON TABLE memories TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS payload.event ON TABLE memories TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS payload.atomicClaims ON TABLE memories TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS path ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS memory_role ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS valid_at ON TABLE memories TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS invalid_at ON TABLE memories TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS confidence ON TABLE memories TYPE option<number>;
    DEFINE INDEX IF NOT EXISTS idx_memories_factKey ON TABLE memories COLUMNS payload.factKey;
    DEFINE INDEX IF NOT EXISTS idx_memories_category ON TABLE memories COLUMNS payload.category;
    DEFINE INDEX IF NOT EXISTS idx_memories_tier ON TABLE memories COLUMNS payload.tier;
  `);
  await db.query(`
    DEFINE FIELD IF NOT EXISTS payload.l0 ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.l1 ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.category ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.tier ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.factKey ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.writeSource ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.accessCount ON TABLE semiote TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS payload.lastAccessedAt ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.tags ON TABLE semiote TYPE option<array>;
    DEFINE FIELD IF NOT EXISTS payload.directives ON TABLE semiote TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS payload.path ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.memoryRole ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.validAt ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.invalidAt ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.continuitySubjectKey ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.confidence ON TABLE semiote TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS payload.raw_source_text ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.rawSpan ON TABLE semiote TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS payload.rawSpans ON TABLE semiote TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS payload.atomicFact ON TABLE semiote TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS payload.event ON TABLE semiote TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS payload.atomicClaims ON TABLE semiote TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS payload.semiosis ON TABLE semiote TYPE option<object>;
    DEFINE INDEX IF NOT EXISTS idx_semiote_factKey ON TABLE semiote COLUMNS payload.factKey;
    DEFINE INDEX IF NOT EXISTS idx_semiote_category ON TABLE semiote COLUMNS payload.category;
    DEFINE INDEX IF NOT EXISTS idx_semiote_tier ON TABLE semiote COLUMNS payload.tier;
  `);
}


export async function ensureAttributionFields(db: SurrealClient): Promise<void> {
  await db.query(`
    DEFINE FIELD IF NOT EXISTS payload.path ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.client ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.isStale ON TABLE memories TYPE option<bool>;
    DEFINE FIELD IF NOT EXISTS payload.staleSince ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.contradictedBy ON TABLE memories TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS payload.hasPath ON TABLE memories TYPE option<bool>;
  `);
}
