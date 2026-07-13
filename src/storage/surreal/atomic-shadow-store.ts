/**
 * Rúnir-h435.1 PIN-3: atomic-isolated frame tables + writers + finalizer.
 *
 * Lives outside `surreal-store.ts` so arbitration-level tests that partially mock
 * `surreal-store` (Unit A and peers) do not need to enumerate these exports —
 * write-arbitrator imports this module directly.
 */
import type { SurrealClient } from "./surreal-store.js";
import {
  ATOMIC_SHADOW_ATTEMPT_TABLE,
  ATOMIC_SHADOW_EVENT_TABLE,
  ATOMIC_SHADOW_NOMINATION_TABLE,
} from "./shadow-schema.js";

/** Ensures the three atomic_shadow_* tables (SCHEMAFULL, idempotent). */
export async function ensureAtomicShadowTables(db: SurrealClient): Promise<void> {
  // attempt
  await db.query(`DEFINE TABLE IF NOT EXISTS ${ATOMIC_SHADOW_ATTEMPT_TABLE} SCHEMAFULL;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS write_event_id ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS activation_class ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS pair_key ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS selection_hash ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS retired_candidate_id ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS nomination_manifest_keys ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS nomination_manifest_count ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE option<int>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE datetime;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS stratum ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS frame_id ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS replay_step_id ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS error_detail ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS finalized ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE bool;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS finalized_at ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} TYPE option<datetime>;`);
  await db.query(
    `DEFINE INDEX IF NOT EXISTS idx_atomic_shadow_attempt_write_event ON TABLE ${ATOMIC_SHADOW_ATTEMPT_TABLE} COLUMNS write_event_id;`,
  );

  // event packet
  await db.query(`DEFINE TABLE IF NOT EXISTS ${ATOMIC_SHADOW_EVENT_TABLE} SCHEMAFULL;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS write_event_id ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS isolated_outcome ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS isolated_matched_id ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS isolated_referent_proof ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS isolated_guard_keep_both_reason ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS isolated_unresolved ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS incoming_snapshot_json ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS candidate_snapshot_json ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS lane_clock_ms ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE number;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS applied_outcome ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS applied_matched_id ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} TYPE datetime;`);
  await db.query(
    `DEFINE INDEX IF NOT EXISTS idx_atomic_shadow_event_write_event ON TABLE ${ATOMIC_SHADOW_EVENT_TABLE} COLUMNS write_event_id;`,
  );

  // nomination records
  await db.query(`DEFINE TABLE IF NOT EXISTS ${ATOMIC_SHADOW_NOMINATION_TABLE} SCHEMAFULL;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS write_event_id ON TABLE ${ATOMIC_SHADOW_NOMINATION_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS nomination_candidate_id ON TABLE ${ATOMIC_SHADOW_NOMINATION_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS candidate_snapshot_json ON TABLE ${ATOMIC_SHADOW_NOMINATION_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS disposition ON TABLE ${ATOMIC_SHADOW_NOMINATION_TABLE} TYPE string;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS selected_candidate_id ON TABLE ${ATOMIC_SHADOW_NOMINATION_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS selected_signal ON TABLE ${ATOMIC_SHADOW_NOMINATION_TABLE} TYPE option<string>;`);
  await db.query(`DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE ${ATOMIC_SHADOW_NOMINATION_TABLE} TYPE datetime;`);
  // F3: UNIQUE pair index — duplicates are durably impossible at the store layer.
  await db.query(
    `DEFINE INDEX IF NOT EXISTS idx_atomic_shadow_nomination_pair ON TABLE ${ATOMIC_SHADOW_NOMINATION_TABLE} COLUMNS write_event_id, nomination_candidate_id UNIQUE;`,
  );
}

export type AtomicShadowAttemptParams = {
  writeEventId: string;
  activationClass: "safety_activation" | "efficacy_only" | "computation_failed";
  /** Present iff safety_activation. */
  pairKey?: string;
  selectionHash?: string;
  retiredCandidateId?: string;
  /** JSON array of nomination candidate ids; NONE only for computation_failed. */
  nominationManifestKeys?: string[];
  nominationManifestCount?: number;
  stratum: "replay" | "organic";
  frameId: string;
  replayStepId?: string;
  /** computation_failed only — Error message truncated to 500 chars, never stack. */
  errorDetail?: string;
};

/** AWAITED attempt-row create (PIN-1/PIN-9). Does NOT swallow — caller handles throw.
 *  F4: row writers issue ONLY their mutation — schema is bootstrapped once at readiness. */
export async function createAtomicShadowAttempt(
  db: SurrealClient,
  params: AtomicShadowAttemptParams,
): Promise<void> {
  const sets: string[] = [
    `write_event_id=$write_event_id`,
    `activation_class=$activation_class`,
    `occurred_at=time::now()`,
    `stratum=$stratum`,
    `frame_id=$frame_id`,
    `finalized=false`,
    params.pairKey != null ? `pair_key=$pair_key` : `pair_key=NONE`,
    params.selectionHash != null ? `selection_hash=$selection_hash` : `selection_hash=NONE`,
    params.retiredCandidateId != null
      ? `retired_candidate_id=$retired_candidate_id`
      : `retired_candidate_id=NONE`,
    params.nominationManifestKeys != null
      ? `nomination_manifest_keys=$nomination_manifest_keys`
      : `nomination_manifest_keys=NONE`,
    params.nominationManifestCount != null
      ? `nomination_manifest_count=$nomination_manifest_count`
      : `nomination_manifest_count=NONE`,
    params.replayStepId != null ? `replay_step_id=$replay_step_id` : `replay_step_id=NONE`,
    params.errorDetail != null ? `error_detail=$error_detail` : `error_detail=NONE`,
    `finalized_at=NONE`,
  ];
  const vars: Record<string, unknown> = {
    write_event_id: params.writeEventId,
    activation_class: params.activationClass,
    stratum: params.stratum,
    frame_id: params.frameId,
  };
  if (params.pairKey != null) vars.pair_key = params.pairKey;
  if (params.selectionHash != null) vars.selection_hash = params.selectionHash;
  if (params.retiredCandidateId != null) vars.retired_candidate_id = params.retiredCandidateId;
  if (params.nominationManifestKeys != null) {
    vars.nomination_manifest_keys = JSON.stringify(params.nominationManifestKeys);
  }
  if (params.nominationManifestCount != null) {
    vars.nomination_manifest_count = params.nominationManifestCount;
  }
  if (params.replayStepId != null) vars.replay_step_id = params.replayStepId;
  if (params.errorDetail != null) vars.error_detail = params.errorDetail.slice(0, 500);

  await db.query(
    `CREATE ${ATOMIC_SHADOW_ATTEMPT_TABLE} SET ${sets.join(", ")};`,
    vars,
  );
}

export type AtomicShadowEventParams = {
  writeEventId: string;
  isolatedOutcome: string;
  isolatedMatchedId?: string | null;
  isolatedReferentProof?: string | null;
  isolatedGuardKeepBothReason?: string | null;
  isolatedUnresolved?: string | null;
  incomingSnapshotJson: string;
  candidateSnapshotJson?: string | null;
  laneClockMs: number;
  appliedOutcome: string;
  appliedMatchedId?: string | null;
};

/** Event-packet writer. Failures leave the attempt unfinalized (do not throw into applied).
 *  F4: no schema side effects — tables ensured at service readiness. */
export async function createAtomicShadowEvent(
  db: SurrealClient,
  params: AtomicShadowEventParams,
): Promise<void> {
  const sets: string[] = [
    `write_event_id=$write_event_id`,
    `isolated_outcome=$isolated_outcome`,
    `incoming_snapshot_json=$incoming_snapshot_json`,
    `lane_clock_ms=$lane_clock_ms`,
    `applied_outcome=$applied_outcome`,
    `occurred_at=time::now()`,
    params.isolatedMatchedId != null
      ? `isolated_matched_id=$isolated_matched_id`
      : `isolated_matched_id=NONE`,
    params.isolatedReferentProof != null
      ? `isolated_referent_proof=$isolated_referent_proof`
      : `isolated_referent_proof=NONE`,
    params.isolatedGuardKeepBothReason != null
      ? `isolated_guard_keep_both_reason=$isolated_guard_keep_both_reason`
      : `isolated_guard_keep_both_reason=NONE`,
    params.isolatedUnresolved != null
      ? `isolated_unresolved=$isolated_unresolved`
      : `isolated_unresolved=NONE`,
    params.candidateSnapshotJson != null
      ? `candidate_snapshot_json=$candidate_snapshot_json`
      : `candidate_snapshot_json=NONE`,
    params.appliedMatchedId != null
      ? `applied_matched_id=$applied_matched_id`
      : `applied_matched_id=NONE`,
  ];
  const vars: Record<string, unknown> = {
    write_event_id: params.writeEventId,
    isolated_outcome: params.isolatedOutcome,
    incoming_snapshot_json: params.incomingSnapshotJson,
    lane_clock_ms: params.laneClockMs,
    applied_outcome: params.appliedOutcome,
  };
  if (params.isolatedMatchedId != null) vars.isolated_matched_id = params.isolatedMatchedId;
  if (params.isolatedReferentProof != null) {
    vars.isolated_referent_proof = params.isolatedReferentProof;
  }
  if (params.isolatedGuardKeepBothReason != null) {
    vars.isolated_guard_keep_both_reason = params.isolatedGuardKeepBothReason;
  }
  if (params.isolatedUnresolved != null) vars.isolated_unresolved = params.isolatedUnresolved;
  if (params.candidateSnapshotJson != null) {
    vars.candidate_snapshot_json = params.candidateSnapshotJson;
  }
  if (params.appliedMatchedId != null) vars.applied_matched_id = params.appliedMatchedId;

  await db.query(`CREATE ${ATOMIC_SHADOW_EVENT_TABLE} SET ${sets.join(", ")};`, vars);
}

export type AtomicShadowNominationParams = {
  writeEventId: string;
  nominationCandidateId: string;
  candidateSnapshotJson: string;
  disposition: string;
  selectedCandidateId?: string;
  selectedSignal?: string;
};

/** Single nomination-row writer. F4: no schema side effects. */
export async function createAtomicShadowNomination(
  db: SurrealClient,
  params: AtomicShadowNominationParams,
): Promise<void> {
  const sets: string[] = [
    `write_event_id=$write_event_id`,
    `nomination_candidate_id=$nomination_candidate_id`,
    `candidate_snapshot_json=$candidate_snapshot_json`,
    `disposition=$disposition`,
    `occurred_at=time::now()`,
    params.selectedCandidateId != null
      ? `selected_candidate_id=$selected_candidate_id`
      : `selected_candidate_id=NONE`,
    params.selectedSignal != null
      ? `selected_signal=$selected_signal`
      : `selected_signal=NONE`,
  ];
  const vars: Record<string, unknown> = {
    write_event_id: params.writeEventId,
    nomination_candidate_id: params.nominationCandidateId,
    candidate_snapshot_json: params.candidateSnapshotJson,
    disposition: params.disposition,
  };
  if (params.selectedCandidateId != null) {
    vars.selected_candidate_id = params.selectedCandidateId;
  }
  if (params.selectedSignal != null) vars.selected_signal = params.selectedSignal;

  await db.query(
    `CREATE ${ATOMIC_SHADOW_NOMINATION_TABLE} SET ${sets.join(", ")};`,
    vars,
  );
}

/**
 * PIN-3 finalizer — READ-BACK RULE (R3-2, R4-1): query persisted nomination rows and
 * compare the (write_event_id, nomination_candidate_id) set to the manifest for EXACT
 * equality. Never infer success from writer-promise resolution; never count-only.
 * Returns true iff finalized.
 */
export async function finalizeAtomicShadowAttemptIfComplete(
  db: SurrealClient,
  writeEventId: string,
  manifestCandidateIds: string[],
): Promise<boolean> {
  const results = await db.query(
    `SELECT nomination_candidate_id FROM ${ATOMIC_SHADOW_NOMINATION_TABLE} WHERE write_event_id = $wid;`,
    { wid: writeEventId },
  );
  const rows = ((results as unknown as unknown[][])?.[0] ?? []) as Array<{
    nomination_candidate_id?: string;
  }>;
  // F3 exact finalization: RAW persisted row count === manifest count FIRST (a
  // malformed/missing nomination_candidate_id must block finalization, not be
  // silently dropped by the string filter), then unique pair count === manifest
  // count, then exact membership equality. Duplicates [a,a,b] must NOT finalize
  // against [a,b]; rows [a,b,missing-id] must NOT finalize against [a,b].
  if (rows.length !== manifestCandidateIds.length) return false;
  const persistedIds = rows
    .map((r) => r.nomination_candidate_id)
    .filter((id): id is string => typeof id === "string");
  if (persistedIds.length !== manifestCandidateIds.length) return false;
  const uniquePairs = new Set(persistedIds);
  if (uniquePairs.size !== manifestCandidateIds.length) return false;
  const manifest = new Set(manifestCandidateIds);
  if (uniquePairs.size !== manifest.size) return false;
  for (const id of manifest) {
    if (!uniquePairs.has(id)) return false;
  }
  await db.query(
    `UPDATE ${ATOMIC_SHADOW_ATTEMPT_TABLE} SET finalized = true, finalized_at = time::now() WHERE write_event_id = $wid;`,
    { wid: writeEventId },
  );
  return true;
}
