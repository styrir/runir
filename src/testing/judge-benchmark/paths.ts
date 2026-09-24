export function labelsPathFor(datasetId: string): string {
  return `fixtures/judge-benchmark/${datasetId}.labels.json`;
}

export function textsPathFor(datasetId: string): string {
  return `.styrir/analysis/judge-benchmark/texts/${datasetId}.jsonl`;
}

export function cassettePathFor(candidateId: string): string {
  return `.styrir/analysis/judge-benchmark/cassettes/${candidateId}.jsonl`;
}

export function ledgerPath(): string {
  return ".styrir/analysis/judge-benchmark/test-unlock-ledger.jsonl";
}

export function thresholdsPathFor(datasetId: string, candidateId: string): string {
  return `.styrir/analysis/judge-benchmark/thresholds/${datasetId}-${candidateId}.json`;
}

export function rawPathFor(runId: string): string {
  return `.styrir/analysis/raw/judge-benchmark-${runId}.jsonl`;
}

export function reportPathFor(runId: string): string {
  return `.styrir/analysis/reports/judge-benchmark-${runId}.md`;
}

export function manifestPathFor(rawPath: string): string {
  return rawPath.endsWith(".jsonl")
    ? rawPath.replace(/\.jsonl$/u, ".manifest.json")
    : `${rawPath}.manifest.json`;
}
