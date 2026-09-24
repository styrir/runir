import { canonicalHash } from "../model-benchmark/provenance.js";
import { percentile } from "../judge-benchmark/metrics.js";
import { isRecord } from "../judge-benchmark/schema.js";
import { isHarmfulOutcome } from "../judge-benchmark/score.js";
import {
  JUDGE_BENCHMARK_SCHEMA_VERSION,
  JUDGE_SCORING_CONTRACT_VERSION,
  type JudgeBenchmarkRow,
  type JudgeRunManifest,
} from "../judge-benchmark/types.js";
import { ReviewAdapterError, buildComparisonKey } from "./benchmark-adapter.js";
import {
  REVIEW_RUN_SCHEMA_VERSION,
  type BenchmarkRunBundle,
  type ReviewAggregate,
  type ReviewCandidate,
  type ReviewCaseResult,
  type ReviewDiagnostic,
  type ReviewMetricDefinition,
  type ReviewRawEvidence,
  type ReviewRun,
} from "./types.js";

export const JUDGE_METRIC_DEFINITIONS: readonly ReviewMetricDefinition[] = [
  { id: "harmful", label: "Harmful", direction: "lower_is_better" },
  { id: "updateLanded", label: "Update landed", direction: "higher_is_better" },
  { id: "correctionDropped", label: "Correction dropped", direction: "lower_is_better" },
  { id: "latencyMs", label: "Latency", direction: "lower_is_better" },
  { id: "retireScore", label: "Retire score", direction: "neutral" },
  { id: "error", label: "Error", direction: "lower_is_better" },
  { id: "billedCostUsd", label: "Billed cost", direction: "lower_is_better" },
  { id: "harmfulRate", label: "Harmful rate", direction: "lower_is_better" },
  { id: "updateRecall", label: "Update recall", direction: "higher_is_better" },
  { id: "correctionDroppedRate", label: "Correction-dropped rate", direction: "lower_is_better" },
  { id: "errorRate", label: "Error rate", direction: "lower_is_better" },
  { id: "p50LatencyMs", label: "p50 latency", direction: "lower_is_better" },
  { id: "p95LatencyMs", label: "p95 latency", direction: "lower_is_better" },
  { id: "meanCostUsd", label: "Mean cost", direction: "lower_is_better" },
];

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

function pickScalars(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in source)) continue;
    const value = scalar(source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function projectRef(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return pickScalars(value, ["id", "sha256"]);
}

function projectGold(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return pickScalars(value, ["label", "labelA", "labelB", "resolution", "headline", "strict"]);
}

function projectUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return pickScalars(value, ["promptTokens", "completionTokens", "totalTokens"]);
}

function projectSignals(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out = pickScalars(value, ["family", "verdict", "confidence", "probability", "argmax"]);
  if ("pSupersede" in value && (typeof value.pSupersede === "number" || value.pSupersede === null)) {
    out.pSupersede = value.pSupersede;
  }
  return out;
}

const ROW_SCALARS = [
  "schemaVersion",
  "runId",
  "timestamp",
  "pairId",
  "datasetId",
  "candidateId",
  "candidateConfigHash",
  "repetition",
  "direction",
  "split",
  "population",
  "stratum",
  "frame",
  "legacyBinaryGold",
  "decision",
  "effectiveDecision",
  "retireScore",
  "outcome",
  "latencyMs",
  "retryCount",
  "billedCostUsd",
  "estimatedCostUsd",
  "errorClass",
  "httpStatus",
] as const;

/** Allowlist: ids, hashes, gold, decision, scores, latency, cost, metrics, errorClass, httpStatus. */
export function projectJudgeRowEvidence(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out = pickScalars(value, ROW_SCALARS);
  const gold = projectGold(value.gold);
  const oldRef = projectRef(value.oldRef);
  const newRef = projectRef(value.newRef);
  const signals = projectSignals(value.signals);
  const usage = projectUsage(value.usage);
  if (gold) out.gold = gold;
  if (oldRef) out.oldRef = oldRef;
  if (newRef) out.newRef = newRef;
  if (signals) out.signals = signals;
  if (usage) out.usage = usage;
  return out;
}

const MANIFEST_SCALARS = [
  "schemaVersion",
  "scoringContractVersion",
  "taskId",
  "runId",
  "createdAt",
  "datasetId",
  "candidateId",
  "split",
  "probe",
  "replayOnly",
  "threshold",
  "thresholdSource",
  "rowCount",
  "fixtureContentHash",
  "textSnapshotHash",
] as const;

const DISCLOSURE_SCALARS = [
  "candidateId",
  "candidateConfigHash",
  "modelId",
  "pairs",
  "caseErrors",
  "plannedRequestCount",
  "dryRun",
  "replayOnly",
  "concurrency",
  "maxTotalCostUsd",
  "estimatedCostUsdUpper",
  "probe",
] as const;

const COMPLETION_SCALARS = [
  "status",
  "plannedRequestCount",
  "completedRequestCount",
  "cumulativeCostUsd",
  "stopReason",
] as const;

/** Allowlist projection of a judge manifest. Unexpected keys are dropped. */
export function projectJudgeManifestEvidence(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out = pickScalars(value, MANIFEST_SCALARS);
  if (Array.isArray(value.candidateConfigHashes)) {
    out.candidateConfigHashes = value.candidateConfigHashes.filter((entry): entry is string => typeof entry === "string");
  }
  if (isRecord(value.git)) out.git = pickScalars(value.git, ["sha", "dirty"]);
  if (isRecord(value.disclosure)) out.disclosure = pickScalars(value.disclosure, DISCLOSURE_SCALARS);
  if (isRecord(value.completion)) out.completion = pickScalars(value.completion, COMPLETION_SCALARS);
  return out;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mean(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function asRow(value: unknown, index: number): JudgeBenchmarkRow {
  if (!isRecord(value) || typeof value.pairId !== "string" || typeof value.candidateId !== "string") {
    throw new ReviewAdapterError("invalid_bundle", `row ${index} is missing pairId or candidateId`);
  }
  return value as unknown as JudgeBenchmarkRow;
}

function caseMetrics(row: JudgeBenchmarkRow): Record<string, number | null> {
  const harmful = row.outcome ? (isHarmfulOutcome(row.outcome) ? 1 : 0) : null;
  const updateLanded = row.gold.label === "supersede" ? (row.outcome === "update_landed" ? 1 : 0) : null;
  const correctionDropped = row.gold.label === "supersede" ? (row.outcome === "correction_dropped" ? 1 : 0) : null;
  return {
    harmful,
    updateLanded,
    correctionDropped,
    latencyMs: numberOrNull(row.latencyMs),
    retireScore: numberOrNull(row.retireScore),
    error: row.decision === "error" ? 1 : 0,
    billedCostUsd: numberOrNull(row.billedCostUsd),
  };
}

function aggregates(cases: ReviewCaseResult[], candidates: ReviewCandidate[]): ReviewAggregate[] {
  return candidates.map((candidate) => {
    const group = cases.filter((item) => item.candidateId === candidate.id);
    const values = (id: string) => group.map((item) => item.metrics[id] ?? null);
    const latency = values("latencyMs").filter((value): value is number => value !== null);
    return {
      candidateId: candidate.id,
      label: candidate.label,
      modelId: candidate.modelId,
      n: group.length,
      metrics: {
        harmfulRate: mean(values("harmful")),
        updateRecall: mean(values("updateLanded")),
        correctionDroppedRate: mean(values("correctionDropped")),
        errorRate: mean(values("error")),
        p50LatencyMs: percentile(latency, 50),
        p95LatencyMs: percentile(latency, 95),
        meanCostUsd: mean(values("billedCostUsd")),
      },
    };
  });
}

export function adaptJudgeBenchmarkRun(bundle: BenchmarkRunBundle): ReviewRun {
  if (!isRecord(bundle.manifest)) throw new ReviewAdapterError("invalid_bundle", "manifest must be an object");
  const manifest = bundle.manifest as unknown as JudgeRunManifest;
  if (manifest.schemaVersion !== JUDGE_BENCHMARK_SCHEMA_VERSION) {
    throw new ReviewAdapterError("unsupported_schema", "not a judge benchmark manifest");
  }
  if (!isRecord(manifest.git) || typeof manifest.git.sha !== "string" || typeof manifest.git.dirty !== "boolean") {
    throw new ReviewAdapterError("invalid_bundle", "manifest.git is incomplete");
  }
  const rows = bundle.rows.map(asRow);
  const disclosure: Record<string, unknown> = isRecord(manifest.disclosure) ? manifest.disclosure : {};
  const completion: Record<string, unknown> = isRecord(manifest.completion) ? manifest.completion : {};
  const disclosedModelId = typeof disclosure.modelId === "string" ? disclosure.modelId : undefined;
  const rawManifest = projectJudgeManifestEvidence(bundle.manifest);
  const candidatesById = new Map<string, ReviewCandidate>();
  for (const row of rows) {
    candidatesById.set(row.candidateId, {
      id: row.candidateId,
      label: row.candidateId,
      modelId: disclosedModelId ?? row.candidateId,
    });
  }
  const candidates = [...candidatesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const cases = rows.map((row): ReviewCaseResult => {
    const metrics = caseMetrics(row);
    const comparisonKey = buildComparisonKey({
      caseId: row.pairId,
      candidateId: row.candidateId,
      repetition: row.repetition,
    });
    const preview = bundle.judgeTextPreviews?.[row.pairId];
    const rawEvidence: ReviewRawEvidence = {
      manifest: rawManifest,
      row: projectJudgeRowEvidence(row),
      unknownManifestFields: [],
      unknownRowFields: [],
    };
    return {
      comparisonKey,
      caseId: row.pairId,
      repetition: row.repetition,
      candidateId: row.candidateId,
      status: row.decision === "error" ? "error" : row.outcome === "wrong_retirement" || row.outcome === "wrong_skip" || row.outcome === "correction_dropped" || row.outcome === "missed_update" ? "fail" : "pass",
      metrics,
      inputRef: { kind: "judge-case", locator: row.pairId },
      outputRef: { kind: "judge-row", locator: comparisonKey },
      diagnostics: row.errorClass
        ? [{ code: row.errorClass, message: row.errorClass, severity: "error" as const }]
        : [],
      detail: {
        kind: "judge-pairs",
        goldLabel: row.gold?.label ?? null,
        decision: row.decision,
        retireScore: numberOrNull(row.retireScore),
        latencyMs: row.latencyMs,
        ...(row.errorClass ? { errorClass: row.errorClass } : {}),
        ...(typeof row.httpStatus === "number" ? { httpStatus: row.httpStatus } : {}),
        ...(preview?.oldPreview ? { oldPreview: preview.oldPreview } : {}),
        ...(preview?.newPreview ? { newPreview: preview.newPreview } : {}),
      },
      rawEvidence,
    };
  });
  const dryRun = disclosure.dryRun === true;
  const diagnostics: ReviewDiagnostic[] = [];
  if (manifest.git.dirty) diagnostics.push({ code: "dirty_git", message: "Run was produced from a dirty Git worktree.", severity: "warning" });
  if (dryRun) diagnostics.push({ code: "dry_run", message: "Run performed no paid model calls.", severity: "info" });
  const fixtureHash = typeof manifest.fixtureContentHash === "string" ? manifest.fixtureContentHash : undefined;
  return {
    schemaVersion: REVIEW_RUN_SCHEMA_VERSION,
    runId: manifest.runId,
    suiteId: "runir-judge-benchmark",
    suiteLabel: "Judge pairs",
    suiteVersion: `runir-judge-suite/v1-${canonicalHash({
      schemaVersion: JUDGE_BENCHMARK_SCHEMA_VERSION,
      scoringContractVersion: manifest.scoringContractVersion ?? JUDGE_SCORING_CONTRACT_VERSION,
      fixtureHash: fixtureHash ?? null,
      candidateConfigHashes: manifest.candidateConfigHashes ?? [],
    })}`,
    runKind: "judge-pairs",
    casePresentation: "judge-pairs",
    metricDefinitions: [...JUDGE_METRIC_DEFINITIONS],
    createdAt: manifest.createdAt,
    git: { sha: manifest.git.sha, dirty: manifest.git.dirty },
    configHash: canonicalHash({
      candidateId: manifest.candidateId,
      candidateConfigHashes: manifest.candidateConfigHashes ?? [],
      threshold: manifest.threshold ?? null,
      probe: manifest.probe ?? null,
    }),
    ...(fixtureHash ? { fixtureHash } : {}),
    sourceArtifacts: ["judge-manifest", "judge-rows"],
    candidates,
    cases,
    aggregates: aggregates(cases, candidates),
    provenance: {
      compatibility: fixtureHash ? "verified" : "legacy-unverified",
      ...(fixtureHash ? { fixtureContentHash: fixtureHash } : {}),
      scoringContractVersion: manifest.scoringContractVersion,
      gitDirty: manifest.git.dirty,
      synthetic: dryRun,
      dryRun,
      incomplete: completion.status === "partial",
      rowCount: rows.length,
      expectedRowCount: numberOrNull(disclosure.plannedRequestCount),
      completionStatus: completion.status === "partial" ? "partial" : "complete",
      ...(typeof completion.stopReason === "string" ? { stopReason: completion.stopReason } : {}),
      ...(numberOrNull(completion.cumulativeCostUsd) !== null
        ? { cumulativeCostUsd: numberOrNull(completion.cumulativeCostUsd) ?? undefined }
        : {}),
      repetitionCount: rows.length ? Math.max(...rows.map((row) => row.repetition)) : 0,
      repetitionValues: [...new Set(rows.map((row) => row.repetition))].sort((a, b) => a - b),
      candidateIds: candidates.map((item) => item.id),
    },
    diagnostics,
    rawManifest,
  };
}
