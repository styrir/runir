import { canonicalHash } from "../model-benchmark/provenance.js";
import { classifyOutcome, decideLane, rowHeadlineGold, type FrozenCandidate } from "./candidates.js";
import { wilsonUpper } from "./metrics.js";
import { isHarmfulOutcome } from "./score.js";
import {
  HARM_WILSON_GATE,
  JUDGE_SCORING_CONTRACT_VERSION,
  type JudgeBenchmarkRow,
  type JudgeSplit,
  type ThresholdFit,
  type ThresholdsFile,
} from "./types.js";

type Candidate = FrozenCandidate;

function observedThresholds(rows: readonly JudgeBenchmarkRow[], fallback: number): number[] {
  const values = new Set<number>([fallback]);
  for (const row of rows) {
    if (row.direction !== "forward") continue;
    if (typeof row.retireScore === "number" && Number.isFinite(row.retireScore) && row.retireScore >= 0 && row.retireScore <= 1) {
      values.add(row.retireScore);
    }
  }
  return [...values].sort((a, b) => a - b);
}

function evaluate(rows: readonly JudgeBenchmarkRow[], candidate: Candidate, threshold: number): {
  harmful: number;
  n: number;
  updateLanded: number;
  supersedeN: number;
  wilson95Upper: number;
} {
  const forward = rows.filter((row) => row.direction === "forward");
  let harmful = 0;
  let updateLanded = 0;
  let supersedeN = 0;
  for (const row of forward) {
    const gold = rowHeadlineGold(row);
    const decision = decideLane(candidate, row.signals, threshold);
    const outcome = classifyOutcome(gold, decision.effectiveDecision);
    if (isHarmfulOutcome(outcome)) harmful += 1;
    if (gold === "supersede") {
      supersedeN += 1;
      if (outcome === "update_landed") updateLanded += 1;
    }
  }
  return {
    harmful,
    n: forward.length,
    updateLanded,
    supersedeN,
    wilson95Upper: wilsonUpper(harmful, forward.length),
  };
}

/**
 * Fit only the retire threshold. Duplicate decisions stay at the lane's fixed
 * floor and count toward harmful at every candidate threshold.
 * Ties on updateRecall go to the highest threshold.
 */
export function fitRetireThreshold(args: {
  rows: readonly JudgeBenchmarkRow[];
  candidate: Candidate;
  thresholds?: readonly number[];
}): ThresholdFit {
  const considered = args.thresholds
    ? [...new Set([args.candidate.defaultThreshold, ...args.thresholds])].sort((a, b) => a - b)
    : observedThresholds(args.rows, args.candidate.defaultThreshold);
  let best: ThresholdFit | null = null;
  for (const threshold of considered) {
    const stats = evaluate(args.rows, args.candidate, threshold);
    if (!(stats.wilson95Upper < HARM_WILSON_GATE)) continue;
    const recall = stats.supersedeN === 0 ? 0 : stats.updateLanded / stats.supersedeN;
    const better = !best
      || stats.updateLanded > best.updateLanded
      || (stats.updateLanded === best.updateLanded && threshold > best.threshold);
    if (!better) continue;
    best = {
      threshold,
      thresholdSource: "fitted",
      defaultThreshold: args.candidate.defaultThreshold,
      updateRecall: stats.supersedeN === 0 ? null : recall,
      updateLanded: stats.updateLanded,
      supersedeN: stats.supersedeN,
      harmful: stats.harmful,
      n: stats.n,
      wilson95Upper: stats.wilson95Upper,
      considered,
    };
  }
  if (best) return best;
  const fallback = evaluate(args.rows, args.candidate, args.candidate.defaultThreshold);
  return {
    threshold: args.candidate.defaultThreshold,
    thresholdSource: "no_qualifying_threshold",
    defaultThreshold: args.candidate.defaultThreshold,
    updateRecall: fallback.supersedeN === 0 ? null : fallback.updateLanded / fallback.supersedeN,
    updateLanded: fallback.updateLanded,
    supersedeN: fallback.supersedeN,
    harmful: fallback.harmful,
    n: fallback.n,
    wilson95Upper: fallback.wilson95Upper,
    considered,
  };
}

export function sealThresholds(args: {
  datasetId: string;
  candidate: Candidate;
  split: JudgeSplit;
  fit: ThresholdFit;
}): ThresholdsFile {
  const body = {
    schemaVersion: JUDGE_SCORING_CONTRACT_VERSION,
    datasetId: args.datasetId,
    candidateId: args.candidate.id,
    candidateConfigHash: args.candidate.candidateConfigHash,
    split: args.split,
    threshold: args.fit.threshold,
    thresholdSource: args.fit.thresholdSource,
    defaultThreshold: args.fit.defaultThreshold,
    updateRecall: args.fit.updateRecall,
    harmful: args.fit.harmful,
    n: args.fit.n,
    wilson95Upper: args.fit.wilson95Upper,
  } satisfies Omit<ThresholdsFile, "thresholdsHash">;
  return { ...body, thresholdsHash: canonicalHash(body) };
}

export function readThresholds(value: unknown): ThresholdsFile {
  if (typeof value !== "object" || value === null) throw new Error("thresholds file must be an object");
  const record = value as ThresholdsFile;
  if (typeof record.thresholdsHash !== "string") throw new Error("thresholds file is missing thresholdsHash");
  const { thresholdsHash, ...body } = record;
  const actual = canonicalHash(body);
  if (actual !== thresholdsHash) {
    throw new Error(`thresholds hash mismatch: file ${thresholdsHash} actual ${actual}`);
  }
  return record;
}
