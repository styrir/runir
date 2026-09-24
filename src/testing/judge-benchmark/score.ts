import { classifyOutcome, decideLane, rowHeadlineGold, type FrozenCandidate } from "./candidates.js";
import { auroc, expectedCalibrationError, percentile, wilsonUpper } from "./metrics.js";
import {
  HARM_WILSON_GATE,
  INVALID_ERROR_RATE,
  JUDGE_SCORING_CONTRACT_VERSION,
  UNDERPOWERED_N,
  type GateStatus,
  type GoldLabel,
  type JudgeBenchmarkRow,
  type JudgeMetricGroup,
  type JudgeScoreReport,
  type OutcomeId,
} from "./types.js";

const HARMFUL: ReadonlySet<OutcomeId> = new Set(["wrong_retirement", "wrong_skip"]);

export type ScoreMode = "legacy" | "descriptive" | "gated";

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return part / whole;
}

function rowCost(row: JudgeBenchmarkRow): number | null {
  if (typeof row.billedCostUsd === "number" && Number.isFinite(row.billedCostUsd)) return row.billedCostUsd;
  if (typeof row.estimatedCostUsd === "number" && Number.isFinite(row.estimatedCostUsd)) return row.estimatedCostUsd;
  return null;
}

function goldOf(row: JudgeBenchmarkRow, which: "headline" | "strict" | "label"): GoldLabel | null {
  if (which === "strict") return row.gold.strict;
  if (which === "headline") return rowHeadlineGold(row);
  return row.gold.label;
}

function emptyGroup(id: string, gate: GateStatus): JudgeMetricGroup {
  return {
    id,
    n: 0,
    underpowered: true,
    harmful: 0,
    wrongRetire: 0,
    wrongSkip: 0,
    harmfulRate: null,
    wilson95Upper: null,
    updateRecall: null,
    supersedeN: 0,
    updateLanded: 0,
    duplicateRecall: null,
    duplicateGoldN: 0,
    duplicateAsDuplicate: 0,
    duplicateAsRetire: 0,
    correctionDropped: 0,
    missedUpdate: 0,
    auroc: null,
    ece: null,
    directionErrors: 0,
    directionProbes: 0,
    errorCount: 0,
    errorRate: null,
    latencyP50Ms: null,
    latencyP95Ms: null,
    costP50Usd: null,
    costP95Usd: null,
    costTotalUsd: 0,
    gate,
  };
}

function measure(
  id: string,
  rows: readonly JudgeBenchmarkRow[],
  which: "headline" | "strict" | "label",
  frame: "exclude-control" | "control-only" | "all",
  mode: ScoreMode,
): JudgeMetricGroup {
  const forward = rows.filter((row) => {
    if (row.direction !== "forward") return false;
    if (frame === "control-only") return row.frame === "control";
    if (frame === "exclude-control") return row.frame !== "control";
    return true;
  });
  const scored = forward.filter((row) => goldOf(row, which) !== null);
  if (scored.length === 0 && forward.length === 0) {
    return emptyGroup(id, mode === "gated" ? "underpowered" : "descriptive");
  }
  let harmful = 0;
  let wrongRetire = 0;
  let wrongSkip = 0;
  let supersedeN = 0;
  let updateLanded = 0;
  let duplicateGoldN = 0;
  let duplicateAsDuplicate = 0;
  let duplicateAsRetire = 0;
  let correctionDropped = 0;
  let missedUpdate = 0;
  let errorCount = 0;
  const positive: number[] = [];
  const negative: number[] = [];
  const eceScores: number[] = [];
  const eceLabels: (0 | 1)[] = [];
  const latencies: number[] = [];
  const costs: number[] = [];
  for (const row of scored) {
    const gold = goldOf(row, which);
    if (!gold) continue;
    if (row.decision === "error") errorCount += 1;
    const outcome = classifyOutcome(gold, row.effectiveDecision);
    if (outcome === "wrong_retirement") {
      harmful += 1;
      wrongRetire += 1;
    } else if (outcome === "wrong_skip") {
      harmful += 1;
      wrongSkip += 1;
    }
    if (gold === "supersede") {
      supersedeN += 1;
      if (outcome === "update_landed") updateLanded += 1;
      if (outcome === "correction_dropped") correctionDropped += 1;
      if (outcome === "missed_update") missedUpdate += 1;
    }
    if (gold === "duplicate") {
      duplicateGoldN += 1;
      if (outcome === "duplicate_as_duplicate") duplicateAsDuplicate += 1;
      if (outcome === "duplicate_as_retire") duplicateAsRetire += 1;
    }
    if (row.retireScore !== null && Number.isFinite(row.retireScore) && (gold === "supersede" || gold === "independent")) {
      if (gold === "supersede") positive.push(row.retireScore);
      else negative.push(row.retireScore);
      eceScores.push(row.retireScore);
      eceLabels.push(gold === "supersede" ? 1 : 0);
    }
    if (Number.isFinite(row.latencyMs)) latencies.push(row.latencyMs);
    const cost = rowCost(row);
    if (cost !== null) costs.push(cost);
  }
  const probes = rows.filter((row) => {
    if (row.direction !== "swapped") return false;
    if (frame === "control-only") return row.frame === "control";
    if (frame === "exclude-control") return row.frame !== "control";
    return true;
  });
  const directionProbes = probes.filter((row) => rowHeadlineGold(row) === "supersede");
  const directionErrors = directionProbes.filter((row) => row.effectiveDecision === "retire").length;
  const n = scored.length;
  const underpowered = n < UNDERPOWERED_N;
  const errorRate = rate(errorCount, n);
  let gate: GateStatus;
  if (mode === "gated") {
    if (errorRate !== null && errorRate > INVALID_ERROR_RATE) gate = "invalid";
    else if (underpowered) gate = "underpowered";
    else gate = wilsonUpper(harmful, n) < HARM_WILSON_GATE ? "pass" : "fail";
  } else if (underpowered) {
    gate = "underpowered";
  } else {
    gate = "descriptive";
  }
  return {
    id,
    n,
    underpowered,
    harmful,
    wrongRetire,
    wrongSkip,
    harmfulRate: rate(harmful, n),
    wilson95Upper: n === 0 ? null : wilsonUpper(harmful, n),
    updateRecall: rate(updateLanded, supersedeN),
    supersedeN,
    updateLanded,
    duplicateRecall: rate(duplicateAsDuplicate + duplicateAsRetire, duplicateGoldN),
    duplicateGoldN,
    duplicateAsDuplicate,
    duplicateAsRetire,
    correctionDropped,
    missedUpdate,
    auroc: auroc(positive, negative),
    ece: expectedCalibrationError(eceScores, eceLabels),
    directionErrors,
    directionProbes: directionProbes.length,
    errorCount,
    errorRate,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    costP50Usd: percentile(costs, 50),
    costP95Usd: percentile(costs, 95),
    costTotalUsd: costs.reduce((sum, value) => sum + value, 0),
    gate,
  };
}

export function scoreJudgeRows(rows: readonly JudgeBenchmarkRow[], mode: ScoreMode): JudgeScoreReport {
  if (mode === "legacy") {
    return {
      schemaVersion: JUDGE_SCORING_CONTRACT_VERSION,
      groups: [
        measure("headline", rows, "headline", "exclude-control", "legacy"),
        measure("strict", rows, "strict", "exclude-control", "legacy"),
        measure("control", rows, "headline", "control-only", "legacy"),
      ],
    };
  }
  if (mode === "gated") {
    const probability = rows.filter((row) => row.population === "probability");
    const challenge = rows.filter((row) => row.population === "challenge");
    const groups = [measure("probability-test", probability, "label", "all", "gated")];
    if (challenge.length > 0) groups.push(measure("challenge", challenge, "label", "all", "descriptive"));
    return { schemaVersion: JUDGE_SCORING_CONTRACT_VERSION, groups };
  }
  return {
    schemaVersion: JUDGE_SCORING_CONTRACT_VERSION,
    groups: [measure("scored", rows, "label", "all", "descriptive")],
  };
}

export function isHarmfulOutcome(outcome: OutcomeId): boolean {
  return HARMFUL.has(outcome);
}

/** Re-apply a retire threshold to stored signals. Case errors (no signals) stay errors. */
export function rescoreRow(
  row: JudgeBenchmarkRow,
  candidate: FrozenCandidate,
  threshold: number,
): JudgeBenchmarkRow {
  const decision = decideLane(candidate, row.signals, threshold);
  const gold = rowHeadlineGold(row);
  return {
    ...row,
    decision: decision.decision,
    effectiveDecision: decision.effectiveDecision,
    retireScore: decision.retireScore,
    outcome: classifyOutcome(gold, decision.effectiveDecision),
  };
}
