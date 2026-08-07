import type { AggregateMetrics, PreflightDisclosure, ResultRow, RunManifest } from "./types.js";
import { aggregateByCandidate } from "./metrics.js";

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function planningEstimateUsd(d: PreflightDisclosure): number | null {
  return (
    finiteNumberOrNull(d.costEstimate.estimatedTotalUsd) ??
    finiteNumberOrNull(d.costEstimate.conservativeTotalUsd)
  );
}

function runtimeCostCapUsd(d: PreflightDisclosure): number | null {
  return finiteNumberOrNull(d.costEstimate.maxTotalCostUsd);
}

export function formatPreflightDisclosure(d: PreflightDisclosure): string {
  const estimate = planningEstimateUsd(d);
  const costCap = runtimeCostCapUsd(d);
  const lines = [
    "=== Rúnir model benchmark preflight ===",
    `dryRun: ${d.dryRun}`,
    `confirmCost: ${d.confirmCost}`,
    `smokeMode: ${d.smokeMode}`,
    `configuredGatewayBaseUrl: ${d.gatewayBaseUrl}`,
    `credentialSources: ${d.credentialSourceLabel}`,
    `corpusSize: ${d.corpusSize}`,
    `repetitions: ${d.repetitions}`,
    `plannedRequestCount: ${d.plannedRequestCount}`,
    `maxOutputTokens: ${d.maxOutputTokens}`,
    `timeoutMs: ${d.timeoutMs}`,
    `concurrency: ${d.concurrency}`,
    `conditionId: ${d.conditionId ?? "n/a"}`,
    `requireCleanGit: ${d.requireCleanGit ?? false}`,
    `allowArtifactOverwrite: ${d.allowArtifactOverwrite ?? false}`,
    "candidates:",
    ...d.candidates.map(
      (c) =>
        `  - ${c.id}: modelId=${c.modelId} api=${c.apiStyle ?? "chat_completions"} ` +
        `endpoint=${c.endpoint ?? "configured"} baseUrl=${c.endpointBaseUrl ?? d.gatewayBaseUrl} ` +
        `credentialSource=${c.credentialSourceLabel ?? d.credentialSourceLabel} ` +
        `reasoning=${c.reasoning ?? "n/a"} support=${c.reasoningSupport} ` +
        `reasoningBudgetTokens=${c.reasoningBudgetTokens ?? "n/a"}` +
        (c.effectiveNotes.length ? ` notes=${JSON.stringify(c.effectiveNotes)}` : ""),
    ),
    `costEstimate.available: ${d.costEstimate.available}`,
    `costEstimate.note: ${d.costEstimate.note}`,
    estimate !== null
      ? `costEstimate.estimatedTotalUsd: ${estimate.toFixed(4)}`
      : "costEstimate.estimatedTotalUsd: n/a",
    `costEstimate.assumedPromptTokensPerRequest: ${finiteNumberOrNull(d.costEstimate.assumedPromptTokensPerRequest) ?? "n/a"}`,
    `costEstimate.assumedCompletionTokensPerRequest: ${finiteNumberOrNull(d.costEstimate.assumedCompletionTokensPerRequest) ?? "n/a"}`,
    costCap !== null
      ? `costEstimate.maxTotalCostUsd: ${costCap.toFixed(4)}`
      : "costEstimate.maxTotalCostUsd: n/a",
    "======================================",
  ];
  return lines.join("\n");
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return n.toFixed(digits);
}

export function renderMarkdownReport(args: {
  manifest: RunManifest;
  rows: ResultRow[];
  aggregates?: AggregateMetrics[];
  recommendation?: string;
}): string {
  const aggregates = args.aggregates ?? aggregateByCandidate(args.rows);
  const d = args.manifest.disclosure;
  const rec =
    args.recommendation ??
    deriveRecommendation(aggregates, d.dryRun);

  const lines: string[] = [];
  lines.push("# Rúnir Extraction Model Benchmark Report");
  lines.push("");
  lines.push(`- Schema: \`${args.manifest.schemaVersion}\``);
  lines.push(`- Run ID: \`${args.manifest.runId}\``);
  if (args.manifest.conditionId) {
    lines.push(`- Condition: \`${args.manifest.conditionId}\``);
  }
  lines.push(`- Created: ${args.manifest.createdAt}`);
  lines.push(
    `- Git: \`${args.manifest.git.sha}\`${args.manifest.git.dirty ? " (dirty)" : ""}`,
  );
  lines.push(
    `- Fixture content hash: \`${args.manifest.fixtureContentHash ?? "legacy-unavailable"}\``,
  );
  lines.push(
    `- Prompt template hash: \`${args.manifest.promptTemplateHash ?? "legacy-unavailable"}\``,
  );
  lines.push(
    `- Scoring contract: \`${args.manifest.scoringContractVersion ?? "legacy-unavailable"}\``,
  );
  lines.push(`- Prompt hash: \`${args.manifest.promptHash}\``);
  lines.push(`- Fixtures: \`${args.manifest.fixturePath}\``);
  lines.push(`- Rows: ${args.manifest.rowCount}`);
  if (args.manifest.completion) {
    lines.push(
      `- Completion: **${args.manifest.completion.status}** (${args.manifest.completion.completedRequestCount}/${args.manifest.completion.plannedRequestCount})`,
    );
    if (args.manifest.completion.stopReason) {
      lines.push(`- Stop reason: \`${args.manifest.completion.stopReason}\``);
    }
    lines.push(
      `- Cumulative billed/estimated cost: $${args.manifest.completion.cumulativeCostUsd.toFixed(6)}`,
    );
  }
  lines.push("");
  lines.push("## Executive recommendation");
  lines.push("");
  lines.push(rec);
  lines.push("");
  lines.push("## Model / configuration matrix");
  lines.push("");
  lines.push(
    "| ID | Label | Model ID | API | Endpoint | Reasoning | Support | Mapped budget | Notes |",
  );
  lines.push("|---|---|---|---|---|---|---|---:|---|");
  for (const c of d.candidates) {
    lines.push(
      `| ${c.id} | ${c.label} | \`${c.modelId}\` | ${c.apiStyle ?? "chat_completions"} | ${c.endpoint ?? "configured"} | ${c.reasoning ?? "—"} | ${c.reasoningSupport} | ${c.reasoningBudgetTokens ?? "—"} | ${c.effectiveNotes.join("; ") || "—"} |`,
    );
  }
  lines.push("");
  lines.push("## Corpus and scoring");
  lines.push("");
  lines.push(
    `- Cases: ${d.corpusSize}${d.smokeMode ? " (smoke subset)" : ""}`,
  );
  if (d.caseIds?.length) {
    lines.push(`- Case IDs: ${d.caseIds.map((caseId) => `\`${caseId}\``).join(", ")}`);
  }
  lines.push(`- Repetitions: ${d.repetitions}`);
  lines.push(`- Planned requests: ${d.plannedRequestCount}`);
  lines.push(`- Configured gateway default: \`${d.gatewayBaseUrl}\``);
  lines.push(`- Credential sources: \`${d.credentialSourceLabel}\``);
  lines.push(
    "- Scoring: human gold mustContain matching; precision/recall/hallucination/omission/abstention; no model-as-judge gold.",
  );
  lines.push("");
  lines.push("## Quality");
  lines.push("");
  lines.push(
    "| Candidate | n | Schema-valid | Precision | Recall | Hallucination | Omission | Abstention |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const a of aggregates) {
    lines.push(
      `| ${a.candidateId} | ${a.n} | ${fmtPct(a.schemaValidRate)} | ${fmtPct(a.meanAtomicPrecision)} | ${fmtPct(a.meanAtomicRecall)} | ${fmtPct(a.meanHallucinationRate)} | ${fmtPct(a.meanOmissionRate)} | ${fmtPct(a.abstentionAccuracy)} |`,
    );
  }
  lines.push("");
  lines.push("## Latency / reliability");
  lines.push("");
  lines.push(
    "| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const a of aggregates) {
    lines.push(
      `| ${a.candidateId} | ${fmtNum(a.latency.p50, 0)} | ${fmtNum(a.latency.p90, 0)} | ${fmtNum(a.latency.p95, 0)} | ${fmtNum(a.latency.mean, 0)} | ${fmtPct(a.validCompletionRate)} | ${fmtPct(a.firstAttemptSuccessRate)} | ${fmtPct(a.timeoutRate)} |`,
    );
  }
  lines.push("");
  lines.push("## Cost");
  lines.push("");
  lines.push(
    "| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |",
  );
  lines.push("|---|---:|---:|---:|---:|");
  for (const a of aggregates) {
    lines.push(
      `| ${a.candidateId} | ${fmtNum(a.meanCostPerExtraction, 6)} | ${fmtNum(a.projectedCostPer1000Turns, 4)} | ${fmtNum(a.costPerCorrectGoldFact, 6)} | ${fmtNum(a.meanOutputTokens, 1)} |`,
    );
  }
  lines.push("");
  lines.push(`Cost note: ${d.costEstimate.note}`);
  const costCap = runtimeCostCapUsd(d);
  if (costCap !== null) {
    lines.push(`Runtime cost cap: $${costCap.toFixed(4)}`);
  }
  lines.push("");
  lines.push("## Notable failures");
  lines.push("");
  const failures = args.rows.filter(
    (r) =>
      r.errorClass ||
      !r.quality.schemaValid ||
      (r.quality.hallucinationRate !== null && r.quality.hallucinationRate > 0.5) ||
      r.quality.abstentionCorrect === false,
  );
  if (failures.length === 0) {
    lines.push("_No catastrophic schema/hallucination/abstention failures in this artifact._");
  } else {
    for (const f of failures.slice(0, 25)) {
      lines.push(
        `- \`${f.candidateId}\` / \`${f.caseId}\` r${f.repetition}: error=${f.errorClass ?? "none"} schema=${f.quality.schemaValid} class=${f.parse.classification} hall=${fmtPct(f.quality.hallucinationRate)} head=${JSON.stringify(f.parse.rawTextHead).slice(0, 120)}`,
      );
    }
    if (failures.length > 25) lines.push(`- … ${failures.length - 25} more`);
  }
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  lines.push("- Gold matching is substring-based and may under-credit valid paraphrases.");
  lines.push("- Gateway routing/pricing may differ from public list prices.");
  lines.push("- Grok default-only reasoning must not be labeled low unless native control is verified.");
  lines.push("- Dry-run rows use synthetic/zero network latency unless fixtures inject values.");
  lines.push("");
  lines.push("## Reproduction");
  lines.push("");
  lines.push("```bash");
  lines.push(
    `# Required source: ${args.manifest.git.sha} in a clean worktree` +
      (args.manifest.git.dirty ? " (original artifact was dirty; exact clean reproduction is unavailable)" : ""),
  );
  lines.push(
    args.manifest.artifactTargets
      ? "# Exact zero-network reproduction"
      : "# Best-effort legacy zero-network reproduction (original output targets unavailable)",
  );
  lines.push(reproductionCommand(args.manifest, false));
  lines.push(
    args.manifest.artifactTargets
      ? "# Exact paid reproduction (fresh human approval required)"
      : "# Best-effort legacy paid reproduction (fresh human approval required)",
  );
  lines.push("# Run the following only through the approved Infisical credential injection path:");
  lines.push(reproductionCommand(args.manifest, true));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function reproductionCommand(manifest: RunManifest, paid: boolean): string {
  const d = manifest.disclosure;
  const flags = [
    "node --import tsx/esm scripts/model-benchmark-extraction.ts",
    paid ? "--confirm-cost" : "--dry-run",
    "--models",
    shellQuote(d.candidates.map((candidate) => candidate.id).join(",")),
    "--fixtures",
    shellQuote(manifest.fixturePath),
    "--repetitions",
    String(d.repetitions),
    "--concurrency",
    String(d.concurrency),
    "--timeout-ms",
    String(d.timeoutMs),
    "--max-output-tokens",
    String(d.maxOutputTokens),
    "--base-url",
    shellQuote(d.gatewayBaseUrl),
  ];
  if (d.caseIds?.length) {
    flags.push("--case-ids", shellQuote(d.caseIds.join(",")));
  }
  if (d.smokeMode) flags.push("--smoke");
  if (manifest.conditionId) flags.push("--condition-id", shellQuote(manifest.conditionId));
  const costCap = runtimeCostCapUsd(d);
  if (costCap !== null) flags.push("--max-total-cost-usd", String(costCap));
  if (d.requireCleanGit === true) flags.push("--require-clean-git");
  if (manifest.artifactTargets) {
    flags.push("--out-raw", shellQuote(manifest.artifactTargets.rawPath));
    flags.push("--out-report", shellQuote(manifest.artifactTargets.reportPath));
  }
  return flags.join(" ");
}

function deriveRecommendation(aggregates: AggregateMetrics[], dryRun: boolean): string {
  if (dryRun || aggregates.every((a) => a.n === 0)) {
    return "No paid results yet. Keep `vertex/gemini-3.1-flash-lite@us` as production control until smoke + full benchmark complete.";
  }
  const control = aggregates.find(
    (a) => a.candidateId === "flash-lite-3.1-control" || a.candidateId === "flash-lite-control",
  );
  if (!control) {
    return "Control candidate (Gemini 3.1 Flash-Lite) missing from results; collect more evidence before any production change.";
  }
  return (
    "Gemini 3.1 Flash-Lite remains the production control. Recommend **keep** unless 3.5 Flash-Lite " +
    "(or another challenger) shows no material regression in schema validity, hallucination, abstention, or evidence fidelity, " +
    "improves precision/recall enough to justify measured $/1k turns, and stays within capture p95 latency. " +
    "Review quality and cost tables above before proposing a switch."
  );
}

/** Rebuild report solely from raw rows + manifest (no live calls). */
export function regenerateReportFromRaw(manifest: RunManifest, rows: ResultRow[]): string {
  return renderMarkdownReport({ manifest, rows });
}
