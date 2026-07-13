// Retrieval-side types: hybrid plugin config, scoring/ranking shapes, search
// hit, session-opener payloads, and BM25/embedding tuning constants.
//
// Anything consumed by the recall lanes, ranker, or session-opener composer
// belongs here. Persisted record shapes live in `./payload.js`.

import type { MemoryCategory, MemoryRole, MemoryTier } from "./boundary.js";
import type { ContinuityDirective } from "./lifecycle.js";
import type {
  MemoryAtomicClaim,
  MemoryAtomicFact,
  MemoryEvent,
  MemoryRawSpan,
} from "./payload.js";

/**
 * Default OpenRouter model for the LLM reranker when RERANKER_MODEL is unset.
 * A fast, cheap, low-latency model is the right tool here: the reranker is an
 * inline step with a hard timeout that scores ~50 candidates per query — it does
 * not need a reasoning-class model. Operators override via RERANKER_MODEL
 * (threaded through RerankerConfig.model → rerankWithLabels). See Rúnir-imaf.3.
 */
export const DEFAULT_LLM_RERANKER_MODEL = "google/gemini-2.5-flash-lite";

/** Discriminated union for reranker provider configuration. */
export type RerankerConfig =
  | { provider: "off" }
  | { provider: "local"; timeoutMs?: number; threshold?: number }
  | { provider: "llm"; openrouterApiKey: string; model?: string; timeoutMs?: number; threshold?: number };

/** Shared plugin configuration for memory-hybrid. */
export type HybridConfig = {
  userId: string;
  autoRecall: boolean;
  autoCapture: boolean;
  topK: number;
  customPrompt?: string;
  surrealdb: {
    url: string;
    username: string;
    password: string;
    namespace: string;
    database: string;
  };
  embedder: {
    provider: "ollama" | "nomic" | "llamacpp";
    model: string;
    baseURL: string;
    apiKey?: string;
    dimensions: number;
    timeoutMs: number;
  };
  reranker: RerankerConfig;
  extractTimeoutMs?: number;
  extractModel?: string;
  extractMaxChars: number;
};

/** Cached corpus stats used for app-side BM25 scoring. */
export type Bm25CorpusStats = {
  totalDocs: number;
  avgDocLength: number;
  refreshedAtMs: number;
};

export type ScoreStageName = "vector" | "bm25" | "rrf" | "reranker" | "hexis" | "noema" | "entity" | "exact";

export type ScoreStageAttribution = Partial<{
  vector: {
    score: number;
    rank: number;
  };
  bm25: {
    score: number;
    rank: number;
    source?: "native" | "fallback";
    matchedTerms?: string[];
  };
  recency: {
    rank: number;
    age?: string;
  };
  rrf: {
    score: number;
    vectorRank?: number;
    bm25Rank?: number;
    recencyRank?: number;
    entityRank?: number;
  };
  reranker: {
    score: number;
    label?: string;
    threshold: number;
  };
  hexis: {
    fit: number;
    boost: number;
    version: number;
  };
  noema: {
    score: number;
    matchedTerms?: string[];
    // Optional 1-based ranks the noema mini-RRF fused (Rúnir-0gk6.2). These stay
    // INSIDE the single composite noema entry — noema's vector+BM25 sub-legs are not
    // disaggregated into the top-level legRanks (they merge via the policy seam), so
    // the replay envelope (id-sequences + legRanks) is unchanged. Undefined when the
    // candidate did not appear in that sub-leg.
    vectorRank?: number;
    bm25Rank?: number;
  };
  entity: {
    score: number;
    rank: number;
    matchedEntities: string[];
    linkedMemoryIds?: string[];
    boost: number;
    scoreBefore: number;
    scoreAfter: number;
  };
  exact: {
    score: number;
    matchedTokens?: string[];
  };
}>;

  /** Common search hit shape used across retrieval and tools. */
export type SearchHit = {
  id: string;
  text: string;
  score: number;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  /** Memory category for intent-based retrieval boosting (MIM-45). */
  category?: MemoryCategory;
  /** Deterministic continuity/state classification persisted on ingress. */
  memoryRole?: MemoryRole;
  /** ISO timestamp when this record became valid/current. */
  validAt?: string;
  /** ISO timestamp when this record ceased to be current. */
  invalidAt?: string;
  /** Scope of this memory record (present on new records; undefined on legacy). */
  scope?: string;
  /** Session ID (present when scope="session"; undefined otherwise). */
  sessionId?: string;
  /** Deterministic subject identity key for continuity invalidation. */
  continuitySubjectKey?: string;
  /** Per-stage scoring attribution for retrieval debugging. */
  scoreStages?: ScoreStageAttribution;
  /** Hexis metadata applied during ranking. */
  hexisId?: string;
  hexisVersion?: number;
  hexisFit?: number;
  rankingExplanation?: string[];
  /** Hexis Phase 3a audit scalars (per-hit, top-W only; stable schema). */
  preHexisScore?: number;
  postHexisScore?: number;
  poolRank?: number;
  boundaryGap?: number;
  gateValue?: number;
  hexisMode?: number;
  /** Hexis Phase 3b: per-lane lambda echoed from controller (always emitted). */
  laneLambda?: number;
  // Attribution & soft-filter fields (Code-jrzw)
  tier?: MemoryTier;
  confidence?: number;
  /** Stored abstract/title summary for depth-aware rendering. */
  l0?: string;
  /** Stored structured summary for richer renderers and audit views. */
  l1?: string;
  /** Filesystem path at write time (payload.path). Used for path-scoped penalty (MIM-71). */
  path?: string;
  /** Client attribution at write time (payload.client). */
  client?: string;
  // Staleness metadata (MIM-69 Task 14)
  /** Whether this record has been marked stale by the staleness pass. */
  isStale?: boolean;
  /** ISO datetime when the record was marked stale. */
  staleSince?: string;
  /** ID of the record that superseded this one. */
  contradictedBy?: string;
  /** Whether the record is active in the lifecycle model. */
  active?: boolean;
  /** Reason inactive records were inactivated. */
  inactiveReason?: string;
  /** ID of the record that superseded this one in lifecycle metadata. */
  supersededById?: string;
  /** Root lineage record ID for audit/debug views. */
  lineageRootId?: string;
  /** Source table/kind for policy-aware retrieval legs. */
  sourceKind?: "semiote" | "noema";
  /** Promoted Noema claim identity metadata, when known. */
  noemaClaimKey?: string;
  noemaRevisionHash?: string;
  noemaStatus?: string;
  noemaSupportSemioteIds?: string[];
  /** Original user/assistant turn text before LLM paraphrasing (Rúnir-xguo/o2kz). */
  raw_source_text?: string;
  rawSpan?: MemoryRawSpan;
  rawSpans?: MemoryRawSpan[];
  atomicFact?: MemoryAtomicFact;
  event?: MemoryEvent;
  atomicClaims?: MemoryAtomicClaim[];
  exactQaCandidate?: boolean;
  exactQaScore?: number;
  /**
   * Stored candidate embedding vector, plumbed from the stage-2 fetch for the
   * local reranker (Rúnir-ogkn.2). Transient (~50×768 floats per recall); never
   * serialised to the wire. Absent for BM25/entity/recency-only hits that have no
   * stored embedding (embedding = NONE in DB).
   */
  embedding?: number[];
};

export type SessionOpenerConfidence = "high" | "medium" | "low";

export type SessionOpenerStatus = "active" | "blocked" | "stale";

export type SessionOpenerWarning = "path_fallback_used" | "transitional_memory_admitted";

export type SessionOpenerEvidenceItem = {
  id: string;
  role?: MemoryRole;
  title: string;
  summary: string;
  updatedAt?: string;
  path?: string;
};

export type SessionOpenerPayload = {
  intent: "continue_previous_work";
  confidence: SessionOpenerConfidence;
  scope: {
    project?: string;
    area?: string;
    path?: string;
  };
  status: SessionOpenerStatus;
  focus: string[];
  state: string[];
  env: string[];
  next: string[];
  directives: ContinuityDirective[];
  evidenceTitles: string[];
  warnings: SessionOpenerWarning[];
  evidence: {
    projectState?: SessionOpenerEvidenceItem;
    handoff: SessionOpenerEvidenceItem[];
    active: SessionOpenerEvidenceItem[];
    recentWork: SessionOpenerEvidenceItem[];
    supplemental: SessionOpenerEvidenceItem[];
  };
};

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const BM25_STATS_TTL_MS = 5 * 60 * 1000;
export const RETRIEVAL_DB_TIMEOUT_MS = 8000;
export const EMBEDDING_TIMEOUT_MS = 4000;
// Per-leg bound for the entity retrieval leg inside nativeRrfSearch. The entity
// leg's sequential per-match N+1 lookups can run several seconds and, since the
// RRF legs run under one Promise.all, a slow entity leg dragged the whole RRF to
// the 8s outer timeout → empty hits → the annotation-noema cascade (16s, zero
// results). Bounding it below RETRIEVAL_DB_TIMEOUT_MS lets RRF complete with the
// fast legs (vector/bm25/recency) and degrade entity hits gracefully (Rúnir-yxwe).
export const ENTITY_LEG_TIMEOUT_MS = 5000;
// Global wall-clock budget for the sequential RRF + noema legs of one recall, so
// two stacked timeouts can't spend ~16s. The noema leg's effective timeout is the
// remaining budget after RRF (Rúnir-yxwe).
export const RECALL_BUDGET_MS = 10000;
// Floor below which the remaining recall budget is too small to bother starting
// the noema leg — skip it and return the RRF hits rather than burn the tail on a
// near-certain timeout (Rúnir-yxwe).
export const MIN_NOEMA_BUDGET_MS = 500;
// Floor below which the remaining recall budget is too small to bother starting
// the rerank stage — skip it and return the fused (pre-rerank) order rather than
// burn the tail on a near-certain timeout. The rerank stage runs AFTER RRF + noema,
// anchored at the same legsStartMs, so its effective bound is the remaining budget
// after those legs; a stalled embedder/provider must not hold recall open past
// RECALL_BUDGET_MS (Rúnir-ogkn.3, outage class of Rúnir-yxwe/imaf.10).
export const MIN_RERANK_BUDGET_MS = 300;
