import type { AggregateMetrics, ResultRow } from "./types.js";

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const w = rank - lo;
  return sortedAsc[lo]! * (1 - w) + sortedAsc[hi]! * w;
}

export function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function aggregateByCandidate(rows: ResultRow[]): AggregateMetrics[] {
  const groups = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const list = groups.get(r.candidateId) ?? [];
    list.push(r);
    groups.set(r.candidateId, list);
  }

  const out: AggregateMetrics[] = [];
  for (const [candidateId, group] of groups) {
    const latencies = group.map((r) => r.latencyMs).sort((a, b) => a - b);
    const schemaValidRate = group.filter((r) => r.quality.schemaValid).length / group.length;
    const precisions = group
      .map((r) => r.quality.atomicPrecision)
      .filter((x): x is number => x !== null);
    const recalls = group
      .map((r) => r.quality.atomicRecall)
      .filter((x): x is number => x !== null);
    const halls = group
      .map((r) => r.quality.hallucinationRate)
      .filter((x): x is number => x !== null);
    const omissions = group
      .map((r) => r.quality.omissionRate)
      .filter((x): x is number => x !== null);
    const abstainRows = group.filter((r) => r.quality.abstentionCorrect !== null);
    const abstentionAccuracy =
      abstainRows.length === 0
        ? null
        : abstainRows.filter((r) => r.quality.abstentionCorrect).length / abstainRows.length;

    const completed = group.filter((r) => !r.errorClass);
    const firstOk = group.filter((r) => !r.errorClass && r.retryCount === 0);
    const timeouts = group.filter((r) => r.errorClass === "timeout");
    const outTokens = group
      .map((r) => r.usage.completionTokens)
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b);
    const costs = group
      .map((r) => r.billedCostUsd ?? r.estimatedCostUsd)
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0);

    const correctGold = group.reduce((acc, r) => acc + r.quality.matchedGoldIds.length, 0);
    const totalCost = costs.reduce((a, b) => a + b, 0);
    const meanCost = mean(costs);

    out.push({
      candidateId,
      label: group[0]!.candidateLabel,
      modelId: group[0]!.modelId,
      n: group.length,
      schemaValidRate,
      meanAtomicPrecision: mean(precisions),
      meanAtomicRecall: mean(recalls),
      meanHallucinationRate: mean(halls),
      meanOmissionRate: mean(omissions),
      abstentionAccuracy,
      latency: {
        p50: percentile(latencies, 50),
        p90: percentile(latencies, 90),
        p95: percentile(latencies, 95),
        mean: mean(latencies) ?? 0,
        min: latencies[0] ?? 0,
        max: latencies[latencies.length - 1] ?? 0,
      },
      validCompletionRate: completed.length / group.length,
      firstAttemptSuccessRate: firstOk.length / group.length,
      timeoutRate: timeouts.length / group.length,
      meanOutputTokens: mean(outTokens),
      p95OutputTokens: outTokens.length ? percentile(outTokens, 95) : null,
      meanCostPerExtraction: meanCost,
      projectedCostPer1000Turns: meanCost === null ? null : meanCost * 1000,
      costPerCorrectGoldFact: correctGold > 0 && costs.length ? totalCost / correctGold : null,
    });
  }

  return out.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}

export function estimateCostUsd(args: {
  promptTokens?: number;
  completionTokens?: number;
  price?: { input: number; output: number };
}): number | null {
  if (!args.price) return null;
  const pin = args.promptTokens ?? 0;
  const pout = args.completionTokens ?? 0;
  if (pin === 0 && pout === 0) return null;
  return (pin / 1_000_000) * args.price.input + (pout / 1_000_000) * args.price.output;
}

export function cumulativeCostUsd(rows: readonly ResultRow[]): number {
  return rows.reduce((sum, row) => {
    const billed = row.billedCostUsd;
    if (typeof billed === "number" && Number.isFinite(billed) && billed >= 0) {
      return sum + billed;
    }
    const estimated = row.estimatedCostUsd;
    return typeof estimated === "number" && Number.isFinite(estimated) && estimated >= 0
      ? sum + estimated
      : sum;
  }, 0);
}

export function plannedRequestCount(args: {
  candidateCount: number;
  caseCount: number;
  repetitions: number;
}): number {
  return args.candidateCount * args.caseCount * args.repetitions;
}
