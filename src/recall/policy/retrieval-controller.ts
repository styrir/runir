import { applyHexisToHits, resolveHexisReorderWindow, type HexisState } from "../../hexis/runtime-hexis.js";
import type { IntentSignal } from "../intent/intent-analyzer.js";
import { resolveRecipeForIntent } from "./recipe-registry.js";
import { mapIntentToRecallLane, resolveRetrievalPolicyForLane } from "./retrieval-policy.js";
import type {
  HexisGateDecision,
  HexisPolicyApplication,
  RetrievalControllerResolution,
  RetrievalPolicy,
} from "./policy-types.js";
import type { SearchHit } from "../../domain/memory/types.js";

function sortHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort((a, b) => b.score - a.score);
}

export function resolveRetrievalController(intent: IntentSignal): RetrievalControllerResolution {
  const lane = mapIntentToRecallLane(intent.label);
  return {
    intent,
    policy: resolveRetrievalPolicyForLane(lane),
    recipe: resolveRecipeForIntent(intent.label),
  };
}

export function evaluateHexisGate(hits: SearchHit[], policy: RetrievalPolicy): HexisGateDecision {
  const sorted = sortHits(hits);
  const topScore = sorted[0]?.score ?? 0;
  const secondScore = sorted[1]?.score ?? 0;
  const ambiguityGap = topScore - secondScore;
  const admissibleIds = policy.hexis.enabled
    ? resolveHexisReorderWindow(sorted, {
        maxRankWindow: policy.hexis.reorderWindow,
        scoreEpsilon: policy.hexis.scoreEpsilon,
      })
    : [];

  if (!policy.hexis.enabled) {
    return {
      enabled: false,
      reason: "lane_disabled",
      reorderWindow: 0,
      ambiguityGap,
      admissibleIds,
    };
  }

  if (sorted.length < 2) {
    return {
      enabled: false,
      reason: "insufficient_candidates",
      reorderWindow: policy.hexis.reorderWindow,
      ambiguityGap,
      admissibleIds,
    };
  }

  if (ambiguityGap > policy.hexis.ambiguityThreshold) {
    return {
      enabled: false,
      reason: "top_gap_clear",
      reorderWindow: policy.hexis.reorderWindow,
      ambiguityGap,
      admissibleIds,
    };
  }

  return {
    enabled: true,
    reason: "ambiguous_boundary",
    reorderWindow: policy.hexis.reorderWindow,
    ambiguityGap,
    admissibleIds,
  };
}

export function applyHexisByPolicy(
  hits: SearchHit[],
  hexis: HexisState | null | undefined,
  policy: RetrievalPolicy,
): HexisPolicyApplication {
  if (policy.hexis.hexisLambda === 0) {
    const sorted = sortHits(hits);
    const topScore = sorted[0]?.score ?? 0;
    const secondScore = sorted[1]?.score ?? 0;
    const ambiguityGap = topScore - secondScore;
    const poolRankById = new Map<string, number>();
    sorted.forEach((hit, index) => {
      poolRankById.set(hit.id, index + 1);
    });
    const bypassHits = hits.map((hit) => {
      const { scoreStages, ...rest } = hit;
      const nextScoreStages = scoreStages
        ? Object.fromEntries(Object.entries(scoreStages).filter(([k]) => k !== "hexis"))
        : undefined;
      return {
        ...rest,
        preHexisScore: hit.score,
        postHexisScore: hit.score,
        poolRank: poolRankById.get(hit.id) ?? 0,
        boundaryGap: 0,
        gateValue: 0,
        hexisMode: 1,
        laneLambda: 0,
        ...(nextScoreStages && Object.keys(nextScoreStages).length > 0
          ? { scoreStages: nextScoreStages }
          : {}),
      };
    });
    return {
      hits: bypassHits,
      gate: {
        enabled: false,
        reason: "bypass_lane_lambda",
        reorderWindow: policy.hexis.reorderWindow,
        ambiguityGap,
        admissibleIds: [],
      },
    };
  }

  const gate = evaluateHexisGate(hits, policy);
  if (!hexis || !gate.enabled) {
    return { hits, gate };
  }

  return {
    hits: sortHits(
      applyHexisToHits(sortHits(hits), hexis, {
        maxRankWindow: policy.hexis.reorderWindow,
        scoreEpsilon: policy.hexis.scoreEpsilon,
        lambda: policy.hexis.hexisLambda,
      }),
    ),
    gate,
  };
}
