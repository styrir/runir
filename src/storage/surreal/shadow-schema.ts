/**
 * Rúnir-pn1l.13.4 — supersede_shadow schema version + field-name constants.
 *
 * U5 bumps the shadow schema to `supersede_shadow_v2`, adding three referent-identity
 * columns so adjudicators can see (a) that a `deterministic_text` nomination was
 * BLOCKED for lack of a proven referent identity, and (b) the referent verdict/proof
 * that drove — or vetoed — a retirement. All three are `option<string>`, so existing
 * v1 rows (which never set them) stay valid; the table is additive, not recreated.
 *
 * Single source of truth for the field names shared between the DDL
 * (`ensureSupersedeShadowTable`) and the writer (`logSupersedeShadow`).
 *
 * Rúnir-pn1l.13.6 adds three MORE additive `option<string>` columns (Item A: no new
 * schema-version bump — same `supersede_shadow_v2` generation, per the brief's P3: old
 * rows are distinguishable only by NONE/missing columns, not by a manifest schema string):
 * full untruncated incoming text, incoming tags (JSON string), and a point-in-time
 * candidate content snapshot (JSON string) for offline replay.
 */
export const SUPERSEDE_SHADOW_SCHEMA_VERSION = "supersede_shadow_v2";

/** New v2 field names (all `option<string>`). */
export const SHADOW_FIELD_WOULD_NOMINATION_BLOCKED = "would_nomination_blocked";
export const SHADOW_FIELD_REFERENT_VERDICT = "referent_verdict";
export const SHADOW_FIELD_REFERENT_PROOF = "referent_proof";

/** Rúnir-pn1l.13.6 (Item B) field names (all `option<string>`). */
export const SHADOW_FIELD_INCOMING_TEXT_FULL = "incoming_text_full";
export const SHADOW_FIELD_INCOMING_TAGS_JSON = "incoming_tags_json";
export const SHADOW_FIELD_CANDIDATE_SNAPSHOT_JSON = "candidate_snapshot_json";

/**
 * Rúnir-pn1l.13.7 D5 — per-step UUID for seeded-replay shadow correlation.
 * Unique by construction (minted per replay step); prod callers never set it.
 * Additive `option<string>` so pre-existing rows stay valid (NONE).
 */
export const SHADOW_FIELD_CORRELATION_ID = "shadow_correlation_id";

/**
 * Rúnir-h435.1 PIN-3/PIN-4 — additive cross-lane join key on supersede_shadow.
 * Stamped with the per-write-event UUID minted at arbitrateWrite entry.
 */
export const SHADOW_FIELD_WRITE_EVENT_ID = "write_event_id";

/** Rúnir-h435.1 — three atomic-isolated frame tables (SCHEMAFULL). */
export const ATOMIC_SHADOW_ATTEMPT_TABLE = "atomic_shadow_attempt";
export const ATOMIC_SHADOW_EVENT_TABLE = "atomic_shadow_event";
export const ATOMIC_SHADOW_NOMINATION_TABLE = "atomic_shadow_nomination";
