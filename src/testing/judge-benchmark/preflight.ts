import {
  headlineGold,
  JEV_PLANNING_USD_PER_MILLION,
  JUDGE_PLANNING_USD_PER_MILLION,
  type FrozenCandidate,
} from "./candidates.js";
import {
  JUDGE_BENCHMARK_SCHEMA_VERSION,
  REQUESTY_DECISIONS_BASE_URL,
  type LoadedPair,
  type PreflightDisclosure,
} from "./types.js";

export function pairTokens(oldText: string, newText: string, candidate: FrozenCandidate): number {
  const extra = candidate.family === "judge" ? 450 : 250;
  return Math.ceil((oldText.length + newText.length) / 4) + 30 + extra;
}

export function usdPerMillion(candidate: FrozenCandidate): number {
  return candidate.family === "judge" ? JUDGE_PLANNING_USD_PER_MILLION : JEV_PLANNING_USD_PER_MILLION;
}

export function isCallable(item: LoadedPair): boolean {
  return !item.caseError && item.oldText !== null && item.newText !== null;
}

export function isProbeEligible(item: LoadedPair): boolean {
  return isCallable(item) && headlineGold(item.pair) === "supersede";
}

export function callablePairs(pairs: readonly LoadedPair[]): LoadedPair[] {
  return pairs.filter(isCallable);
}

export function probeCount(pairs: readonly LoadedPair[], probe: boolean): number {
  if (!probe) return 0;
  return pairs.filter(isProbeEligible).length;
}

export function plannedRequestCount(pairs: readonly LoadedPair[], probe: boolean): number {
  return callablePairs(pairs).length + probeCount(pairs, probe);
}

/** Live calls retry up to this many attempts. The cost cap reserves all of them. */
export const PROVIDER_ATTEMPT_LIMIT = 3;

export function estimatePairUsd(oldText: string, newText: string, candidate: FrozenCandidate): number {
  return (pairTokens(oldText, newText, candidate) * usdPerMillion(candidate)) / 1_000_000;
}

/**
 * Worst case for one provider call: the max input-token estimate times price,
 * plus the same amount again for every retry that might still be billed.
 */
export function worstCaseReservationUsd(oldText: string, newText: string, candidate: FrozenCandidate): number {
  return estimatePairUsd(oldText, newText, candidate) * PROVIDER_ATTEMPT_LIMIT;
}

export function estimateUpperUsd(pairs: readonly LoadedPair[], candidate: FrozenCandidate, probe: boolean): number {
  let total = 0;
  for (const item of callablePairs(pairs)) {
    const reserve = worstCaseReservationUsd(item.oldText ?? "", item.newText ?? "", candidate);
    total += reserve;
    if (probe && isProbeEligible(item)) total += reserve;
  }
  return total;
}

export function buildPreflight(args: {
  datasetId: string;
  candidate: FrozenCandidate;
  pairs: readonly LoadedPair[];
  probe: "none" | "order-swap";
  concurrency: number;
  maxTotalCostUsd: number | null;
  git: { sha: string; dirty: boolean };
  fixtureContentHash: string;
  textSnapshotHash: string;
  dryRun: boolean;
  replayOnly: boolean;
  testRowsExcluded: number;
  testSplitNote: string;
}): PreflightDisclosure {
  const probeOn = args.probe === "order-swap";
  return {
    schemaVersion: JUDGE_BENCHMARK_SCHEMA_VERSION,
    command: "run",
    datasetId: args.datasetId,
    candidateId: args.candidate.id,
    candidateConfigHash: args.candidate.candidateConfigHash,
    modelId: args.candidate.modelId,
    pairs: args.pairs.length,
    caseErrors: args.pairs.filter((pair) => pair.caseError).length,
    plannedRequestCount: plannedRequestCount(args.pairs, probeOn),
    dryRun: args.dryRun,
    replayOnly: args.replayOnly,
    concurrency: args.concurrency,
    maxTotalCostUsd: args.maxTotalCostUsd,
    estimatedCostUsdUpper: args.replayOnly ? 0 : estimateUpperUsd(args.pairs, args.candidate, probeOn),
    gatewayBaseUrl: REQUESTY_DECISIONS_BASE_URL,
    credentialSource: "REQUESTY_API_KEY (value never logged)",
    probe: args.probe,
    git: args.git,
    fixtureContentHash: args.fixtureContentHash,
    textSnapshotHash: args.textSnapshotHash,
    networkCalls: 0,
    testRowsExcluded: args.testRowsExcluded,
    testSplitNote: args.testSplitNote,
  };
}

export function formatPreflightLine(disclosure: PreflightDisclosure): string {
  const cap = disclosure.maxTotalCostUsd === null ? "none" : `$${disclosure.maxTotalCostUsd}`;
  const requests = `Planned requests: ${disclosure.plannedRequestCount}. Cost cap: ${cap}. ${disclosure.testSplitNote}`;
  if (disclosure.replayOnly) return `Judge benchmark replay-only. ${requests} Network calls: 0.`;
  if (disclosure.dryRun) return `Judge benchmark dry run. ${requests} Network calls: 0.`;
  return `Judge benchmark paid run. ${requests}`;
}
