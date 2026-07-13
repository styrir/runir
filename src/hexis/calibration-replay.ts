import type { SearchHit } from "../domain/memory/types.js";
import type { HexisState } from "./runtime-hexis.js";
import { applyHexisByPolicy } from "../recall/policy/retrieval-controller.js";
import type { RetrievalPolicy, RrfWeights } from "../recall/policy/policy-types.js";
import {
  boundaryFlipRate,
  ndcgAt5,
  stalePickRate,
  top1CurrentStateAccuracy,
  type RelevanceScore,
} from "./harness-metrics.js";

const DEFAULT_RRF_K = 60;

export interface CalibrationReplayCase {
  id: string;
  hits: SearchHit[];
  policy: RetrievalPolicy;
  hexis?: HexisState | null;
  relevance?: Record<string, number>;
  expectedCurrentId?: string;
  staleIds?: string[];
  topK?: number;
}

export interface CalibrationReplayVariant {
  id: string;
  rrfK?: number;
  rrfWeights?: RrfWeights;
  hexis?: Partial<RetrievalPolicy["hexis"]>;
}

export interface CalibrationReplayCaseResult {
  caseId: string;
  variantId: string;
  topIds: string[];
  hexisTriggered: boolean;
  hexisReason: string;
  ndcgAt5: number;
  top1CurrentStateAccuracy: number;
  stalePickRate: number;
  boundaryFlipRate: number;
}

export interface CalibrationReplaySummary {
  variantId: string;
  caseCount: number;
  hexisInvocationRate: number;
  ndcgAt5: number;
  top1CurrentStateAccuracy: number;
  stalePickRate: number;
  boundaryFlipRate: number;
}

export interface CalibrationReplayReport {
  cases: CalibrationReplayCaseResult[];
  summary: CalibrationReplaySummary[];
}

function scoreByRrfRanks(hit: SearchHit, rrfK: number, weights: RrfWeights): number {
  const rrf = hit.scoreStages?.rrf;
  if (!rrf) return hit.score;
  let score = 0;
  if (rrf.vectorRank !== undefined) score += weights.vector / (rrfK + rrf.vectorRank);
  if (rrf.bm25Rank !== undefined) score += weights.bm25 / (rrfK + rrf.bm25Rank);
  if (rrf.recencyRank !== undefined) score += weights.recency / (rrfK + rrf.recencyRank);
  return score;
}

function applyVariant(caseInput: CalibrationReplayCase, variant: CalibrationReplayVariant): {
  policy: RetrievalPolicy;
  hits: SearchHit[];
} {
  const weights = variant.rrfWeights ?? caseInput.policy.rrfWeights ?? { vector: 1, bm25: 1.2, recency: 0.8 };
  const rrfK = variant.rrfK ?? DEFAULT_RRF_K;
  const policy: RetrievalPolicy = {
    ...caseInput.policy,
    rrfWeights: weights,
    hexis: {
      ...caseInput.policy.hexis,
      ...(variant.hexis ?? {}),
    },
  };
  const hits = caseInput.hits
    .map((hit) => ({
      ...hit,
      score: scoreByRrfRanks(hit, rrfK, weights),
    }))
    .sort((a, b) => b.score - a.score);
  return { policy, hits };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rankingWithRelevance(ids: readonly string[], relevance: Record<string, number> | undefined): RelevanceScore[] {
  return ids.map((id) => ({ id, relevance: relevance?.[id] ?? 0 }));
}

export function runCalibrationReplay(
  cases: readonly CalibrationReplayCase[],
  variants: readonly CalibrationReplayVariant[],
): CalibrationReplayReport {
  const results: CalibrationReplayCaseResult[] = [];
  const baselineVariant = variants[0] ?? { id: "baseline" };

  for (const replayCase of cases) {
    const baseline = applyVariant(replayCase, baselineVariant);
    const baselineTopIds = applyHexisByPolicy(baseline.hits, replayCase.hexis, baseline.policy).hits
      .map((hit) => hit.id)
      .slice(0, replayCase.topK ?? 5);

    for (const variant of variants) {
      const { policy, hits } = applyVariant(replayCase, variant);
      const applied = applyHexisByPolicy(hits, replayCase.hexis, policy);
      const topIds = applied.hits.map((hit) => hit.id).slice(0, replayCase.topK ?? 5);
      const top1Id = topIds[0] ?? "";

      results.push({
        caseId: replayCase.id,
        variantId: variant.id,
        topIds,
        hexisTriggered: applied.gate.enabled,
        hexisReason: applied.gate.reason,
        ndcgAt5: ndcgAt5(rankingWithRelevance(topIds, replayCase.relevance)),
        top1CurrentStateAccuracy: replayCase.expectedCurrentId
          ? top1CurrentStateAccuracy([{ expectedCurrentId: replayCase.expectedCurrentId, top1Id }])
          : 0,
        stalePickRate: replayCase.staleIds
          ? stalePickRate([{ top1Id, staleIds: replayCase.staleIds }])
          : 0,
        boundaryFlipRate: boundaryFlipRate(baselineTopIds, topIds, policy.hexis.reorderWindow || (replayCase.topK ?? 5)),
      });
    }
  }

  const summary = variants.map((variant) => {
    const variantResults = results.filter((result) => result.variantId === variant.id);
    return {
      variantId: variant.id,
      caseCount: variantResults.length,
      hexisInvocationRate: average(variantResults.map((result) => result.hexisTriggered ? 1 : 0)),
      ndcgAt5: average(variantResults.map((result) => result.ndcgAt5)),
      top1CurrentStateAccuracy: average(variantResults.map((result) => result.top1CurrentStateAccuracy)),
      stalePickRate: average(variantResults.map((result) => result.stalePickRate)),
      boundaryFlipRate: average(variantResults.map((result) => result.boundaryFlipRate)),
    };
  });

  return { cases: results, summary };
}
