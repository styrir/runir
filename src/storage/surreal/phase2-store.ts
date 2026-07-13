import { createHash, randomUUID } from "node:crypto";
import { RecordId } from "surrealdb";
import {
  isSemioteRelationKind,
  type MemoryRecordTable,
  type MemoryScope,
  type MemoryWriteSource,
  type SemioteProvenanceEnvelope,
  type SemioteProvenanceSourceKind,
  type SemioteRelationKind,
  type SemioteRelationRecord,
} from "../../domain/memory/types.js";
import type { HexisState } from "../../hexis/runtime-hexis.js";
import type { CanonicalContextIdentity } from "../../identity/canonical-context.js";
import { shouldPromoteToNoema } from "../../lifecycle/semion/usefulness-feedback.js";
import {
  deriveNoemaClaimContract,
  isValidNoemaStatusTransition,
  normalizeNoemaClaimStatus,
} from "../../noema/claim-contract.js";
import type { RetrievalAuditRecord } from "../../recall/policy/policy-types.js";
import { embeddingForStore, extractId, type SurrealClient } from "./surreal-store.js";

export type RetrievalFootprintIdentitySnapshot = {
  userId: string;
  contextScopeKind: "session" | "project" | "agent";
  sessionId?: string;
  projectKey?: string;
  agentId?: string;
  resolvedTaskId?: string;
  path?: string;
  derivation: CanonicalContextIdentity["derivation"];
};

export type RetrievalFootprint = {
  traceId: string;
  identity: RetrievalFootprintIdentitySnapshot;
  shownMemoryIds: string[];
  selectedMemoryIds: string[];
  createdAt: string;
  retrievalPath: string;
  intentLabel: string;
  sessionId?: string;
  requestedPath?: string;
};

/**
 * The closed vocabulary of THIN recall-quality labels a human can attach to a
 * retrieval trace. DELIBERATELY distinct from /hooks/feedback's usefulness
 * signal: these are a clean "was this recall helpful?" verdict, not a per-memory
 * reinforcement derived from lexical overlap with an answer.
 */
export const TRACE_RATINGS = ["helped", "hurt", "unused", "missing", "stale"] as const;
export type TraceRating = (typeof TRACE_RATINGS)[number];

export type RetrievalTraceRecord = {
  id: string;
  userId: string;
  prompt: string;
  intentLabel: string;
  laneLabel: string;
  retrievalPath: string;
  requestedPath?: string;
  sessionId?: string;
  hexisId?: string;
  hexisVersion?: number;
  hexisLabel?: string;
  footprintKind?: "turn";
  canonicalIdentity?: RetrievalFootprintIdentitySnapshot;
  accessTrackedIds: string[];
  retrievalAudit?: RetrievalAuditRecord;
  /** Entity-leg mentions that FAILED to contribute on this recall (no_entity_match /
   *  no_linked_memories / linked_memories_filtered). Persisted ALWAYS (not debug-gated)
   *  — this is the demand signal the nightly entity-repair job aggregates (Rúnir-b40x.2). */
  entityMisses?: Array<{ mention: string; normalized: string; reason: string }>;
  /** Verbatim text injected into the model on this turn (recall receipt). Set at create time. */
  prependContext?: string;
  /** Model answer for this turn. Set later, at /hooks/feedback time. */
  answer?: string;
  /** Feedback resolution label (e.g. explicit_success). Set at feedback time. */
  responseResolution?: string;
  /** Normalized semiote ids the human marked incorrect. Set at feedback time. */
  correctedIds?: string[];
  /** When feedback (answer + rating) arrived. Distinguishes answered vs unanswered traces. */
  feedbackReceivedAt?: string;
  /** THIN human recall-quality label (helped|hurt|unused|missing|stale). Separate from the usefulness loop. Set at /hooks/traces/:id/rate. */
  rating?: TraceRating;
  /** Optional free-text note accompanying the rating. */
  ratingNote?: string;
  /** When the human rated this recall. */
  ratedAt?: string;
  items: Array<{
    id: string;
    score: number;
    memoryRole?: string;
    path?: string;
    hexisFit?: number;
    rankingExplanation?: string[];
  }>;
  createdAt: string;
};

export type SemioteUsefulnessPatch = {
  usefulnessAlpha: number;
  usefulnessBeta: number;
  usefulnessScore: number;
  retrievedCount: number;
  usedCount: number;
  successfulUseCount: number;
  crossSessionUseCount: number;
  contradictionCount: number;
  lastRetrievedAt?: string;
  lastUsedAt?: string;
  lastEvaluatedAt?: string;
  hexisId?: string;
  hexisVersion?: number;
  hexisFit?: number;
  rankingExplanation?: string[];
  /**
   * Intent-conditioned status-noise counters (Rúnir-mmg2.2). Supplied ONLY when
   * the evaluated retrieval trace's intent is a status-class intent
   * (isStatusClassIntent) — the auto-accrual helper computes the next values and
   * passes them here. Absent on the QA/general usefulness path, in which case the
   * UPDATE leaves the existing status counters untouched (provable no-op).
   */
  statusRetrievedCount?: number;
  statusUsedCount?: number;
};

export type SemioteProvenanceBuildInput = {
  sourceKind: SemioteProvenanceSourceKind;
  writeSource: MemoryWriteSource;
  retrievalTraceId?: string;
  runirSessionId?: string;
  nativeSessionId?: string;
  sessionId?: string;
  path?: string;
  client?: string;
  sourceHostId?: string;
  sourceEventId?: string;
  sourceTurnIndex?: number;
  sourceCursorStart?: number;
  sourceCursorEnd?: number;
  extraction?: SemioteProvenanceEnvelope["extraction"];
  identity?: CanonicalContextIdentity;
};

type SemiosisSnapshot = {
  extractionConfidence: number;
  novelty: number;
  utility: number;
  stability: number;
  authority: number;
  contradictionRisk: number;
  promotionScore: number;
  decayScore: number;
  hexisId?: string;
  hexisVersion?: number;
  hexisFit?: number;
  rankingExplanation?: string[];
  version: string;
  lastEvaluatedAt?: string;
};

type PersistedSemiosisSnapshot = {
  extraction_confidence: number;
  novelty: number;
  utility: number;
  stability: number;
  authority: number;
  contradiction_risk: number;
  promotion_score: number;
  decay_score: number;
  hexis_id: string | null;
  hexis_version: number | null;
  hexis_fit: number | null;
  ranking_explanation: string[];
  version: string;
  last_evaluated_at: string | null;
};

function clamp01(value: number | undefined, fallback = 0.5): number {
  const safe = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(1, Math.max(0, safe));
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildSemiosisSnapshot(input: {
  confidence?: number;
  usefulnessScore?: number;
  usefulnessAlpha?: number;
  usefulnessBeta?: number;
  contradictionCount?: number;
  retrievedCount?: number;
  decayScore?: number;
  novelty?: number;
  authority?: number;
  hexisId?: string;
  hexisVersion?: number;
  hexisFit?: number;
  rankingExplanation?: string[];
  lastEvaluatedAt?: string;
}): SemiosisSnapshot {
  const usefulnessScore = clamp01(input.usefulnessScore, clamp01(input.confidence, 0.5));
  const contradictionCount = Math.max(0, Number(input.contradictionCount ?? 0));
  const retrievedCount = Math.max(0, Number(input.retrievedCount ?? 0));
  const contradictionRisk = clamp01(
    retrievedCount > 0 ? contradictionCount / Math.max(retrievedCount, 1) : contradictionCount > 0 ? 1 : 0,
    0,
  );
  const stabilityBase = input.usefulnessAlpha != null && input.usefulnessBeta != null
    ? Number(input.usefulnessAlpha) / Math.max(Number(input.usefulnessAlpha) + Number(input.usefulnessBeta), 1)
    : usefulnessScore;
  const extractionConfidence = clamp01(input.confidence, 0.5);
  const authority = clamp01(input.authority, extractionConfidence);
  const stability = clamp01(stabilityBase);
  const utility = usefulnessScore;
  const promotionScore = clamp01(
    utility * 0.45 + stability * 0.3 + authority * 0.2 + (1 - contradictionRisk) * 0.05,
    usefulnessScore,
  );

  return {
    extractionConfidence,
    novelty: clamp01(input.novelty, 0.5),
    utility,
    stability,
    authority,
    contradictionRisk,
    promotionScore,
    decayScore: clamp01(input.decayScore, 1 - usefulnessScore),
    hexisId: input.hexisId,
    hexisVersion: input.hexisVersion,
    hexisFit: input.hexisFit != null ? clamp01(input.hexisFit) : undefined,
    rankingExplanation: input.rankingExplanation?.slice(0, 6),
    version: "phase2-v1",
    lastEvaluatedAt: input.lastEvaluatedAt,
  };
}

function buildNoemaId(input: {
  userId: string;
  scope?: string;
  path?: string;
  memoryRole?: string;
  factKey?: string;
  claimKey?: string;
  canonicalText: string;
}): string {
  if (input.claimKey) {
    return createHash("sha256")
      .update(`noema-record-v1::${input.claimKey}`)
      .digest("hex")
      .slice(0, 24);
  }
  return createHash("sha256")
    .update(
      [
        input.userId,
        input.scope ?? "user",
        input.path ?? "*",
        input.memoryRole ?? "memory",
        input.claimKey ?? input.factKey ?? normalizeText(input.canonicalText),
      ].join("::"),
    )
    .digest("hex")
    .slice(0, 24);
}

async function getExistingNoemaStatus(
  db: SurrealClient,
  noemaId: string,
): Promise<ReturnType<typeof normalizeNoemaClaimStatus> | undefined> {
  const results = await db.query<any>(
    "SELECT status FROM type::record('noema', $id) LIMIT 1;",
    { id: noemaId },
  );
  const row = (results[0] ?? [])[0];
  return row?.status ? normalizeNoemaClaimStatus(row.status) : undefined;
}

function toPersistedSemiosis(
  semiosis: SemiosisSnapshot,
  fallbackLastEvaluatedAt?: string,
): PersistedSemiosisSnapshot {
  return {
    extraction_confidence: semiosis.extractionConfidence,
    novelty: semiosis.novelty,
    utility: semiosis.utility,
    stability: semiosis.stability,
    authority: semiosis.authority,
    contradiction_risk: semiosis.contradictionRisk,
    promotion_score: semiosis.promotionScore,
    decay_score: semiosis.decayScore,
    hexis_id: semiosis.hexisId ?? null,
    hexis_version: semiosis.hexisVersion ?? null,
    hexis_fit: semiosis.hexisFit ?? null,
    ranking_explanation: semiosis.rankingExplanation ?? [],
    version: semiosis.version,
    last_evaluated_at: semiosis.lastEvaluatedAt ?? fallbackLastEvaluatedAt ?? null,
  };
}

export async function ensurePhase2Schema(db: SurrealClient, embeddingDim = 768): Promise<void> {
  // Validate embeddingDim before interpolating into DDL — guard against bad env values.
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    throw new Error(`ensurePhase2Schema: invalid embeddingDim ${embeddingDim} (must be a positive integer)`);
  }
  // NOTE: `DEFINE INDEX IF NOT EXISTS` is idempotent — an existing HNSW index is NOT
  // rebuilt or altered if embeddingDim later changes. Switching a tenant's embedder to a
  // different dimension (e.g. nomic-768 → bge-m3-1024) requires manually dropping the old
  // index first:
  //   REMOVE INDEX idx_semiote_embedding ON TABLE semiote;
  //   REMOVE INDEX idx_noema_embedding ON TABLE noema;
  // After the next service restart the indexes will be recreated at the new dimension.
  // The semiote + noema FULLTEXT BM25 indexes below reference `mem_analyzer`; define it
  // here (idempotent) so this schema bootstrap is self-sufficient and does not silently
  // require an external ensureBm25Index() to have run first. Mirrors the analyzer DDL in
  // surreal-store.ts ensureBm25Index (Rúnir-0gk6.2: noema FTS index would otherwise fail
  // with "analyzer 'mem_analyzer' does not exist" on a fresh DB).
  await db.query(
    "DEFINE ANALYZER IF NOT EXISTS mem_analyzer TOKENIZERS blank,class FILTERS lowercase,snowball(english);",
  );
  await db.query("DEFINE TABLE IF NOT EXISTS semiote SCHEMALESS;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS payload ON TABLE semiote TYPE object;
    DEFINE FIELD IF NOT EXISTS embedding ON TABLE semiote TYPE option<array<float>>;
    DEFINE FIELD IF NOT EXISTS text_norm ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS created_at ON TABLE semiote TYPE datetime;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE semiote TYPE datetime;
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE semiote TYPE string;
    DEFINE FIELD IF NOT EXISTS scope ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS session_id ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS path ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS memory_role ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS valid_at ON TABLE semiote TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS invalid_at ON TABLE semiote TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS confidence ON TABLE semiote TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS active ON TABLE semiote TYPE option<bool>;
    DEFINE FIELD IF NOT EXISTS inactive_at ON TABLE semiote TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS inactive_reason ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS superseded_by ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS supersedes ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS lineage_root_id ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS supersede_provenance ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS archived ON TABLE semiote TYPE option<bool>;
    DEFINE FIELD IF NOT EXISTS usefulness_alpha ON TABLE semiote TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS usefulness_beta ON TABLE semiote TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS usefulness_score ON TABLE semiote TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS semiosis ON TABLE semiote TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS retrieved_count ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS used_count ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS successful_use_count ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS cross_session_use_count ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS contradiction_count ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS last_retrieved_at ON TABLE semiote TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS last_used_at ON TABLE semiote TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS last_evaluated_at ON TABLE semiote TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS status_retrieved_count ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS status_used_count ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS provenance ON TABLE semiote TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS runir_session_id ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS native_session_id ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_client ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_host_id ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_event_id ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_turn_index ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS source_cursor_start ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS source_cursor_end ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS folded_into_project_state_id ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS folded_at ON TABLE semiote TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS payload.provenance ON TABLE semiote TYPE option<object>;
    DEFINE INDEX IF NOT EXISTS semiote_text_bm25 ON TABLE semiote COLUMNS text_norm FULLTEXT ANALYZER mem_analyzer BM25;
    DEFINE INDEX IF NOT EXISTS idx_semiote_user_created ON TABLE semiote COLUMNS user_id, created_at;
    DEFINE INDEX IF NOT EXISTS idx_semiote_user_role ON TABLE semiote COLUMNS user_id, memory_role, updated_at;
    DEFINE INDEX IF NOT EXISTS idx_semiote_scope_session ON TABLE semiote COLUMNS scope, session_id;
    DEFINE INDEX IF NOT EXISTS idx_semiote_project_session ON TABLE semiote COLUMNS user_id, project_key, runir_session_id;
    DEFINE INDEX IF NOT EXISTS idx_semiote_user_runir_session ON TABLE semiote COLUMNS user_id, runir_session_id;
    DEFINE INDEX IF NOT EXISTS idx_semiote_folded_into_project_state ON TABLE semiote COLUMNS folded_into_project_state_id;
    DEFINE INDEX IF NOT EXISTS idx_semiote_user_status_counts ON TABLE semiote COLUMNS user_id, status_retrieved_count, status_used_count;
    DEFINE INDEX IF NOT EXISTS idx_semiote_embedding ON TABLE semiote FIELDS embedding HNSW DIMENSION ${embeddingDim} DIST COSINE TYPE F32 EFC 150 M 12;
  `);

  await db.query("DEFINE TABLE IF NOT EXISTS noema SCHEMALESS;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS canonical ON TABLE noema TYPE object;
    DEFINE FIELD IF NOT EXISTS canonical_text ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS canonical_norm ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS scope ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS path ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS memory_role ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS fact_key ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS claim_key ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS revision_hash ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS status ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS stable_claim ON TABLE noema TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS identity_version ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS fact_key_seed ON TABLE noema TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS embedding ON TABLE noema TYPE option<array<float>>;
    DEFINE FIELD IF NOT EXISTS confidence ON TABLE noema TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS stability ON TABLE noema TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS authority ON TABLE noema TYPE option<number>;
    DEFINE FIELD IF NOT EXISTS evidence_count ON TABLE noema TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS confirmation_count ON TABLE noema TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS contradiction_count ON TABLE noema TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS first_derived_at ON TABLE noema TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS last_reinforced_at ON TABLE noema TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE noema TYPE string;
    DEFINE FIELD IF NOT EXISTS active ON TABLE noema TYPE bool DEFAULT true;
    DEFINE FIELD IF NOT EXISTS created_at ON TABLE noema TYPE datetime;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE noema TYPE datetime;
    DEFINE FIELD IF NOT EXISTS support_semiote_ids ON TABLE noema TYPE option<array<string>>;
    DEFINE INDEX IF NOT EXISTS idx_noema_user_active ON TABLE noema COLUMNS user_id, active;
    DEFINE INDEX IF NOT EXISTS idx_noema_user_status ON TABLE noema COLUMNS user_id, status;
    DEFINE INDEX IF NOT EXISTS idx_noema_user_claim ON TABLE noema COLUMNS user_id, claim_key;
    DEFINE INDEX IF NOT EXISTS idx_noema_user_fact ON TABLE noema COLUMNS user_id, fact_key;
    DEFINE INDEX IF NOT EXISTS idx_noema_user_norm ON TABLE noema COLUMNS user_id, canonical_norm;
    DEFINE INDEX IF NOT EXISTS idx_noema_user_active_status_updated ON TABLE noema COLUMNS user_id, active, status, updated_at;
    DEFINE INDEX IF NOT EXISTS noema_text_bm25 ON TABLE noema COLUMNS canonical_norm FULLTEXT ANALYZER mem_analyzer BM25;
    DEFINE INDEX IF NOT EXISTS idx_noema_embedding ON TABLE noema FIELDS embedding HNSW DIMENSION ${embeddingDim} DIST COSINE TYPE F32 EFC 150 M 12;
  `);

  await db.query("DEFINE TABLE IF NOT EXISTS hexis SCHEMALESS;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE hexis TYPE string;
    DEFINE FIELD IF NOT EXISTS scope ON TABLE hexis TYPE string;
    DEFINE FIELD IF NOT EXISTS scope_key ON TABLE hexis TYPE string;
    DEFINE FIELD IF NOT EXISTS label ON TABLE hexis TYPE string;
    DEFINE FIELD IF NOT EXISTS goals ON TABLE hexis TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS roles ON TABLE hexis TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS hypotheses ON TABLE hexis TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS topic_bias ON TABLE hexis TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS memory_role_weights ON TABLE hexis TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS relevance_weights ON TABLE hexis TYPE object;
    DEFINE FIELD IF NOT EXISTS admissibility ON TABLE hexis TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS version ON TABLE hexis TYPE int;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE hexis TYPE datetime;
    DEFINE FIELD IF NOT EXISTS created_at ON TABLE hexis TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_hexis_user_scope_key ON TABLE hexis COLUMNS user_id, scope_key;
  `);

  await db.query("DEFINE TABLE IF NOT EXISTS retrieval_trace SCHEMALESS;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE retrieval_trace TYPE string;
    DEFINE FIELD IF NOT EXISTS session_id ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS prompt ON TABLE retrieval_trace TYPE string;
    DEFINE FIELD IF NOT EXISTS intent_label ON TABLE retrieval_trace TYPE string;
    DEFINE FIELD IF NOT EXISTS lane_label ON TABLE retrieval_trace TYPE string;
    DEFINE FIELD IF NOT EXISTS retrieval_path ON TABLE retrieval_trace TYPE string;
    DEFINE FIELD IF NOT EXISTS requested_path ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS hexis_id ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS hexis_version ON TABLE retrieval_trace TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS hexis_label ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS footprint_kind ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS canonical_identity ON TABLE retrieval_trace TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS access_tracked_ids ON TABLE retrieval_trace TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS retrieval_audit ON TABLE retrieval_trace TYPE option<object>;
    DEFINE FIELD IF NOT EXISTS entity_misses ON TABLE retrieval_trace TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS prepend_context ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS answer ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS response_resolution ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS corrected_ids ON TABLE retrieval_trace TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS feedback_received_at ON TABLE retrieval_trace TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS rating ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS rating_note ON TABLE retrieval_trace TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS rated_at ON TABLE retrieval_trace TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS items ON TABLE retrieval_trace TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS created_at ON TABLE retrieval_trace TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_retrieval_trace_user_created ON TABLE retrieval_trace COLUMNS user_id, created_at;
  `);

  await db.query("DEFINE TABLE IF NOT EXISTS semiote_relations TYPE RELATION FROM semiote TO semiote SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS kind ON TABLE semiote_relations TYPE string;
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE semiote_relations TYPE string;
    DEFINE FIELD IF NOT EXISTS scope ON TABLE semiote_relations TYPE string;
    DEFINE FIELD IF NOT EXISTS session_id ON TABLE semiote_relations TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS path ON TABLE semiote_relations TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS retrieval_trace_id ON TABLE semiote_relations TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_write ON TABLE semiote_relations TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS provenance ON TABLE semiote_relations TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS created_at ON TABLE semiote_relations TYPE datetime;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE semiote_relations TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_semiote_rel_kind ON TABLE semiote_relations COLUMNS kind;
    DEFINE INDEX IF NOT EXISTS idx_semiote_rel_user_scope ON TABLE semiote_relations COLUMNS user_id, scope;
    DEFINE INDEX IF NOT EXISTS idx_semiote_rel_user_session ON TABLE semiote_relations COLUMNS user_id, session_id;
    DEFINE INDEX IF NOT EXISTS idx_semiote_rel_user_path ON TABLE semiote_relations COLUMNS user_id, path;
    DEFINE INDEX IF NOT EXISTS idx_semiote_rel_unique ON TABLE semiote_relations COLUMNS in, out, kind UNIQUE;
  `);
}

export async function createRetrievalTrace(
  db: SurrealClient,
  trace: Omit<RetrievalTraceRecord, "id" | "createdAt">,
): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.query(
    `UPSERT type::record('retrieval_trace', $id) CONTENT {
       user_id: $userId,
       session_id: $sessionId,
       prompt: $prompt,
       intent_label: $intentLabel,
       lane_label: $laneLabel,
       retrieval_path: $retrievalPath,
       requested_path: $requestedPath,
       hexis_id: $hexisId,
       hexis_version: $hexisVersion,
       hexis_label: $hexisLabel,
       footprint_kind: $footprintKind,
       canonical_identity: $canonicalIdentity,
       access_tracked_ids: $accessTrackedIds,
       retrieval_audit: $retrievalAudit,
       entity_misses: $entityMisses,
       prepend_context: $prependContext,
       items: $items,
       created_at: <datetime>$createdAt
     };`,
    {
      id,
      userId: trace.userId,
      sessionId: trace.sessionId ?? undefined,
      prompt: trace.prompt,
      intentLabel: trace.intentLabel,
      laneLabel: trace.laneLabel,
      retrievalPath: trace.retrievalPath,
      requestedPath: trace.requestedPath ?? undefined,
      hexisId: trace.hexisId ?? undefined,
      hexisVersion: trace.hexisVersion ?? undefined,
      hexisLabel: trace.hexisLabel ?? undefined,
      footprintKind: trace.footprintKind ?? "turn",
      canonicalIdentity: trace.canonicalIdentity ?? undefined,
      accessTrackedIds: trace.accessTrackedIds,
      retrievalAudit: trace.retrievalAudit ?? undefined,
      entityMisses: trace.entityMisses?.length ? trace.entityMisses : undefined,
      prependContext: trace.prependContext ?? undefined,
      items: trace.items,
      createdAt,
    },
  );
  return id;
}

/**
 * Shared projection from a retrieval_trace row to RetrievalTraceRecord.
 * Used by both the per-id read (getRetrievalTrace) and the list read
 * (listRetrievalTraces). The id is derived from row.id (not a closed-over
 * param) so the same mapper works for multi-row list results. Feedback fields
 * coalesce to undefined so pre-augmentation rows read back cleanly.
 */
function mapRetrievalTraceRow(row: any): RetrievalTraceRecord {
  return {
    id: extractId(row.id),
    userId: row.user_id,
    sessionId: row.session_id ?? undefined,
    prompt: row.prompt,
    intentLabel: row.intent_label,
    laneLabel: row.lane_label ?? row.intent_label,
    retrievalPath: row.retrieval_path,
    requestedPath: row.requested_path ?? undefined,
    hexisId: row.hexis_id ?? undefined,
    hexisVersion: row.hexis_version ?? undefined,
    hexisLabel: row.hexis_label ?? undefined,
    footprintKind: row.footprint_kind ?? "turn",
    canonicalIdentity: row.canonical_identity ?? undefined,
    accessTrackedIds: row.access_tracked_ids ?? [],
    retrievalAudit: row.retrieval_audit ?? undefined,
    prependContext: row.prepend_context ?? undefined,
    answer: row.answer ?? undefined,
    responseResolution: row.response_resolution ?? undefined,
    correctedIds: row.corrected_ids ?? undefined,
    feedbackReceivedAt: row.feedback_received_at ?? undefined,
    rating: row.rating ?? undefined,
    ratingNote: row.rating_note ?? undefined,
    ratedAt: row.rated_at ?? undefined,
    items: row.items ?? [],
    createdAt: row.created_at,
  };
}

export async function getRetrievalTrace(
  db: SurrealClient,
  id: string,
  userId: string,
): Promise<RetrievalTraceRecord | null> {
  const results = await db.query<any>(
    `SELECT id, user_id, session_id, prompt, intent_label, lane_label, retrieval_path, requested_path, hexis_id, hexis_version, hexis_label, footprint_kind, canonical_identity, access_tracked_ids, retrieval_audit, prepend_context, answer, response_resolution, corrected_ids, feedback_received_at, rating, rating_note, rated_at, items, created_at
     FROM type::record('retrieval_trace', $id)
     WHERE user_id = $userId;`,
    { id, userId },
  );
  const row = (results[0] ?? [])[0];
  if (!row) return null;
  return mapRetrievalTraceRow(row);
}

/**
 * Persists the model answer (+ feedback metadata) onto an existing trace at
 * /hooks/feedback time. Idempotent / last-write-wins per (id, userId): the
 * feedback handler is the sole writer of these fields. user-scoped WHERE
 * guards against writing another user's trace.
 */
export async function patchRetrievalTraceAnswer(
  db: SurrealClient,
  id: string,
  userId: string,
  patch: { answer: string; responseResolution?: string; correctedIds?: string[] },
): Promise<void> {
  await db.query(
    `UPDATE type::record('retrieval_trace', $id) SET
       answer = $answer,
       response_resolution = $responseResolution,
       corrected_ids = $correctedIds,
       feedback_received_at = time::now()
     WHERE user_id = $userId;`,
    {
      id,
      userId,
      answer: patch.answer,
      responseResolution: patch.responseResolution ?? undefined,
      correctedIds: patch.correctedIds ?? undefined,
    },
  );
}

/**
 * Records a THIN human recall-quality label (helped|hurt|unused|missing|stale
 * + optional note) onto an existing trace, at /hooks/traces/:id/rate time.
 *
 * DELIBERATELY SEPARATE from patchRetrievalTraceAnswer / the usefulness loop:
 * unlike /hooks/feedback (which requires an answer and reinforces per-memory
 * usefulness via lexical overlap), this only annotates the trace with the
 * human's verdict on the recall and NEVER mutates semiote usefulness. Idempotent
 * / last-write-wins per (id, userId); the user-scoped WHERE guards against
 * rating another user's trace.
 */
export async function patchRetrievalTraceRating(
  db: SurrealClient,
  id: string,
  userId: string,
  patch: { rating: TraceRating; note?: string },
): Promise<void> {
  await db.query(
    `UPDATE type::record('retrieval_trace', $id) SET
       rating = $rating,
       rating_note = $note,
       rated_at = time::now()
     WHERE user_id = $userId;`,
    {
      id,
      userId,
      rating: patch.rating,
      note: patch.note ?? undefined,
    },
  );
}

/**
 * Lists the latest N retrieval traces for a user (newest first), backed by the
 * idx_retrieval_trace_user_created (user_id, created_at) index. Deliberately
 * omits the heavy verbatim columns (prepend_context, answer) from the SELECT so
 * list payloads stay light; those are fetched only via getRetrievalTrace.
 */
export async function listRetrievalTraces(
  db: SurrealClient,
  userId: string,
  limit: number,
): Promise<RetrievalTraceRecord[]> {
  const results = await db.query<any>(
    `SELECT id, user_id, session_id, prompt, intent_label, lane_label, retrieval_path, requested_path, hexis_id, hexis_version, hexis_label, footprint_kind, canonical_identity, access_tracked_ids, retrieval_audit, response_resolution, corrected_ids, feedback_received_at, rating, rated_at, items, created_at
     FROM retrieval_trace
     WHERE user_id = $userId
     ORDER BY created_at DESC
     LIMIT $limit;`,
    { userId, limit },
  );
  const rows = results[0] ?? [];
  return rows.map(mapRetrievalTraceRow);
}

/**
 * retrieval_trace retention (Rúnir-x41m.9). Every recall turn writes a
 * verbatim trace row forever — verbatim stays deliberately UNCAPPED (that is
 * what keeps "verbatim" honest), so the growth lever is retention, not a
 * field cap. RUNIR_TRACE_RETENTION_DAYS (default 90). Rows carrying feedback
 * (a rating or an answer) are labeled evaluation data and are NEVER swept.
 */
export function resolveTraceRetentionDays(): number {
  const raw = process.env.RUNIR_TRACE_RETENTION_DAYS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 90;
}

export async function deleteExpiredRetrievalTraces(
  db: SurrealClient,
  retentionDays: number,
): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const countResults = await db.query<{ n: number }>(
    `SELECT count() AS n FROM retrieval_trace
     WHERE created_at < <datetime>$cutoff AND rating = NONE AND answer = NONE
     GROUP ALL;`,
    { cutoff },
  );
  const expired = countResults[0]?.[0]?.n ?? 0;
  if (expired === 0) return 0;
  await db.query(
    `DELETE retrieval_trace
     WHERE created_at < <datetime>$cutoff AND rating = NONE AND answer = NONE;`,
    { cutoff },
  );
  return expired;
}

/**
 * Queries the semiote ids that have accrued enough status-intent retrieval
 * evidence to count as LEARNED status-noise for a tenant (Rúnir-mmg2.2):
 *
 *   user_id = $uid AND status_retrieved_count >= $threshold AND status_used_count == 0
 *
 * "Shown >= threshold times under a status/opener recall, never lexically used in
 * any of those answers." Backed by idx_semiote_user_status_counts (user_id,
 * status_retrieved_count, status_used_count). Returns the bare (table-stripped)
 * ids. A FRESH tenant — every row's counters NULL until status-intent feedback
 * accrues — returns an EMPTY array (the `>=` predicate never matches NULL), which
 * is what makes the demotion-site union a provable no-op at landing (R4).
 *
 * Only ACTIVE rows are eligible (inactive/superseded rows are dropped upstream by
 * the recall query before demotion ever runs, so demoting them is moot; we mirror
 * that here to keep the learned set tight).
 */
export async function queryLearnedStatusNoiseIds(
  db: SurrealClient,
  userId: string,
  threshold: number,
): Promise<string[]> {
  const results = await db.query<any>(
    `SELECT id FROM semiote
     WHERE user_id = $userId
       AND status_retrieved_count != NONE
       AND status_retrieved_count >= $threshold
       AND status_used_count = 0
       AND (active = NONE OR active = true);`,
    { userId, threshold },
  );
  const rows = results[0] ?? [];
  return rows.map((row: any) => extractId(row.id)).filter(Boolean);
}

export function toRetrievalFootprintIdentitySnapshot(
  identity: CanonicalContextIdentity,
): RetrievalFootprintIdentitySnapshot {
  return {
    userId: identity.userId,
    contextScopeKind: identity.contextScopeKind,
    sessionId: identity.raw.sessionId,
    projectKey: identity.projectKey,
    agentId: identity.agentId,
    resolvedTaskId: identity.resolvedTaskId,
    path: identity.raw.path,
    derivation: identity.derivation,
  };
}

export function retrievalFootprintIdentityMatches(
  identity: CanonicalContextIdentity,
  footprint: RetrievalFootprint,
): boolean {
  return (
    identity.userId === footprint.identity.userId
    && identity.contextScopeKind === footprint.identity.contextScopeKind
    && (identity.raw.sessionId ?? undefined) === (footprint.identity.sessionId ?? undefined)
    && (identity.projectKey ?? undefined) === (footprint.identity.projectKey ?? undefined)
    && (identity.agentId ?? undefined) === (footprint.identity.agentId ?? undefined)
    && (identity.resolvedTaskId ?? undefined) === (footprint.identity.resolvedTaskId ?? undefined)
    && (identity.raw.path ?? undefined) === (footprint.identity.path ?? undefined)
  );
}

export async function getRetrievalFootprintFromTrace(
  db: SurrealClient,
  traceId: string,
  userId: string,
): Promise<RetrievalFootprint | null> {
  const trace = await getRetrievalTrace(db, traceId, userId);
  if (!trace || !trace.canonicalIdentity) return null;
  return {
    traceId: trace.id,
    identity: trace.canonicalIdentity,
    shownMemoryIds: trace.accessTrackedIds,
    selectedMemoryIds: trace.items.map((item) => item.id),
    createdAt: trace.createdAt,
    retrievalPath: trace.retrievalPath,
    intentLabel: trace.intentLabel,
    sessionId: trace.sessionId,
    requestedPath: trace.requestedPath,
  };
}

export async function getPrimaryMemoryRowsByIds(
  db: SurrealClient,
  ids: string[],
  tableName: MemoryRecordTable = "semiote",
): Promise<any[]> {
  if (ids.length === 0) return [];
  const refs = ids.map((id) => `type::record('${tableName}', '${id.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')`);
  const results = await db.query<any>(
    `SELECT * FROM ${tableName} WHERE id IN [${refs.join(", ")}];`,
  );
  return results[0] ?? [];
}

export function buildSemioteProvenanceEnvelope(
  input: SemioteProvenanceBuildInput,
): SemioteProvenanceEnvelope {
  return {
    sourceKind: input.sourceKind,
    writeSource: input.writeSource,
    retrievalTraceId: input.retrievalTraceId,
    runirSessionId: input.runirSessionId,
    nativeSessionId: input.nativeSessionId,
    sessionId: input.sessionId ?? input.identity?.raw.sessionId,
    path: input.path ?? input.identity?.raw.path,
    client: input.client,
    sourceHostId: input.sourceHostId,
    sourceEventId: input.sourceEventId,
    sourceTurnIndex: input.sourceTurnIndex,
    sourceCursorStart: input.sourceCursorStart,
    sourceCursorEnd: input.sourceCursorEnd,
    extraction: input.extraction,
    derivation: input.identity
      ? {
          contextScopeKind: input.identity.contextScopeKind,
          projectKey: input.identity.projectKey,
          agentId: input.identity.agentId,
          resolvedTaskId: input.identity.resolvedTaskId,
        }
      : undefined,
  };
}

export async function patchSemioteProvenance(
  db: SurrealClient,
  id: string,
  provenance: SemioteProvenanceEnvelope,
): Promise<void> {
  await db.query(
    `UPDATE type::record('semiote', $id) SET
      provenance = $provenance,
      payload.provenance = $provenance,
      project_key = $projectKey,
      runir_session_id = $runirSessionId,
      native_session_id = $nativeSessionId,
      source_client = $sourceClient,
      source_host_id = $sourceHostId,
      source_event_id = $sourceEventId,
      source_turn_index = $sourceTurnIndex,
      source_cursor_start = $sourceCursorStart,
      source_cursor_end = $sourceCursorEnd,
      updated_at = time::now();`,
    {
      id,
      provenance,
      projectKey: provenance.derivation?.projectKey,
      runirSessionId: provenance.runirSessionId ?? undefined,
      nativeSessionId: provenance.nativeSessionId ?? undefined,
      sourceClient: provenance.client ?? undefined,
      sourceHostId: provenance.sourceHostId ?? undefined,
      sourceEventId: provenance.sourceEventId ?? undefined,
      sourceTurnIndex: provenance.sourceTurnIndex ?? undefined,
      sourceCursorStart: provenance.sourceCursorStart ?? undefined,
      sourceCursorEnd: provenance.sourceCursorEnd ?? undefined,
    },
  );
}

export async function markSemiotesFoldedIntoProjectState(
  db: SurrealClient,
  ids: string[],
  projectStateId: string,
  foldedAt = new Date().toISOString(),
): Promise<void> {
  if (ids.length === 0) return;
  const refs = ids.map((id) => `type::record('semiote', '${id.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')`);
  await db.query(
    `UPDATE semiote SET
      folded_into_project_state_id = $projectStateId,
      folded_at = <datetime>$foldedAt,
      payload.foldedIntoProjectStateId = $projectStateId,
      payload.foldedAt = $foldedAt,
      updated_at = time::now()
     WHERE id IN [${refs.join(", ")}];`,
    {
      ids,
      projectStateId,
      foldedAt,
    },
  );
}

export function validateSemioteRelationKind(kind: unknown): SemioteRelationKind {
  if (!isSemioteRelationKind(kind)) {
    throw new Error(`Unsupported semiote relation kind: ${String(kind)}`);
  }
  return kind;
}

export async function upsertSemioteRelation(
  db: SurrealClient,
  relation: Omit<SemioteRelationRecord, "createdAt" | "updatedAt">,
): Promise<string> {
  const kind = validateSemioteRelationKind(relation.kind);
  if (relation.in === relation.out) {
    throw new Error("Semiote relations cannot link a record to itself");
  }

  const relatedRows = await getPrimaryMemoryRowsByIds(db, [relation.in, relation.out], "semiote");
  if (relatedRows.length !== 2) {
    throw new Error("Semiote relation endpoints must exist before linking");
  }
  for (const row of relatedRows) {
    const payload = row?.payload ?? {};
    const rowUserId = typeof row?.user_id === "string" ? row.user_id : payload.userId;
    if (rowUserId !== relation.userId) {
      throw new Error("Semiote relations cannot cross user boundaries");
    }
    if (relation.scope === "session") {
      const rowSessionId = typeof row?.session_id === "string" ? row.session_id : payload.sessionId;
      if ((rowSessionId ?? undefined) !== (relation.sessionId ?? undefined)) {
        throw new Error("Semiote session-scoped relations require matching session ids");
      }
    } else {
      const rowSessionId = typeof row?.session_id === "string" ? row.session_id : payload.sessionId;
      if (rowSessionId) {
        throw new Error("Semiote relations with session-scoped endpoints must use session scope");
      }
    }
    if (relation.path) {
      const rowPath = typeof row?.path === "string" ? row.path : payload.path;
      if (rowPath && rowPath !== relation.path) {
        throw new Error("Semiote relations cannot cross path scope when path grounding is present");
      }
    }
  }

  const now = new Date().toISOString();
  try {
    await db.query(
      `RELATE $fromRecord -> semiote_relations -> $toRecord SET
        kind = $kind,
        user_id = $userId,
        scope = $scope,
        session_id = $sessionId,
        path = $path,
        retrieval_trace_id = $retrievalTraceId,
        source_write = $sourceWrite,
        provenance = $provenance,
        created_at = <datetime>$now,
        updated_at = <datetime>$now;`,
      {
        fromRecord: new RecordId("semiote", relation.in),
        toRecord: new RecordId("semiote", relation.out),
        kind,
        userId: relation.userId,
        scope: relation.scope,
        sessionId: relation.sessionId ?? undefined,
        path: relation.path ?? undefined,
        retrievalTraceId: relation.retrievalTraceId ?? undefined,
        sourceWrite: relation.sourceWrite ?? undefined,
        provenance: relation.provenance ?? undefined,
        now,
      },
    );
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("already exists")) {
      await db.query(
        `UPDATE semiote_relations SET
          user_id = $userId,
          scope = $scope,
          session_id = $sessionId,
          path = $path,
          retrieval_trace_id = $retrievalTraceId,
          source_write = $sourceWrite,
          provenance = $provenance,
          updated_at = <datetime>$now
         WHERE in = type::record('semiote', $fromId)
           AND out = type::record('semiote', $toId)
           AND kind = $kind;`,
        {
          fromId: relation.in,
          toId: relation.out,
          kind,
          userId: relation.userId,
          scope: relation.scope,
          sessionId: relation.sessionId ?? undefined,
          path: relation.path ?? undefined,
          retrievalTraceId: relation.retrievalTraceId ?? undefined,
          sourceWrite: relation.sourceWrite ?? undefined,
          provenance: relation.provenance ?? undefined,
          now,
        },
      );
    } else {
      throw err;
    }
  }
  return `${relation.in}->${kind}->${relation.out}`;
}

export async function listSemioteRelationsForIds(
  db: SurrealClient,
  userId: string,
  ids: string[],
): Promise<SemioteRelationRecord[]> {
  if (ids.length === 0) return [];
  const refs = ids.map((id) => `type::record('semiote', '${id.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')`);
  const results = await db.query<any>(
    `SELECT id, in, out, kind, user_id, scope, session_id, path, retrieval_trace_id, source_write, provenance, created_at, updated_at
     FROM semiote_relations
     WHERE user_id = $userId
       AND (in IN [${refs.join(", ")}] OR out IN [${refs.join(", ")}]);`,
    { userId },
  );
  return (results[0] ?? []).map((row: any) => ({
    id: extractId(row.id),
    in: extractId(row.in),
    out: extractId(row.out),
    kind: validateSemioteRelationKind(row.kind),
    userId: row.user_id,
    scope: row.scope as MemoryScope,
    sessionId: row.session_id ?? undefined,
    path: row.path ?? undefined,
    retrievalTraceId: row.retrieval_trace_id ?? undefined,
    sourceWrite: row.source_write as MemoryWriteSource | undefined,
    provenance: row.provenance ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function patchSemioteUsefulness(
  db: SurrealClient,
  id: string,
  patch: SemioteUsefulnessPatch,
): Promise<void> {
  const semiosis = buildSemiosisSnapshot({
    usefulnessAlpha: patch.usefulnessAlpha,
    usefulnessBeta: patch.usefulnessBeta,
    usefulnessScore: patch.usefulnessScore,
    contradictionCount: patch.contradictionCount,
    retrievedCount: patch.retrievedCount,
    hexisId: patch.hexisId,
    hexisVersion: patch.hexisVersion,
    hexisFit: patch.hexisFit,
    rankingExplanation: patch.rankingExplanation,
    lastEvaluatedAt: patch.lastEvaluatedAt,
  });
  await db.query(
    `UPDATE type::record('semiote', $id) SET
       usefulness_alpha = $usefulnessAlpha,
       usefulness_beta = $usefulnessBeta,
       usefulness_score = $usefulnessScore,
       retrieved_count = $retrievedCount,
       used_count = $usedCount,
       successful_use_count = $successfulUseCount,
       cross_session_use_count = $crossSessionUseCount,
       contradiction_count = $contradictionCount,
       last_retrieved_at = IF $lastRetrievedAt != NONE THEN <datetime>$lastRetrievedAt ELSE last_retrieved_at END,
       last_used_at = IF $lastUsedAt != NONE THEN <datetime>$lastUsedAt ELSE last_used_at END,
       last_evaluated_at = IF $lastEvaluatedAt != NONE THEN <datetime>$lastEvaluatedAt ELSE last_evaluated_at END,
       status_retrieved_count = IF $statusRetrievedCount != NONE THEN $statusRetrievedCount ELSE status_retrieved_count END,
       status_used_count = IF $statusUsedCount != NONE THEN $statusUsedCount ELSE status_used_count END,
       semiosis = $semiosis,
       payload.usefulnessAlpha = $usefulnessAlpha,
       payload.usefulnessBeta = $usefulnessBeta,
       payload.usefulnessScore = $usefulnessScore,
       payload.retrievedCount = $retrievedCount,
       payload.usedCount = $usedCount,
       payload.successfulUseCount = $successfulUseCount,
       payload.crossSessionUseCount = $crossSessionUseCount,
       payload.contradictionCount = $contradictionCount,
       payload.lastRetrievedAt = $lastRetrievedAt,
       payload.lastUsedAt = $lastUsedAt,
       payload.lastEvaluatedAt = $lastEvaluatedAt,
       payload.semiosis = $semiosis,
       updated_at = time::now();`,
    {
      id,
      ...patch,
      semiosis: toPersistedSemiosis(semiosis, patch.lastEvaluatedAt),
    },
  );
}

export async function initializeSemioteSemiosis(
  db: SurrealClient,
  id: string,
  input: {
    confidence?: number;
    usefulnessAlpha?: number;
    usefulnessBeta?: number;
    usefulnessScore?: number;
    contradictionCount?: number;
    retrievedCount?: number;
    novelty?: number;
    authority?: number;
    hexisId?: string;
    hexisVersion?: number;
    hexisFit?: number;
    rankingExplanation?: string[];
    lastEvaluatedAt?: string;
  },
): Promise<void> {
  const semiosis = buildSemiosisSnapshot(input);
  await db.query(
    `UPDATE type::record('semiote', $id) SET
      semiosis = $semiosis,
      payload.semiosis = $semiosis,
      updated_at = time::now();`,
    {
      id,
      semiosis: toPersistedSemiosis(semiosis),
    },
  );
}

export async function upsertHexis(
  db: SurrealClient,
  userId: string,
  hexis: HexisState,
): Promise<string> {
  await db.query(
    `UPSERT type::record('hexis', $id) SET
       user_id = $userId,
       scope = $scope,
       scope_key = $scopeKey,
       label = $label,
       goals = $goals,
       roles = $roles,
       hypotheses = $hypotheses,
       topic_bias = $topicBias,
       memory_role_weights = $memoryRoleWeights,
       relevance_weights = $relevanceWeights,
       admissibility = $admissibility,
       version = <int>$version,
       created_at = IF created_at != NONE THEN created_at ELSE <datetime>$updatedAt END,
       updated_at = <datetime>$updatedAt;`,
    {
      id: hexis.id,
      userId,
      scope: hexis.scope,
      scopeKey: hexis.scopeKey,
      label: hexis.label,
      goals: hexis.goals,
      roles: hexis.roles,
      hypotheses: hexis.hypotheses ?? [],
      topicBias: hexis.topicBias ?? {},
      memoryRoleWeights: hexis.memoryRoleWeights ?? {},
      relevanceWeights: hexis.relevanceWeights,
      admissibility: hexis.admissibility ?? undefined,
      version: hexis.version,
      updatedAt: hexis.updatedAt,
    },
  );
  return hexis.id;
}

function mapHexisRow(row: any): HexisState {
  return {
    id: extractId(row.id),
    scope: row.scope,
    scopeKey: row.scope_key,
    label: row.label,
    goals: row.goals ?? [],
    roles: row.roles ?? [],
    hypotheses: row.hypotheses ?? [],
    topicBias: row.topic_bias ?? {},
    memoryRoleWeights: row.memory_role_weights ?? {},
    relevanceWeights: row.relevance_weights,
    admissibility: row.admissibility ?? undefined,
    version: Number(row.version ?? 1),
    updatedAt: row.updated_at,
  };
}

export async function getHexisById(
  db: SurrealClient,
  userId: string,
  id: string,
): Promise<HexisState | null> {
  const results = await db.query<any>(
    `SELECT * FROM type::record('hexis', $id) WHERE user_id = $userId;`,
    { id, userId },
  );
  const row = (results[0] ?? [])[0];
  return row ? mapHexisRow(row) : null;
}

export async function getHexisByScopeKey(
  db: SurrealClient,
  userId: string,
  scopeKey: string,
): Promise<HexisState | null> {
  const results = await db.query<any>(
    `SELECT * FROM hexis WHERE user_id = $userId AND scope_key = $scopeKey ORDER BY updated_at DESC LIMIT 1;`,
    { userId, scopeKey },
  );
  const row = (results[0] ?? [])[0];
  return row ? mapHexisRow(row) : null;
}

export async function promoteSemioteToNoema(
  db: SurrealClient,
  row: any,
  embedText?: (text: string) => Promise<number[]>,
): Promise<{ promoted: boolean; id: string | null; embeddingWritten: boolean }> {
  const payload = row?.payload ?? {};
  const canonicalText = String(payload.l2 ?? payload.data ?? "").trim();
  const userId = String(row?.user_id ?? payload.userId ?? "").trim();
  if (!canonicalText || !userId) {
    return { promoted: false, id: null, embeddingWritten: false };
  }

  const usefulness = {
    usefulnessScore: Number(row?.usefulness_score ?? payload.usefulnessScore ?? payload.confidence ?? 0.5),
    successfulUseCount: Number(row?.successful_use_count ?? payload.successfulUseCount ?? 0),
    crossSessionUseCount: Number(row?.cross_session_use_count ?? payload.crossSessionUseCount ?? 0),
    contradictionCount: Number(row?.contradiction_count ?? payload.contradictionCount ?? 0),
  };
  if (!shouldPromoteToNoema(usefulness)) {
    return { promoted: false, id: null, embeddingWritten: false };
  }

  const scope = typeof row?.scope === "string" ? row.scope : payload.scope;
  const path = typeof row?.path === "string" ? row.path : payload.path;
  const memoryRole = typeof row?.memory_role === "string" ? row.memory_role : payload.memoryRole;
  const factKey = typeof payload.factKey === "string" ? payload.factKey : undefined;
  const claimContract = deriveNoemaClaimContract({
    userId,
    scope,
    path,
    memoryRole,
    factKey,
    canonicalText,
    category: typeof payload.category === "string" ? payload.category : undefined,
    continuitySubjectKey: typeof payload.continuitySubjectKey === "string" ? payload.continuitySubjectKey : undefined,
    claimSubject: typeof payload.claimSubject === "string" ? payload.claimSubject : undefined,
    claimPredicate: typeof payload.claimPredicate === "string" ? payload.claimPredicate : undefined,
    status: payload.noemaStatus,
  });
  const normalizedId = extractId(row?.id ?? "").replace(/^semiote:/, "");
  const supportSemioteIds = Array.from(
    new Set(
      [normalizedId, ...(Array.isArray(payload.noemaSupportSemioteIds) ? payload.noemaSupportSemioteIds.map(String) : [])]
        .filter(Boolean)
        .map((value) => value.replace(/^semiote:/, "")),
    ),
  );
  const now = new Date().toISOString();
  const noemaId = buildNoemaId({
    userId,
    scope,
    path,
    memoryRole,
    factKey,
    claimKey: claimContract.claimKey,
    canonicalText,
  });
  const existingStatus = await getExistingNoemaStatus(db, noemaId);
  const noemaStatus = existingStatus && !isValidNoemaStatusTransition(existingStatus, claimContract.status)
    ? existingStatus
    : claimContract.status;
  const semiosis = buildSemiosisSnapshot({
    confidence: Number(row?.confidence ?? payload.confidence ?? 0.5),
    usefulnessAlpha: Number(row?.usefulness_alpha ?? payload.usefulnessAlpha ?? 0),
    usefulnessBeta: Number(row?.usefulness_beta ?? payload.usefulnessBeta ?? 0),
    usefulnessScore: usefulness.usefulnessScore,
    contradictionCount: usefulness.contradictionCount,
    retrievedCount: Number(row?.retrieved_count ?? payload.retrievedCount ?? 0),
    lastEvaluatedAt: typeof row?.last_evaluated_at === "string" ? row.last_evaluated_at : payload.lastEvaluatedAt,
  });

  // Compute embedding from canonical_text when embedText is provided.
  // Graceful fallback: on failure, keep the semiote row embedding (may be empty []).
  let computedEmbedding: number[] = Array.isArray(row?.embedding) ? row.embedding : [];
  let embeddingWritten = false;
  if (embedText) {
    try {
      const embedResult = await embedText(canonicalText);
      if (Array.isArray(embedResult) && embedResult.length > 0) {
        computedEmbedding = embedResult;
        embeddingWritten = true;
      } else {
        // Provider returned empty vector (degraded Ollama etc.); keep row.embedding fallback.
        console.warn(`[promoteSemioteToNoema] embedText returned empty vector for noema "${canonicalText.slice(0, 60)}…"; using fallback embedding`);
      }
    } catch (err) {
      // Log and fall back to semiote embedding; caller sees embeddingWritten=false.
      console.warn(`[promoteSemioteToNoema] embedText failed for noema "${canonicalText.slice(0, 60)}…": ${String(err)}`);
    }
  }

  await db.query(
    `UPSERT type::record('noema', $id) SET
       canonical = $canonical,
       canonical_text = $canonicalText,
       canonical_norm = $canonicalNorm,
       scope = $scope,
       path = IF $path != NONE AND $path != NULL THEN $path ELSE NONE END,
       memory_role = $memoryRole,
       fact_key = $factKey,
       claim_key = $claimKey,
       revision_hash = $revisionHash,
       status = $status,
       stable_claim = $stableClaim,
       identity_version = $identityVersion,
       fact_key_seed = $factKeySeed,
       embedding = $embedding ?? NONE,
       confidence = $confidence,
       stability = $stability,
       authority = $authority,
       evidence_count = IF evidence_count != NONE AND evidence_count > $evidenceCount THEN evidence_count ELSE $evidenceCount END,
       confirmation_count = IF confirmation_count != NONE AND confirmation_count > $confirmationCount THEN confirmation_count ELSE $confirmationCount END,
       contradiction_count = $contradictionCount,
       support_semiote_ids = array::union(support_semiote_ids ?? [], $supportSemioteIds),
       user_id = $userId,
       active = true,
       first_derived_at = IF first_derived_at != NONE THEN first_derived_at ELSE <datetime>$now END,
       last_reinforced_at = <datetime>$now,
       created_at = IF created_at != NONE THEN created_at ELSE <datetime>$now END,
       updated_at = <datetime>$now;`,
    {
      id: noemaId,
      canonical: {
        text: canonicalText,
        l0: payload.l0 ?? null,
        l1: payload.l1 ?? null,
        factKey: factKey ?? null,
        claimKey: claimContract.claimKey,
        revisionHash: claimContract.revisionHash,
        status: noemaStatus,
        stableClaim: claimContract.stableClaim,
      },
      canonicalText,
      canonicalNorm: normalizeText(canonicalText),
      scope: scope ?? null,
      // imaf.11 #1: pathless noema MUST land as NONE (field absent), never SQL
      // NULL — SurrealDB treats them as distinct, and the recall predicate
      // matches `path = NONE` only, so NULL-stored pathless noema was
      // invisible under any requestedPath recall. The SQL IF above normalizes;
      // existing NULL rows were backfilled live (UPDATE ... SET path = NONE).
      path: path ?? null,
      memoryRole: memoryRole ?? null,
      factKey: factKey ?? null,
      claimKey: claimContract.claimKey,
      revisionHash: claimContract.revisionHash,
      status: noemaStatus,
      stableClaim: claimContract.stableClaim,
      identityVersion: claimContract.identityVersion,
      factKeySeed: claimContract.factKeySeed ?? null,
      embedding: embeddingForStore(computedEmbedding),
      confidence: semiosis.utility,
      stability: semiosis.stability,
      authority: semiosis.authority,
      evidenceCount: supportSemioteIds.length,
      confirmationCount: usefulness.successfulUseCount,
      contradictionCount: usefulness.contradictionCount,
      supportSemioteIds,
      userId,
      now,
    },
  );

  await db.query(
    `UPDATE type::record('semiote', $id) SET
      payload.promotedToNoemaId = $noemaRecordId,
      payload.noemaSupportSemioteIds = $supportSemioteIds,
      payload.noemaClaimKey = $claimKey,
      payload.noemaRevisionHash = $revisionHash,
      payload.noemaStatus = $status,
      payload.noemaStableClaim = $stableClaim,
      updated_at = time::now();`,
    {
      id: normalizedId,
      noemaRecordId: `noema:${noemaId}`,
      supportSemioteIds,
      claimKey: claimContract.claimKey,
      revisionHash: claimContract.revisionHash,
      status: noemaStatus,
      stableClaim: claimContract.stableClaim,
    },
  );

  return { promoted: true, id: `noema:${noemaId}`, embeddingWritten };
}
