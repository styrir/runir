import type { QueryIntent } from "../intent/intent-analyzer.js";
import type {
  RetrievalPathKind,
  RetrievalPolicy,
  RetrievalRecipeDefinition,
  RetrievalRecipeId,
  RetrievalRecipeSourceBudget,
  RetrievalRecipeSourceCount,
  RetrievalRecipeSourceName,
  RetrievalRecipeTraceMetadata,
} from "./policy-types.js";

const INITIAL_RECIPE_VERSION = "phase-a-v1";
const CONTINUITY_BUDGET = 5;

const RECIPE_REGISTRY: Record<RetrievalRecipeId, RetrievalRecipeDefinition> = {
  status_current: {
    id: "status_current",
    version: INITIAL_RECIPE_VERSION,
    retrievalPath: "deterministic",
    relationExpansionEnabled: false,
    stableKnowledgeEnabled: true,
    formattingShape: "session_opener",
    traceLabels: ["status", "continuity", "current"],
  },
  compaction_projection: {
    id: "compaction_projection",
    version: INITIAL_RECIPE_VERSION,
    retrievalPath: "deterministic",
    relationExpansionEnabled: false,
    stableKnowledgeEnabled: true,
    formattingShape: "session_opener",
    traceLabels: ["compaction", "continuity", "projection"],
  },
  workflow_posture: {
    id: "workflow_posture",
    version: INITIAL_RECIPE_VERSION,
    retrievalPath: "hybrid",
    relationExpansionEnabled: false,
    stableKnowledgeEnabled: true,
    formattingShape: "recall_injection",
    traceLabels: ["workflow", "posture"],
  },
  history_change: {
    id: "history_change",
    version: INITIAL_RECIPE_VERSION,
    retrievalPath: "hybrid",
    relationExpansionEnabled: false,
    stableKnowledgeEnabled: true,
    formattingShape: "recall_injection",
    traceLabels: ["history", "change"],
  },
  reference_architecture: {
    id: "reference_architecture",
    version: INITIAL_RECIPE_VERSION,
    retrievalPath: "hybrid",
    relationExpansionEnabled: false,
    stableKnowledgeEnabled: true,
    formattingShape: "recall_injection",
    traceLabels: ["reference", "architecture"],
  },
  general_recall: {
    id: "general_recall",
    version: INITIAL_RECIPE_VERSION,
    retrievalPath: "hybrid",
    relationExpansionEnabled: false,
    stableKnowledgeEnabled: true,
    formattingShape: "recall_injection",
    traceLabels: ["general", "recall"],
  },
};

function cloneRecipe(recipe: RetrievalRecipeDefinition): RetrievalRecipeDefinition {
  return {
    ...recipe,
    traceLabels: [...recipe.traceLabels],
  };
}

function resolveRecipeIdForIntent(intentLabel: QueryIntent): RetrievalRecipeId {
  switch (intentLabel) {
    case "session_opener":
    case "current_status":
    case "latest_state":
      return "status_current";
    case "pre_compaction":
    case "post_compaction_validation":
      return "compaction_projection";
    case "recent_work":
    case "decision":
    case "decision_trace":
    case "event":
      return "history_change";
    case "workflow_posture":
      return "workflow_posture";
    case "architecture":
    case "schema":
      return "reference_architecture";
    case "preference":
    case "entity":
    case "debugging":
    case "exploratory_topic":
    case "exact_lookup":
    case "unknown_mixed":
    case "fact":
    default:
      return "general_recall";
  }
}

function resolveBudgetsForPath(
  retrievalPath: RetrievalPathKind,
  topK: number,
): RetrievalRecipeSourceBudget[] {
  const hybridLegBudget = Math.max(1, topK * 3);
  switch (retrievalPath) {
    case "deterministic":
      return [
        { source: "project_state", budget: 1 },
        { source: "continuity_memory", budget: CONTINUITY_BUDGET },
      ];
    case "latest_state":
      return [
        { source: "vector", budget: hybridLegBudget },
        { source: "bm25", budget: hybridLegBudget },
        { source: "recency", budget: hybridLegBudget },
        { source: "entity", budget: Math.min(50, hybridLegBudget) },
        { source: "latest_state_representatives", budget: Math.max(1, topK) },
      ];
    case "hybrid":
    default:
      return [
        { source: "vector", budget: hybridLegBudget },
        { source: "bm25", budget: hybridLegBudget },
        { source: "recency", budget: hybridLegBudget },
        { source: "entity", budget: Math.min(50, hybridLegBudget) },
      ];
  }
}

function normalizeSourceCounts(
  budgets: RetrievalRecipeSourceBudget[],
  sourceCounts?: Partial<Record<RetrievalRecipeSourceName, number>>,
): RetrievalRecipeSourceCount[] {
  return budgets.map(({ source }) => ({
    source,
    count: sourceCounts?.[source] ?? 0,
  }));
}

export function getRecipeRegistry(): RetrievalRecipeDefinition[] {
  return Object.values(RECIPE_REGISTRY).map(cloneRecipe);
}

export function getRecipeById(id: RetrievalRecipeId): RetrievalRecipeDefinition {
  return cloneRecipe(RECIPE_REGISTRY[id]);
}

export function resolveRecipeForIntent(intentLabel: QueryIntent): RetrievalRecipeDefinition {
  return getRecipeById(resolveRecipeIdForIntent(intentLabel));
}

export function buildRecipeTraceMetadata(args: {
  recipe: RetrievalRecipeDefinition;
  policy: RetrievalPolicy;
  retrievalPath: RetrievalPathKind;
  topK: number;
  sourceCounts?: Partial<Record<RetrievalRecipeSourceName, number>>;
}): RetrievalRecipeTraceMetadata {
  const sourceBudgets = resolveBudgetsForPath(args.retrievalPath, args.topK);
  return {
    id: args.recipe.id,
    version: args.recipe.version,
    relationExpansionEnabled: args.recipe.relationExpansionEnabled,
    latestStateShaping: args.retrievalPath === "deterministic"
      ? "deterministic_continuity"
      : args.policy.useLatestStateResolution || args.retrievalPath === "latest_state"
        ? "latest_state_lane"
        : "off",
    selectorProfile: args.policy.selectorProfile,
    admissibilityContractId: args.policy.admissibilityContract?.id,
    admissibilityContractVersion: args.policy.admissibilityContract?.version,
    rrfWeights: args.policy.rrfWeights,
    recencyWindowHours: args.policy.recencyWindowHours,
    sourceBudgets,
    sourceCounts: normalizeSourceCounts(sourceBudgets, args.sourceCounts),
  };
}
