import type { JudgeBenchmarkRow, JudgeMetricGroup, JudgeRunManifest, JudgeScoreReport } from "./types.js";

export type ReportProjection = {
  pairId: string;
  gold: string;
  decision: string;
  retireScore: number | null;
  latencyMs: number;
  billedCostUsd: number | null;
  estimatedCostUsd: number | null;
  errorClass: string | null;
  httpStatus: number | null;
};

/** Allowlist: ids, gold, decision, scores, latency, cost, error class, HTTP status. */
export function projectRow(row: JudgeBenchmarkRow): ReportProjection {
  return {
    pairId: row.pairId,
    gold: row.gold.label,
    decision: row.decision,
    retireScore: row.retireScore,
    latencyMs: row.latencyMs,
    billedCostUsd: row.billedCostUsd,
    estimatedCostUsd: row.estimatedCostUsd,
    errorClass: row.errorClass ?? null,
    httpStatus: row.httpStatus ?? null,
  };
}

function num(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return "–";
  return value.toFixed(digits);
}

function groupTable(group: JudgeMetricGroup): string {
  const lines = [
    `### ${group.id}`,
    "",
    "| metric | value |",
    "| --- | --- |",
    `| n | ${group.n} |`,
    `| gate | ${group.gate} |`,
    `| harmful | ${group.harmful}/${group.n} |`,
    `| wrongRetire | ${group.wrongRetire} |`,
    `| wrongSkip | ${group.wrongSkip} |`,
    `| wilson95Upper | ${num(group.wilson95Upper)} |`,
    `| updateRecall | ${num(group.updateRecall)} (${group.updateLanded}/${group.supersedeN}) |`,
    `| duplicateRecall | ${num(group.duplicateRecall)} |`,
    `| duplicateAsDuplicate | ${group.duplicateAsDuplicate} |`,
    `| duplicateAsRetire | ${group.duplicateAsRetire} |`,
    `| correctionDropped | ${group.correctionDropped} |`,
    `| missedUpdate | ${group.missedUpdate} |`,
    `| auroc | ${num(group.auroc, 3)} |`,
    `| ece | ${num(group.ece, 4)} |`,
    `| directionErrors | ${group.directionErrors}/${group.directionProbes} |`,
    `| errorRate | ${num(group.errorRate)} (${group.errorCount}) |`,
    `| latency p50/p95 ms | ${num(group.latencyP50Ms, 1)} / ${num(group.latencyP95Ms, 1)} |`,
    `| cost p50/p95/total usd | ${num(group.costP50Usd)} / ${num(group.costP95Usd)} / ${num(group.costTotalUsd)} |`,
    "",
  ];
  return lines.join("\n");
}

export function renderJudgeReport(args: {
  datasetId: string;
  candidateId: string;
  manifest: JudgeRunManifest | null;
  score: JudgeScoreReport;
  rows: readonly JudgeBenchmarkRow[];
  note?: string;
}): string {
  const header = [
    `# Judge benchmark — ${args.datasetId} / ${args.candidateId}`,
    "",
    ...(args.note ? [args.note, ""] : []),
    args.manifest
      ? [
          `- schema: ${args.manifest.schemaVersion}`,
          `- scoring: ${args.manifest.scoringContractVersion}`,
          `- run: ${args.manifest.runId}`,
          `- git: ${args.manifest.git.sha}${args.manifest.git.dirty ? " (dirty)" : ""}`,
          `- fixture: ${args.manifest.fixtureContentHash}`,
          `- text snapshot: ${args.manifest.textSnapshotHash}`,
          `- candidate config: ${args.manifest.candidateConfigHashes.join(", ")}`,
          `- threshold: ${args.manifest.threshold} (${args.manifest.thresholdSource})`,
          `- probe: ${args.manifest.probe}`,
          `- completion: ${args.manifest.completion.status} cost ${args.manifest.completion.cumulativeCostUsd}`,
        ].join("\n")
      : "- manifest: unavailable",
    "",
    "Legacy and non-test intervals are descriptive. The pass/fail gate applies only to the probability-sample test split.",
    "Controls stay out of the headline denominator. Groups with n < 35 are underpowered.",
    "",
  ];
  const forward = args.rows.filter((row) => row.direction === "forward");
  const projected = forward.map(projectRow);
  const caseHeader = "| pairId | gold | decision | retireScore | latencyMs | billedCostUsd | estimatedCostUsd | errorClass | httpStatus |";
  const caseRows = projected.map((row) =>
    `| ${row.pairId} | ${row.gold} | ${row.decision} | ${row.retireScore ?? "–"} | ${row.latencyMs} | ${row.billedCostUsd ?? "–"} | ${row.estimatedCostUsd ?? "–"} | ${row.errorClass ?? "–"} | ${row.httpStatus ?? "–"} |`,
  );
  return [
    ...header,
    ...args.score.groups.map(groupTable),
    "## Cases",
    "",
    caseHeader,
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...caseRows,
    "",
  ].join("\n");
}
