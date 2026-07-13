import type { QueryIntent } from "../intent/intent-analyzer.js";
import { resolveAdmissibilityContractForSelectorProfile } from "./admissibility-contract.js";
import type { RecallLane, RetrievalPolicy, RrfWeights } from "./policy-types.js";

const HYBRID_HEXIS = {
  enabled: true,
  reorderWindow: 7,
  scoreEpsilon: 0.0015,
  ambiguityThreshold: 0.08,
  hexisLambda: 0.25,
} as const;

const STRICT_HEXIS = {
  enabled: true,
  reorderWindow: 5,
  scoreEpsilon: 0.0015,
  ambiguityThreshold: 0.05,
  hexisLambda: 0.1,
} as const;

const NO_HEXIS = {
  enabled: false,
  reorderWindow: 0,
  scoreEpsilon: 0,
  ambiguityThreshold: 0,
  hexisLambda: 0,
} as const;

const DEFAULT_RRF_WEIGHTS: RrfWeights = {
  vector: 1.0,
  bm25: 1.2,
  recency: 0.8,
};

const GUIDANCE_REFERENCE_RRF_WEIGHTS: RrfWeights = {
  vector: 1.0,
  bm25: 1.45,
  recency: 0.2,
};

const RECENT_WORK_RRF_WEIGHTS: RrfWeights = {
  vector: 1.0,
  bm25: 1.25,
  recency: 0.45,
};

const WORKFLOW_POSTURE_RRF_WEIGHTS: RrfWeights = {
  vector: 1.0,
  bm25: 1.35,
  recency: 0.35,
};

export function mapIntentToRecallLane(label: QueryIntent): RecallLane {
  switch (label) {
    case "session_opener":
      return "session_opener";
    case "pre_compaction":
    case "post_compaction_validation":
      return "compaction_projection";
    case "current_status":
      return "current_status";
    case "latest_state":
      return "latest_state";
    case "architecture":
      return "guidance_reference";
    case "workflow_posture":
      return "workflow_posture";
    case "recent_work":
      return "recent_work";
    case "exact_lookup":
      return "exact_lookup";
    case "decision_trace":
    case "decision":
      return "decision_trace";
    case "exploratory_topic":
      return "exploratory_topic";
    case "entity":
    case "schema":
    case "debugging":
    case "preference":
      return "exact_lookup";
    case "event":
      return "exploratory_topic";
    case "unknown_mixed":
    case "fact":
    default:
      return "unknown_mixed";
  }
}

export function resolveRetrievalPolicyForLane(lane: RecallLane): RetrievalPolicy {
  switch (lane) {
    case "session_opener":
      return {
        lane,
        retrievalPath: "deterministic",
        useDeterministicContinuity: true,
        useLatestStateResolution: false,
        selectorProfile: "status_continuity",
        admissibilityContract: resolveAdmissibilityContractForSelectorProfile("status_continuity"),
        hexis: NO_HEXIS,
      };
    case "compaction_projection":
      // OM-2 (Rúnir-tfxt.2): same deterministic status/continuity shape as the
      // opener lane. Unlike every other deterministic lane, compaction recalls
      // NEVER fall through to hybrid — the orchestrator returns an honest
      // empty response when this lane yields nothing (a compaction lifecycle
      // ping has no user prompt worth embedding).
      return {
        lane,
        retrievalPath: "deterministic",
        useDeterministicContinuity: true,
        useLatestStateResolution: false,
        selectorProfile: "status_continuity",
        admissibilityContract: resolveAdmissibilityContractForSelectorProfile("status_continuity"),
        hexis: NO_HEXIS,
      };
    case "current_status":
      return {
        lane,
        retrievalPath: "deterministic",
        useDeterministicContinuity: true,
        useLatestStateResolution: false,
        selectorProfile: "status_continuity",
        admissibilityContract: resolveAdmissibilityContractForSelectorProfile("status_continuity"),
        hexis: NO_HEXIS,
      };
    case "latest_state":
      return {
        lane,
        retrievalPath: "latest_state",
        useDeterministicContinuity: false,
        useLatestStateResolution: true,
        selectorProfile: "status_continuity",
        admissibilityContract: resolveAdmissibilityContractForSelectorProfile("status_continuity"),
        hexis: STRICT_HEXIS,
      };
    case "guidance_reference":
      return {
        lane,
        retrievalPath: "hybrid",
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        selectorProfile: "guidance_reference",
        admissibilityContract: resolveAdmissibilityContractForSelectorProfile("guidance_reference"),
        rrfWeights: GUIDANCE_REFERENCE_RRF_WEIGHTS,
        recencyWindowHours: 12,
        hexis: { ...STRICT_HEXIS, hexisLambda: 0.05 },
      };
    case "workflow_posture":
      return {
        lane,
        retrievalPath: "hybrid",
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        selectorProfile: "workflow_posture",
        admissibilityContract: resolveAdmissibilityContractForSelectorProfile("workflow_posture"),
        rrfWeights: WORKFLOW_POSTURE_RRF_WEIGHTS,
        recencyWindowHours: 18,
        hexis: { ...STRICT_HEXIS, hexisLambda: 0.05 },
      };
    case "exact_lookup":
      return {
        lane,
        retrievalPath: "hybrid",
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        selectorProfile: "mixed_default",
        rrfWeights: { ...DEFAULT_RRF_WEIGHTS, recency: 0.2 },
        recencyWindowHours: 12,
        hexis: { ...STRICT_HEXIS, hexisLambda: 0 },
      };
    case "recent_work":
      return {
        lane,
        retrievalPath: "hybrid",
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        selectorProfile: "recent_work",
        admissibilityContract: resolveAdmissibilityContractForSelectorProfile("recent_work"),
        rrfWeights: RECENT_WORK_RRF_WEIGHTS,
        recencyWindowHours: 24,
        hexis: STRICT_HEXIS,
      };
    case "decision_trace":
      return {
        lane,
        retrievalPath: "hybrid",
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        selectorProfile: "mixed_default",
        rrfWeights: { ...DEFAULT_RRF_WEIGHTS, recency: 0.35 },
        recencyWindowHours: 18,
        hexis: HYBRID_HEXIS,
      };
    case "exploratory_topic":
      return {
        lane,
        retrievalPath: "hybrid",
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        selectorProfile: "mixed_default",
        rrfWeights: DEFAULT_RRF_WEIGHTS,
        recencyWindowHours: 48,
        hexis: HYBRID_HEXIS,
      };
    case "unknown_mixed":
    default:
      return {
        lane,
        retrievalPath: "hybrid",
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        selectorProfile: "mixed_default",
        rrfWeights: DEFAULT_RRF_WEIGHTS,
        recencyWindowHours: 48,
        hexis: { ...HYBRID_HEXIS, hexisLambda: 0.2 },
      };
  }
}
