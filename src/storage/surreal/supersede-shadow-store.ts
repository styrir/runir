import type { SurrealClient } from "./surreal-client.js";
import {
  SHADOW_FIELD_WOULD_NOMINATION_BLOCKED,
  SHADOW_FIELD_REFERENT_VERDICT,
  SHADOW_FIELD_REFERENT_PROOF,
  SHADOW_FIELD_INCOMING_TEXT_FULL,
  SHADOW_FIELD_INCOMING_TAGS_JSON,
  SHADOW_FIELD_CANDIDATE_SNAPSHOT_JSON,
  SHADOW_FIELD_CORRELATION_ID,
  SHADOW_FIELD_WRITE_EVENT_ID,
} from "./shadow-schema.js";

export async function ensureSupersedeShadowTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS supersede_shadow SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS applied_memory_id ON TABLE supersede_shadow TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS user_id ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS scope ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS session_id ON TABLE supersede_shadow TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS source ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE supersede_shadow TYPE datetime;");
  await db.query("DEFINE FIELD IF NOT EXISTS applied_outcome ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS baseline_outcome ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS would_outcome ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS diverged ON TABLE supersede_shadow TYPE bool;");
  await db.query("DEFINE FIELD IF NOT EXISTS live_flags ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS would_matched_id ON TABLE supersede_shadow TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS would_cosine ON TABLE supersede_shadow TYPE option<float>;");
  await db.query("DEFINE FIELD IF NOT EXISTS would_signal ON TABLE supersede_shadow TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS would_reason ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS would_band ON TABLE supersede_shadow TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS baseline_matched_id ON TABLE supersede_shadow TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS baseline_band ON TABLE supersede_shadow TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS incoming_text_trunc ON TABLE supersede_shadow TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS stable_label ON TABLE supersede_shadow TYPE option<string>;");
  // Rúnir-pn1l.13.4 (U5) — supersede_shadow_v2 referent-identity columns. All option<string>
  // so pre-existing v1 rows (which never set them) stay valid; additive, table not recreated.
  await db.query(`DEFINE FIELD IF NOT EXISTS ${SHADOW_FIELD_WOULD_NOMINATION_BLOCKED} ON TABLE supersede_shadow TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS ${SHADOW_FIELD_REFERENT_VERDICT} ON TABLE supersede_shadow TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS ${SHADOW_FIELD_REFERENT_PROOF} ON TABLE supersede_shadow TYPE option<string>;`);
  // Rúnir-pn1l.13.6 (Item A/B) — additive columns on the SAME supersede_shadow_v2 generation
  // (no schema-version bump, per the brief's P3). Same idempotent option<string> pattern; no
  // backfill, NONE on all pre-existing rows.
  await db.query(`DEFINE FIELD IF NOT EXISTS ${SHADOW_FIELD_INCOMING_TEXT_FULL} ON TABLE supersede_shadow TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS ${SHADOW_FIELD_INCOMING_TAGS_JSON} ON TABLE supersede_shadow TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS ${SHADOW_FIELD_CANDIDATE_SNAPSHOT_JSON} ON TABLE supersede_shadow TYPE option<string>;`);
  // Rúnir-pn1l.13.7 D5 — per-step UUID for replay correlation (unique by construction).
  await db.query(`DEFINE FIELD IF NOT EXISTS ${SHADOW_FIELD_CORRELATION_ID} ON TABLE supersede_shadow TYPE option<string>;`);
  // Rúnir-h435.1 PIN-3/PIN-4 — additive write_event_id for cross-lane joins (NONE on legacy).
  await db.query(`DEFINE FIELD IF NOT EXISTS ${SHADOW_FIELD_WRITE_EVENT_ID} ON TABLE supersede_shadow TYPE option<string>;`);
  await db.query("DEFINE INDEX IF NOT EXISTS idx_supersede_shadow_diverged_occurred ON TABLE supersede_shadow COLUMNS diverged, occurred_at;");
}

export type LiveFlags = {
  cueGate: boolean;
  temporalGuard: boolean;
  keepBothGuard: boolean;
  addSkipGuard: boolean;
  judgeGate: boolean;
  /** Rúnir-pn1l.13.7 D1 — live value of RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM (6th flip flag). */
  f2JudgeConfirm?: boolean;
  /** Rúnir-h435.1 PIN-5 — applied-lane RUNIR_ATOMICFACT_IDENTITY_PROOF (series segmentation). */
  atomicIdentityProof?: boolean;
};

export type SupersedeShadowParams = {
  appliedMemoryId: string | null;
  userId: string;
  scope: string;
  sessionId?: string;
  source: string;
  appliedOutcome: string;
  baselineOutcome: string;
  wouldOutcome: string;
  diverged: boolean;
  /** Serialized as JSON string in the DB (TYPE string) to avoid SCHEMAFULL nested-field issues. */
  liveFlags: LiveFlags;
  wouldMatchedId: string | null;
  wouldCosine: number | null;
  wouldSignal: string | null;
  wouldReason: string;
  wouldBand: string | null;
  baselineMatchedId: string | null;
  baselineBand: string | null;
  incomingTextTrunc: string;
  // Rúnir-pn1l.13.4 (U5) supersede_shadow_v2 referent-identity columns (all option<string>).
  wouldNominationBlocked?: string | null;
  referentVerdict?: string | null;
  referentProof?: string | null;
  // Rúnir-pn1l.13.6 (Item A/B) additive columns (all option<string>). Do NOT truncate
  // incomingTextFull — the untruncated text is the entire point of Item B.
  incomingTextFull?: string;
  incomingTagsJson?: string | null;
  candidateSnapshotJson?: string | null;
  /**
   * Rúnir-pn1l.13.7 D5 — optional per-step UUID for seeded-replay correlation.
   * Unique by construction; prod callers never pass it (NONE on the row).
   */
  shadowCorrelationId?: string;
  /**
   * Rúnir-h435.1 PIN-4 — per-write-event correlation UUID (minted unconditionally at
   * arbitrateWrite entry). Additive option<string>; legacy-shaped writes omit → NONE.
   */
  writeEventId?: string;
};

export async function logSupersedeShadow(db: SurrealClient, params: SupersedeShadowParams): Promise<void> {
  // SurrealDB option<T> fields require NONE (not null) when absent. Build the SET clause
  // dynamically so absent optional values use the NONE literal rather than a bound param
  // (which would be coerced as NULL and rejected by the SCHEMAFULL type checker).
  // Build SET pairs: use literal NONE for absent optionals, bound param otherwise.
  const sets: string[] = [
    `user_id=$user_id`,
    `scope=$scope`,
    `source=$source`,
    `occurred_at=time::now()`,
    `applied_outcome=$applied_outcome`,
    `baseline_outcome=$baseline_outcome`,
    `would_outcome=$would_outcome`,
    `diverged=$diverged`,
    `live_flags=$live_flags`,
    `would_reason=$would_reason`,
    `incoming_text_trunc=$incoming_text_trunc`,
    `stable_label=NONE`,
    params.appliedMemoryId !== null ? `applied_memory_id=$applied_memory_id` : `applied_memory_id=NONE`,
    params.sessionId !== undefined ? `session_id=$session_id` : `session_id=NONE`,
    params.wouldMatchedId !== null ? `would_matched_id=$would_matched_id` : `would_matched_id=NONE`,
    params.wouldCosine !== null ? `would_cosine=$would_cosine` : `would_cosine=NONE`,
    params.wouldSignal !== null ? `would_signal=$would_signal` : `would_signal=NONE`,
    params.wouldBand !== null ? `would_band=$would_band` : `would_band=NONE`,
    params.baselineMatchedId !== null ? `baseline_matched_id=$baseline_matched_id` : `baseline_matched_id=NONE`,
    params.baselineBand !== null ? `baseline_band=$baseline_band` : `baseline_band=NONE`,
    // Rúnir-pn1l.13.4 (U5) v2 columns — NONE literal when absent (option<string>).
    params.wouldNominationBlocked != null
      ? `${SHADOW_FIELD_WOULD_NOMINATION_BLOCKED}=$would_nomination_blocked`
      : `${SHADOW_FIELD_WOULD_NOMINATION_BLOCKED}=NONE`,
    params.referentVerdict != null
      ? `${SHADOW_FIELD_REFERENT_VERDICT}=$referent_verdict`
      : `${SHADOW_FIELD_REFERENT_VERDICT}=NONE`,
    params.referentProof != null
      ? `${SHADOW_FIELD_REFERENT_PROOF}=$referent_proof`
      : `${SHADOW_FIELD_REFERENT_PROOF}=NONE`,
    // Rúnir-pn1l.13.6 (Item A/B) — NONE literal when absent (option<string>).
    params.incomingTextFull != null
      ? `${SHADOW_FIELD_INCOMING_TEXT_FULL}=$incoming_text_full`
      : `${SHADOW_FIELD_INCOMING_TEXT_FULL}=NONE`,
    params.incomingTagsJson != null
      ? `${SHADOW_FIELD_INCOMING_TAGS_JSON}=$incoming_tags_json`
      : `${SHADOW_FIELD_INCOMING_TAGS_JSON}=NONE`,
    params.candidateSnapshotJson != null
      ? `${SHADOW_FIELD_CANDIDATE_SNAPSHOT_JSON}=$candidate_snapshot_json`
      : `${SHADOW_FIELD_CANDIDATE_SNAPSHOT_JSON}=NONE`,
    // Rúnir-pn1l.13.7 D5 — per-step correlation UUID (NONE when prod omits it).
    params.shadowCorrelationId != null
      ? `${SHADOW_FIELD_CORRELATION_ID}=$shadow_correlation_id`
      : `${SHADOW_FIELD_CORRELATION_ID}=NONE`,
    // Rúnir-h435.1 PIN-4 — write_event_id (NONE when omitted / legacy-shaped write).
    params.writeEventId != null
      ? `${SHADOW_FIELD_WRITE_EVENT_ID}=$write_event_id`
      : `${SHADOW_FIELD_WRITE_EVENT_ID}=NONE`,
  ];

  const vars: Record<string, unknown> = {
    user_id: params.userId,
    scope: params.scope,
    source: params.source,
    applied_outcome: params.appliedOutcome,
    baseline_outcome: params.baselineOutcome,
    would_outcome: params.wouldOutcome,
    diverged: params.diverged,
    live_flags: JSON.stringify(params.liveFlags),
    would_reason: params.wouldReason,
    incoming_text_trunc: params.incomingTextTrunc.slice(0, 200),
  };
  if (params.appliedMemoryId !== null) vars.applied_memory_id = params.appliedMemoryId;
  if (params.sessionId !== undefined) vars.session_id = params.sessionId;
  if (params.wouldMatchedId !== null) vars.would_matched_id = params.wouldMatchedId;
  if (params.wouldCosine !== null) vars.would_cosine = params.wouldCosine;
  if (params.wouldSignal !== null) vars.would_signal = params.wouldSignal;
  if (params.wouldBand !== null) vars.would_band = params.wouldBand;
  if (params.baselineMatchedId !== null) vars.baseline_matched_id = params.baselineMatchedId;
  if (params.baselineBand !== null) vars.baseline_band = params.baselineBand;
  if (params.wouldNominationBlocked != null) vars.would_nomination_blocked = params.wouldNominationBlocked;
  if (params.referentVerdict != null) vars.referent_verdict = params.referentVerdict;
  if (params.referentProof != null) vars.referent_proof = params.referentProof;
  if (params.incomingTextFull != null) vars.incoming_text_full = params.incomingTextFull;
  if (params.incomingTagsJson != null) vars.incoming_tags_json = params.incomingTagsJson;
  if (params.candidateSnapshotJson != null) vars.candidate_snapshot_json = params.candidateSnapshotJson;
  if (params.shadowCorrelationId != null) vars.shadow_correlation_id = params.shadowCorrelationId;
  if (params.writeEventId != null) vars.write_event_id = params.writeEventId;

  await db.query(`CREATE supersede_shadow SET ${sets.join(", ")};`, vars)
    .catch(() => {}); // fire-and-forget, never block capture on shadow logging
}

