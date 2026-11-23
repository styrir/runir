// Shared types for the hybrid retrieval legs, fusion and debug sidecars.
// Split out of memory-query.ts (vk-2996).
import { type NoemaRetrievalPolicy } from "../policy/noema-retrieval-policy.js";
import { type RankingProfile } from "../policy/ranking-profile.js";
import type { MemoryScope } from "../../domain/memory/types";

export type NoemaRetrievalLegOptions = {
  policy: NoemaRetrievalPolicy;
  requestedPath?: string;
};

export interface EntityRetrievalTraceMatch {
  queryMention: string;
  normalizedMention: string;
  entityId?: string;
  canonicalName?: string;
  matchedBy?: "name" | "alias";
  scope?: MemoryScope;
  linkedMemoryIds: string[];
  scoreChanges?: Array<{ memoryId: string; before: number; boost: number; after: number }>;
  ignoredReason?: string;
}

export type EntityLookupScope = { scope: MemoryScope; sessionId?: string };

/**
 * Default recency window in hours for the third RRF list.
 * Memories created within this window are eligible for recency boosting.
 * 48h balances "recent context matters" with avoiding noise from old memories.
 */
export const RECENCY_WINDOW_HOURS = 48;

// ---------------------------------------------------------------------------
// Parallel retrieval leg types
// ---------------------------------------------------------------------------

export type VectorRow = { id: unknown; rank: number };
export type Bm25Row = {
  id: unknown;
  score: number;
  rank: number;
  source: "native" | "fallback";
  matchedTerms?: string[];
};
export type RecencyRow = { id: unknown; createdAt: string; rank: number };
export type EntityRow = {
  id: unknown;
  rank: number;
  score: number;
  matchedEntities: string[];
  linkedMemoryIds: string[];
};

export type FusedRow = {
  id: unknown;
  score: number;
  vectorRank?: number;
  bm25Rank?: number;
  bm25Score?: number;
  recencyRank?: number;
  recencyCreatedAt?: string;
  entityRank?: number;
  entityScore?: number;
};

/**
 * Per-unit retrieval ranks for the `debug.legRanks` sidecar (Rúnir-x41m.10 Layer 2).
 * All ranks are 1-based. vector/bm25/recency/entity are per-leg ranks; `rrf` is the
 * fused rank BEFORE exact-QA re-sort, noema merge, reranker, and threshold filtering
 * (i.e. "where fusion placed it", NOT the final selected rank).
 */
export type LegRanks = Record<string, { vector?: number; bm25?: number; recency?: number; entity?: number; rrf?: number }>;

/**
 * Debug-only sidecar (Rúnir-x41m.10 Layer 2): the ACTUAL candidate-window + reranker-stage
 * orders, captured AFTER exact-QA re-sort / overlay merge / noema merge (the order entering
 * the reranker) and AFTER reranking. These cannot be reconstructed from `legRanks` (which is
 * the raw RRF order) because the reranker and the merges reorder/drop. Read-only, ranking-neutral.
 */
export interface RecallCandidateStages {
  candidateLimit: number;          // the ACTUAL candidateLimit used (post RERANKER_CANDIDATE_FLOOR/clamp)
  // Always equal to candidateLimit / the full candidate pool (the Rúnir-x41m.11 split-window
  // env overrides were stripped in Rúnir-tp2w.3; no-ship, no promote path).
  legFetchLimit?: number;          // per-leg fetch depth actually used (always set by the real emitter)
  fusionCandidateLimit?: number;   // fused-window slice actually used
  rerankCandidateLimit?: number;   // # fused candidates the reranker actually scored (rerankPool size)
  candidatePoolIds: string[];      // full fused+merged pool (post fuse/exactQA/overlay/noema)
  preRerankerIds: string[];        // rerankPool order entering the reranker (always == candidatePoolIds; no rerank-window slice exists post Rúnir-tp2w.3 strip)
  postRerankerIds: string[];       // finalHits order (== preRerankerIds when reranker off / empty scores)
  rerankerActive: boolean;
  rerankerThreshold?: number;
  rerankerScores?: Record<string, number>;
}

export interface HybridQueryTuningOptions {
  rrfWeights?: {
    vector: number;
    bm25: number;
    recency: number;
    entity?: number;
  };
  recencyWindowHours?: number;
  nowMs?: number;
  entityLookupSessionId?: string;
  /**
   * Per-tenant ranking profile (Rúnir-mmg2) supplying the entity-mention filler
   * words + taxonomy-expansion facets for this request's tenant. When omitted,
   * the clean EMPTY_PROFILE applies (no filler filtering, no query expansion).
   */
  rankingProfile?: RankingProfile;
  /**
   * Exact-QA preserve floor score (Rúnir-qjn4.3, ruling R3 — DEFAULT-OFF).
   * Resolved by the orchestrator from the declared ranking plan's
   * `exact_qa_preserve_floor` entry. When set, an exact-QA hit preserved past the
   * rerank threshold gets a floor score = this value (the active threshold) so it
   * ranks with the reranked-cosine population instead of parking at the RRF-scale
   * bottom. When undefined (the default plan keeps the entry disabled), the
   * preserve path is byte-identical to before.
   */
  exactQaPreserveFloor?: number;
  onEntityTrace?: (matches: EntityRetrievalTraceMatch[]) => void;
  // Debug-only sidecar (set by the trace route): emits per-unit per-leg ranks. Built only
  // when present, so production retrieval never pays the cost. Does NOT touch RetrievalTrace.
  onLegRanks?: (legRanks: LegRanks) => void;
  // Debug-only sidecar (Rúnir-x41m.10): emits the actual pre/post-reranker candidate orders +
  // the real candidateLimit. Built only when present; read-only, ranking-neutral.
  onCandidateStages?: (stages: RecallCandidateStages) => void;
}
