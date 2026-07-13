import type { SearchHit } from "../../domain/memory/types.js";
import type { RecallMemoryKind } from "../continuity/recall-status-policy.js";
import type { IntentSignal } from "../intent/intent-analyzer.js";

export type RecallLane =
  | "session_opener"
  | "compaction_projection"
  | "current_status"
  | "latest_state"
  | "guidance_reference"
  | "workflow_posture"
  | "exact_lookup"
  | "recent_work"
  | "decision_trace"
  | "exploratory_topic"
  | "unknown_mixed";

export type RetrievalPathKind = "deterministic" | "hybrid" | "latest_state";

export type RetrievalRecipeId =
  | "status_current"
  | "compaction_projection"
  | "workflow_posture"
  | "history_change"
  | "reference_architecture"
  | "general_recall";

export type RetrievalRecipeSourceName =
  | "project_state"
  | "continuity_memory"
  | "vector"
  | "bm25"
  | "recency"
  | "entity"
  | "latest_state_representatives";

export type LatestStateShapingUsage = "off" | "deterministic_continuity" | "latest_state_lane";
export type SelectorProfile =
  | "status_continuity"
  | "guidance_reference"
  | "workflow_posture"
  | "recent_work"
  | "mixed_default";

export type AdmissibilityContinuityClass = "durable_guidance" | "transient_continuity" | "neutral";
export type AdmissibilityContinuityDisposition =
  | "preferred"
  | "allowed"
  | "capped"
  | "compatibility_only"
  | "disallowed";
export type AdmissibilitySelectionEngine = "contract_enforced" | "continuity_resolved";
export type ContinuityResolverMode = "strict" | "fallback";

export interface AdmissibilityCap {
  group: RecallMemoryKind;
  max: number;
}

export interface AdmissibilityContractDefinition {
  id: string;
  version: string;
  selectorProfile: SelectorProfile;
  selectionEngine: AdmissibilitySelectionEngine;
  primaryGroups: RecallMemoryKind[];
  secondaryGroups: RecallMemoryKind[];
  barredGroups: RecallMemoryKind[];
  cappedGroups: AdmissibilityCap[];
  continuityClasses: Record<AdmissibilityContinuityClass, AdmissibilityContinuityDisposition>;
  requirePrimaryRepresentative: boolean;
  compatibilityMode?: boolean;
}

export interface RrfWeights {
  vector: number;
  bm25: number;
  recency: number;
}

export interface RetrievalRecipeDefinition {
  id: RetrievalRecipeId;
  version: string;
  retrievalPath: RetrievalPathKind;
  relationExpansionEnabled: boolean;
  stableKnowledgeEnabled: boolean;
  formattingShape: "session_opener" | "recall_injection";
  traceLabels: string[];
}

export interface RetrievalRecipeSourceBudget {
  source: RetrievalRecipeSourceName;
  budget: number;
}

export interface RetrievalRecipeSourceCount {
  source: RetrievalRecipeSourceName;
  count: number;
}

export interface RetrievalRecipeTraceMetadata {
  id: RetrievalRecipeId;
  version: string;
  relationExpansionEnabled: boolean;
  latestStateShaping: LatestStateShapingUsage;
  selectorProfile: SelectorProfile;
  admissibilityContractId?: string;
  admissibilityContractVersion?: string;
  rrfWeights?: RrfWeights;
  recencyWindowHours?: number;
  sourceBudgets: RetrievalRecipeSourceBudget[];
  sourceCounts: RetrievalRecipeSourceCount[];
}

export interface HexisLanePolicy {
  enabled: boolean;
  reorderWindow: number;
  scoreEpsilon: number;
  ambiguityThreshold: number;
  hexisLambda: number;
}

export interface RetrievalPolicy {
  lane: RecallLane;
  retrievalPath: RetrievalPathKind;
  useDeterministicContinuity: boolean;
  useLatestStateResolution: boolean;
  selectorProfile: SelectorProfile;
  admissibilityContract?: AdmissibilityContractDefinition;
  rrfWeights?: RrfWeights;
  recencyWindowHours?: number;
  hexis: HexisLanePolicy;
}

export interface HexisGateDecision {
  enabled: boolean;
  reason: string;
  reorderWindow: number;
  ambiguityGap: number;
  admissibleIds: string[];
}

export interface RetrievalAdmissibilityEvent {
  id: string;
  group: RecallMemoryKind;
  continuityClass: AdmissibilityContinuityClass;
  source: "memoryRole" | "heuristic";
  reasonCode: string;
}

export interface RetrievalAdmissibilityDrop extends RetrievalAdmissibilityEvent {
  decision: "barred_group" | "over_cap" | "unsupported_group";
  cap?: number;
}

export interface RetrievalAdmissibilityRepresentativePromotion {
  insertedId: string;
  displacedId?: string;
  group: RecallMemoryKind;
  reason: "primary_representative_required";
}

export interface RetrievalAdmissibilityAudit {
  contractId: string;
  contractVersion: string;
  selectorProfile: SelectorProfile;
  selectionEngine: AdmissibilitySelectionEngine;
  primaryGroups: RecallMemoryKind[];
  secondaryGroups: RecallMemoryKind[];
  barredGroups: RecallMemoryKind[];
  cappedGroups: AdmissibilityCap[];
  continuityClasses: Record<AdmissibilityContinuityClass, AdmissibilityContinuityDisposition>;
  requirePrimaryRepresentative: boolean;
  compatibilityMode?: boolean;
  continuityResolverMode?: ContinuityResolverMode;
  admittedIds: string[];
  droppedIds: string[];
  dropped: RetrievalAdmissibilityDrop[];
  selected: RetrievalAdmissibilityEvent[];
  representativePromotion?: RetrievalAdmissibilityRepresentativePromotion;
}

export interface RetrievalAuditRecord {
  lane: RecallLane;
  baseCandidateCount: number;
  baseCandidateIds?: string[];
  finalSelectedIds?: string[];
  recipe?: RetrievalRecipeTraceMetadata;
  admissibility?: RetrievalAdmissibilityAudit;
  latestState?: {
    collapsedGroupCount: number;
    collapsedIdentityKeys: string[];
    hydratedIds: string[];
    representativeIds: string[];
    droppedSeedIds: string[];
  };
  hexis?: {
    enabled: boolean;
    applied: boolean;
    reason: string;
    reorderWindow: number;
    ambiguityGap: number;
    admissibleIds: string[];
    laneLambda?: number;
    hexisMode?: number;
  };
  calibration?: RetrievalCalibrationTelemetry;
  clientScope?: {
    mode: "none" | "prefer" | "strict";
    requestedClient?: string;
  };
  noema?: {
    policyId: string;
    mode: "primary" | "annotation" | "disabled";
    reason: string;
    candidateCount: number;
    candidateIds: string[];
  };
  /**
   * Debug-only recall attribution envelope (Rúnir-x41m.10 Layer 2). Set ONLY on the
   * `_debug` response clone in /hooks/recall — NEVER on the object passed to persistTrace,
   * so it is never persisted. Additive optional field: ADR-0008 freezes RetrievalTrace,
   * not RetrievalAuditRecord, so this requires no traceSchemaVersion bump.
   */
  attribution?: RecallAttributionEnvelope;
}

/**
 * Versioned, production-faithful recall attribution (Rúnir-x41m.10 Layer 2 / Option A+).
 * Emitted natively by /hooks/recall (the single prod pipeline) so retrieval-stage loss can be
 * attributed WITHOUT cross-comparing the divergent harness /memory/search pipeline. All IDs are
 * bare (extractId form) so legRanks / pre / post / base / final / access-tracked / rendered are mutually joinable.
 */
export interface RecallAttributionEnvelope {
  schemaVersion: 1;
  lane: RecallLane;
  recipeId?: string;
  recipeVersion?: string;
  retrievalPath: string;
  /** The ACTUAL prod window: topK + the real candidateLimit (post RERANKER_CANDIDATE_FLOOR/clamp).
   *  leg/fusion always equal candidateLimit and rerank always equals the full candidate-pool size
   *  (the Rúnir-x41m.11 split-window screen overrides were stripped in Rúnir-tp2w.3; no-ship,
   *  see docs/analysis/ for the concluded measurement). */
  window: {
    topK: number;
    candidateLimit: number;
    legFetchLimit?: number;
    fusionCandidateLimit?: number;
    rerankCandidateLimit?: number;
  };
  /** Per-unit per-leg 1-based ranks over the prod candidate window; rrf is over the full fused set. */
  legRanks: Record<string, { vector?: number; bm25?: number; recency?: number; entity?: number; rrf?: number }>;
  /** Raw RRF fusion order incl. ranks beyond candidateLimit (derived from legRanks by .rrf). */
  rrfFusedIds: string[];
  /** Full fused+merged candidate pool (post fuse/exactQA/overlay/noema). Always equal to
   *  preRerankerIds — no rerank-window slice exists post Rúnir-tp2w.3 strip (Rúnir-x41m.11
   *  historical origin: this field originally distinguished "cut by the rerank window" from
   *  "below the fusion window"). */
  candidatePoolIds: string[];
  /** Size of the per-user write-through overlay snapshot merged into the pool (mergeOverlayLeg). The
   *  overlay leg is wired into /hooks/recall; 0 = wired but inert (no captures) → cannot reorder the
   *  pool, so the only active pre-rerank reorder is the exact-QA re-sort (Rúnir-x41m.11 pass-5). */
  overlaySnapshotCount: number;
  /** Actual order entering the reranker (always == candidatePoolIds; no rerank-window slice
   *  exists post Rúnir-tp2w.3 strip). */
  preRerankerIds: string[];
  /** Actual final order out of the hybrid query (cross-checks the returned rawResults order). */
  postRerankerIds: string[];
  reranker: { active: boolean; threshold?: number; droppedIds: string[]; scores?: Record<string, number> };
  /** rawResults dropped by post-query soft filters (since/tier/tags/confidence). */
  softFilteredIds: string[];
  /** The post-admissible base pool (mirror of audit.baseCandidateIds, bare). */
  baseCandidateIds: string[];
  /** Final selected set (mirror of audit.finalSelectedIds, bare). */
  finalSelectedIds: string[];
  /** Access-tracked IDs, bare. NOT "shown": postProcessRecallResults excludes noema hits,
   *  null-path fallbacks, and stale-demoted hits from access tracking. */
  accessTrackedIds: string[];
  /** The reader-visible set: selected hits whose rendered injection line is non-empty, bare. */
  renderedSelectedIds: string[];
  /** noemaId -> support_semiote_ids: a selected noema hit can answer for a semiote gold unit. */
  noemaSupport?: Record<string, string[]>;
}

export interface HexisPolicyApplication {
  hits: SearchHit[];
  gate: HexisGateDecision;
}

export interface RetrievalControllerResolution {
  intent: IntentSignal;
  policy: RetrievalPolicy;
  recipe: RetrievalRecipeDefinition;
}

export interface RetrievalCalibrationCandidate {
  rank: number;
  idHash: string;
  score: number;
  rrf?: {
    score?: number;
    vectorRank?: number;
    bm25Rank?: number;
    recencyRank?: number;
  };
  hexis?: {
    preScore?: number;
    postScore?: number;
    poolRank?: number;
    boundaryGap?: number;
    gateValue?: number;
    hexisMode?: number;
    laneLambda?: number;
  };
}

export interface RetrievalCalibrationTelemetry {
  lane: RecallLane;
  rrfK: number;
  rrfWeights: RrfWeights;
  safeLimit: number;
  reorderWindow: number;
  topCandidates: RetrievalCalibrationCandidate[];
  top2Gap?: number;
  top3Gap?: number;
  hexis: {
    triggered: boolean;
    reason: string;
    effectiveThreshold: number;
    lambda: number;
    mode?: number;
  };
  recallLatencyMs: number;
  emittedContextSize: number;
}
