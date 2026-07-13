import type { SurrealClient } from "../../storage/surreal/surreal-store.js";

/** Ensures salience_prototypes, salience_centroids, and salience_audit_log tables exist. */
export async function ensureSalienceSchema(db: SurrealClient): Promise<void> {
  // --- salience_prototypes ---
  await db.query("DEFINE TABLE IF NOT EXISTS salience_prototypes SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS id ON TABLE salience_prototypes TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS text ON TABLE salience_prototypes TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS embedding ON TABLE salience_prototypes TYPE array<float>;");
  await db.query("DEFINE FIELD IF NOT EXISTS polarity ON TABLE salience_prototypes TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS salience_type ON TABLE salience_prototypes TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS seed_source ON TABLE salience_prototypes TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS active ON TABLE salience_prototypes TYPE bool;");
  await db.query("DEFINE FIELD IF NOT EXISTS created_at ON TABLE salience_prototypes TYPE datetime;");
  await db.query("DEFINE FIELD IF NOT EXISTS updated_at ON TABLE salience_prototypes TYPE datetime;");

  // --- salience_centroids ---
  await db.query("DEFINE TABLE IF NOT EXISTS salience_centroids SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS id ON TABLE salience_centroids TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS embedding ON TABLE salience_centroids TYPE array<float>;");
  await db.query("DEFINE FIELD IF NOT EXISTS member_count ON TABLE salience_centroids TYPE int;");
  await db.query("DEFINE FIELD IF NOT EXISTS prototype_version ON TABLE salience_centroids TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS updated_at ON TABLE salience_centroids TYPE datetime;");

  // --- salience_audit_log ---
  await db.query("DEFINE TABLE IF NOT EXISTS salience_audit_log SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS id ON TABLE salience_audit_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS session_id ON TABLE salience_audit_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS candidate_text ON TABLE salience_audit_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS candidate_embedding ON TABLE salience_audit_log TYPE array<float>;");
  await db.query("DEFINE FIELD IF NOT EXISTS best_matching_type ON TABLE salience_audit_log TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS prototype_gap ON TABLE salience_audit_log TYPE float;");
  await db.query("DEFINE FIELD IF NOT EXISTS novelty ON TABLE salience_audit_log TYPE float;");
  await db.query("DEFINE FIELD IF NOT EXISTS lexical_density ON TABLE salience_audit_log TYPE float;");
  await db.query("DEFINE FIELD IF NOT EXISTS causal_markers ON TABLE salience_audit_log TYPE float;");
  await db.query("DEFINE FIELD IF NOT EXISTS specificity ON TABLE salience_audit_log TYPE float;");
  await db.query("DEFINE FIELD IF NOT EXISTS final_score ON TABLE salience_audit_log TYPE float;");
  await db.query("DEFINE FIELD IF NOT EXISTS threshold ON TABLE salience_audit_log TYPE float;");
  await db.query("DEFINE FIELD IF NOT EXISTS decision ON TABLE salience_audit_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS scorer_version ON TABLE salience_audit_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS embedder_version ON TABLE salience_audit_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS prototype_version ON TABLE salience_audit_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS created_at ON TABLE salience_audit_log TYPE datetime;");
  await db.query("DEFINE FIELD IF NOT EXISTS human_label ON TABLE salience_audit_log TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS label_notes ON TABLE salience_audit_log TYPE option<string>;");
}
