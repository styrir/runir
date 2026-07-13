import { createHash } from "node:crypto";
import type { SearchHit } from "../../domain/memory/types.js";
import type {
  HexisGateDecision,
  RetrievalCalibrationCandidate,
  RetrievalCalibrationTelemetry,
  RetrievalPolicy,
  RrfWeights,
} from "./policy-types.js";

const DEFAULT_RRF_K = 60;
const DEFAULT_RRF_WEIGHTS: RrfWeights = {
  vector: 1,
  bm25: 1.2,
  recency: 0.8,
};

export function stableCalibrationIdHash(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roundMetric(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number(value.toFixed(6));
}

function buildCandidate(hit: SearchHit, index: number): RetrievalCalibrationCandidate {
  const stableId = typeof hit.id === "string" && hit.id.length > 0 ? hit.id : `rank:${index + 1}`;
  const candidate: RetrievalCalibrationCandidate = {
    rank: index + 1,
    idHash: stableCalibrationIdHash(stableId),
    score: roundMetric(hit.score) ?? 0,
  };

  if (hit.scoreStages?.rrf) {
    candidate.rrf = {
      score: roundMetric(finiteNumber(hit.scoreStages.rrf.score)),
      vectorRank: hit.scoreStages.rrf.vectorRank,
      bm25Rank: hit.scoreStages.rrf.bm25Rank,
      recencyRank: hit.scoreStages.rrf.recencyRank,
    };
  }

  const hexis = {
    preScore: roundMetric(finiteNumber(hit.preHexisScore)),
    postScore: roundMetric(finiteNumber(hit.postHexisScore)),
    poolRank: hit.poolRank,
    boundaryGap: roundMetric(finiteNumber(hit.boundaryGap)),
    gateValue: roundMetric(finiteNumber(hit.gateValue)),
    hexisMode: hit.hexisMode,
    laneLambda: roundMetric(finiteNumber(hit.laneLambda)),
  };
  if (Object.values(hexis).some((value) => value !== undefined)) {
    candidate.hexis = hexis;
  }

  return candidate;
}

export function buildRetrievalCalibrationTelemetry(input: {
  policy: RetrievalPolicy;
  candidatePool: readonly SearchHit[];
  gate: HexisGateDecision;
  safeLimit: number;
  recallLatencyMs: number;
  emittedContextSize: number;
  rrfK?: number;
  rrfWeights?: RrfWeights;
}): RetrievalCalibrationTelemetry {
  const sorted = [...input.candidatePool].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 3);
  const top2Gap = top.length >= 2 ? Math.max(0, top[0].score - top[1].score) : undefined;
  const top3Gap = top.length >= 3 ? Math.max(0, top[0].score - top[2].score) : undefined;
  const firstHexisMode = top.map((hit) => hit.hexisMode).find((mode): mode is number => typeof mode === "number");

  return {
    lane: input.policy.lane,
    rrfK: input.rrfK ?? DEFAULT_RRF_K,
    rrfWeights: input.rrfWeights ?? input.policy.rrfWeights ?? DEFAULT_RRF_WEIGHTS,
    safeLimit: input.safeLimit,
    reorderWindow: input.policy.hexis.reorderWindow,
    topCandidates: top.map(buildCandidate),
    top2Gap: roundMetric(top2Gap),
    top3Gap: roundMetric(top3Gap),
    hexis: {
      triggered: input.gate.enabled,
      reason: input.gate.reason,
      effectiveThreshold: input.policy.hexis.ambiguityThreshold,
      lambda: input.policy.hexis.hexisLambda,
      mode: firstHexisMode,
    },
    recallLatencyMs: Math.max(0, Math.round(input.recallLatencyMs)),
    emittedContextSize: Math.max(0, Math.floor(input.emittedContextSize)),
  };
}
