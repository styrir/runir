import { canonicalHash } from "../model-benchmark/provenance.js";
import {
  THINK_BENCHMARK_SCHEMA_VERSION,
  THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
  THINK_RESPONSE_PARSER_VERSION,
  THINK_SCORING_CONTRACT_VERSION,
  type ThinkBenchmarkRow,
  type ThinkRunManifest,
} from "../think-benchmark/types.js";
import {
  REVIEW_RUN_SCHEMA_VERSION,
  type BenchmarkRunBundle,
  type ReviewAggregate,
  type ReviewArtifactRef,
  type ReviewCandidate,
  type ReviewCaseResult,
  type ReviewDiagnostic,
  type ReviewMetricDefinition,
  type ReviewRun,
} from "./types.js";
import {
  ReviewAdapterError,
  buildComparisonKey,
  percentile,
} from "./benchmark-adapter.js";

export const THINK_METRIC_DEFINITIONS: readonly ReviewMetricDefinition[] = [
  { id: "schemaValid", label: "Schema valid", direction: "higher_is_better" },
  { id: "answerCompleteness", label: "Answer completeness", direction: "higher_is_better" },
  { id: "unsupportedClaimRate", label: "Unsupported-claim rate", direction: "lower_is_better" },
  { id: "citationValidity", label: "Citation validity", direction: "higher_is_better" },
  { id: "citationPrecision", label: "Citation precision", direction: "higher_is_better" },
  { id: "citationCompleteness", label: "Citation completeness", direction: "higher_is_better" },
  { id: "gapAccuracy", label: "Gap accuracy", direction: "higher_is_better" },
  { id: "abstentionCorrect", label: "Abstention correct", direction: "higher_is_better" },
  { id: "retrievalPass", label: "Retrieval pass", direction: "higher_is_better" },
  { id: "retrievalRecall", label: "Retrieval recall", direction: "higher_is_better" },
  { id: "retrievalPrecision", label: "Retrieval precision", direction: "higher_is_better" },
  { id: "retrievalRetainedRecall", label: "Retained recall", direction: "higher_is_better" },
  { id: "retrievalFirstRelevantRank", label: "First relevant rank", direction: "lower_is_better" },
  { id: "retrievalMeanRelevantRank", label: "Mean relevant rank", direction: "lower_is_better" },
  { id: "latencyMs", label: "Latency", direction: "lower_is_better" },
  { id: "promptTokens", label: "Prompt tokens", direction: "lower_is_better" },
  { id: "completionTokens", label: "Completion tokens", direction: "lower_is_better" },
  { id: "totalTokens", label: "Total tokens", direction: "lower_is_better" },
  { id: "estimatedCostUsd", label: "Estimated cost", direction: "lower_is_better" },
  { id: "billedCostUsd", label: "Billed cost", direction: "lower_is_better" },
  { id: "schemaValidRate", label: "Schema-valid rate", direction: "higher_is_better" },
  { id: "meanAnswerCompleteness", label: "Answer completeness", direction: "higher_is_better" },
  { id: "meanUnsupportedClaimRate", label: "Unsupported-claim rate", direction: "lower_is_better" },
  { id: "meanCitationValidity", label: "Citation validity", direction: "higher_is_better" },
  { id: "meanCitationPrecision", label: "Citation precision", direction: "higher_is_better" },
  { id: "meanCitationCompleteness", label: "Citation completeness", direction: "higher_is_better" },
  { id: "meanGapAccuracy", label: "Gap accuracy", direction: "higher_is_better" },
  { id: "abstentionAccuracy", label: "Abstention accuracy", direction: "higher_is_better" },
  { id: "retrievalSuccessRate", label: "Retrieval success", direction: "higher_is_better" },
  { id: "meanRetrievalRecall", label: "Mean retrieval recall", direction: "higher_is_better" },
  { id: "meanRetrievalPrecision", label: "Mean retrieval precision", direction: "higher_is_better" },
  { id: "meanRetrievalRetainedRecall", label: "Mean retained recall", direction: "higher_is_better" },
  { id: "meanRetrievalFirstRelevantRank", label: "Mean first relevant rank", direction: "lower_is_better" },
  { id: "meanRetrievalMeanRelevantRank", label: "Mean relevant rank", direction: "lower_is_better" },
  { id: "p50LatencyMs", label: "p50 latency", direction: "lower_is_better" },
  { id: "p95LatencyMs", label: "p95 latency", direction: "lower_is_better" },
  { id: "meanLatencyMs", label: "Mean latency", direction: "lower_is_better" },
  { id: "meanOutputTokens", label: "Mean output tokens", direction: "lower_is_better" },
  { id: "meanCostPerThink", label: "Mean cost / Think", direction: "lower_is_better" },
];

const THINK_SUITE_IDS = new Set(["runir-think-synthesis", "runir-think-e2e"]);
const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|bearer|credential|password|secret|^token$)/i;
const PATH_KEY_PATTERN = /(?:path|file|filename|directory|cwd|root)$/i;
const KNOWN_MANIFEST_FIELDS = new Set([
  "schemaVersion", "runId", "suiteId", "createdAt", "git", "fixtureContentHash",
  "retrievalFixtureContentHash", "promptTemplateHash", "scoringContractVersion",
  "retrievalMetricContractVersion", "rowCount", "disclosure", "completion",
]);
const KNOWN_ROW_FIELDS = new Set([
  "schemaVersion", "runId", "timestamp", "caseId", "repetition", "candidateId",
  "candidateLabel", "modelId", "question", "evidence", "gold", "effectiveRequest",
  "responseParserVersion", "synthesis", "rawResponseHead", "quality", "usage",
  "synthesisVerdict",
  "latencyMs", "retryCount", "httpStatus", "errorClass", "requestId",
  "estimatedCostUsd", "billedCostUsd", "retrieval",
  "costBasis",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ReviewAdapterError("invalid_bundle", `${label} must be an object`);
  return value;
}

function requiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ReviewAdapterError("invalid_bundle", `${label}.${key} must be a non-empty string`);
  }
  return value;
}

function hashString(source: Record<string, unknown>, key: string): string {
  const value = requiredString(source, key, "manifest");
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new ReviewAdapterError("invalid_provenance", `manifest.${key} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredNumber(value: unknown, label: string): number {
  const result = numberOrNull(value);
  if (result === null) throw new ReviewAdapterError("invalid_bundle", `${label} must be a finite number`);
  return result;
}

function requiredRate(source: Record<string, unknown>, key: string, label: string): void {
  const value = requiredNumber(source[key], `${label}.${key}`);
  if (value < 0 || value > 1) {
    throw new ReviewAdapterError("invalid_bundle", `${label}.${key} must be between 0 and 1`);
  }
}

function normalizeGatewayIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/u, "")}`;
  } catch {
    return value.replace(/[?#].*$/u, "").replace(/\/$/u, "");
  }
}

function sanitize(value: unknown, key = ""): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (key === "gatewayBaseUrl" && typeof value === "string") return normalizeGatewayIdentity(value);
  if (typeof value === "string" && PATH_KEY_PATTERN.test(key)) return "[REDACTED_PATH]";
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, key));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  }
  return value;
}

function mean(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function metric(source: Record<string, unknown>, key: string): number | null {
  if (key === "schemaValid") return source.schemaValid === true ? 1 : 0;
  return numberOrNull(source[key]);
}

function rowMetrics(row: ThinkBenchmarkRow): Record<string, number | null> {
  const quality = asRecord(row.quality, `row ${row.caseId}.quality`);
  const usage = asRecord(row.usage, `row ${row.caseId}.usage`);
  const synthesisScored = row.synthesisVerdict !== "not-scored" &&
    (row.retrieval === undefined || row.retrieval.status === "pass");
  const retrievalScores: Record<string, unknown> = isRecord(row.retrieval?.scores)
    ? row.retrieval.scores
    : {};
  const qualityMetric = (key: string) => synthesisScored ? metric(quality, key) : null;
  return {
    schemaValid: qualityMetric("schemaValid"),
    answerCompleteness: qualityMetric("answerCompleteness"),
    unsupportedClaimRate: qualityMetric("unsupportedClaimRate"),
    citationValidity: qualityMetric("citationValidity"),
    citationPrecision: qualityMetric("citationPrecision"),
    citationCompleteness: qualityMetric("citationCompleteness"),
    gapAccuracy: qualityMetric("gapAccuracy"),
    abstentionCorrect: qualityMetric("abstentionCorrect"),
    retrievalPass: row.retrieval === undefined ? null : row.retrieval.status === "pass" ? 1 : 0,
    retrievalRecall: numberOrNull(retrievalScores["recall"]),
    retrievalPrecision: numberOrNull(retrievalScores["precision"]),
    retrievalRetainedRecall: numberOrNull(retrievalScores["retainedRecall"]),
    retrievalFirstRelevantRank: numberOrNull(retrievalScores["firstRelevantRank"]),
    retrievalMeanRelevantRank: numberOrNull(retrievalScores["meanRelevantRank"]),
    latencyMs: numberOrNull(row.latencyMs),
    promptTokens: numberOrNull(usage.promptTokens),
    completionTokens: numberOrNull(usage.completionTokens),
    totalTokens: numberOrNull(usage.totalTokens),
    estimatedCostUsd: numberOrNull(row.estimatedCostUsd),
    billedCostUsd: numberOrNull(row.billedCostUsd),
  };
}

function caseStatus(row: ThinkBenchmarkRow, metrics: Record<string, number | null>): ReviewCaseResult["status"] {
  if (row.errorClass) return "error";
  if (row.retrieval?.status === "error") return "error";
  if (row.retrieval?.status === "fail") return "fail";
  if (row.synthesisVerdict === "not-scored") return "unscored";
  const passed =
    metrics.schemaValid === 1 &&
    metrics.answerCompleteness === 1 &&
    metrics.unsupportedClaimRate === 0 &&
    metrics.citationValidity === 1 &&
    metrics.citationPrecision === 1 &&
    metrics.citationCompleteness === 1 &&
    metrics.gapAccuracy === 1 &&
    metrics.abstentionCorrect === 1 &&
    row.quality.forbiddenMatches.length === 0;
  return passed ? "pass" : "fail";
}

function parseBundle(bundle: BenchmarkRunBundle): {
  manifest: ThinkRunManifest;
  manifestRecord: Record<string, unknown>;
  rows: ThinkBenchmarkRow[];
  rowRecords: Record<string, unknown>[];
} {
  const manifest = asRecord(bundle.manifest, "manifest");
  if (manifest.schemaVersion !== THINK_BENCHMARK_SCHEMA_VERSION) {
    throw new ReviewAdapterError("unsupported_schema", `Unsupported Think schema: ${String(manifest.schemaVersion)}`);
  }
  const suiteId = requiredString(manifest, "suiteId", "manifest");
  if (!THINK_SUITE_IDS.has(suiteId)) {
    throw new ReviewAdapterError("unsupported_schema", `Unsupported Think suite: ${suiteId}`);
  }
  requiredString(manifest, "runId", "manifest");
  requiredString(manifest, "createdAt", "manifest");
  asRecord(manifest.git, "manifest.git");
  asRecord(manifest.disclosure, "manifest.disclosure");
  const completion = asRecord(manifest.completion, "manifest.completion");
  if (completion.status !== "complete" && completion.status !== "partial") {
    throw new ReviewAdapterError("invalid_provenance", "manifest.completion.status must be complete or partial");
  }
  const rowCount = requiredNumber(manifest.rowCount, "manifest.rowCount");
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new ReviewAdapterError("invalid_bundle", "manifest.rowCount must be a non-negative integer");
  }
  hashString(manifest, "fixtureContentHash");
  hashString(manifest, "promptTemplateHash");
  if (manifest.scoringContractVersion !== THINK_SCORING_CONTRACT_VERSION) {
    throw new ReviewAdapterError("invalid_provenance", "manifest.scoringContractVersion is unsupported");
  }
  const rowRecords = bundle.rows.map((value, index) => {
    const row = asRecord(value, `rows[${index}]`);
    if (row.schemaVersion !== THINK_BENCHMARK_SCHEMA_VERSION) {
      throw new ReviewAdapterError("unsupported_schema", `rows[${index}] has an unsupported schema`);
    }
    if (row.runId !== manifest.runId) {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].runId does not match manifest.runId`);
    }
    requiredString(row, "caseId", `rows[${index}]`);
    requiredString(row, "candidateId", `rows[${index}]`);
    requiredString(row, "modelId", `rows[${index}]`);
    requiredString(row, "question", `rows[${index}]`);
    const repetition = requiredNumber(row.repetition, `rows[${index}].repetition`);
    if (!Number.isInteger(repetition) || repetition < 1) {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].repetition must be a positive integer`);
    }
    requiredNumber(row.latencyMs, `rows[${index}].latencyMs`);
    asRecord(row.effectiveRequest, `rows[${index}].effectiveRequest`);
    const synthesis = asRecord(row.synthesis, `rows[${index}].synthesis`);
    if (!Array.isArray(synthesis.claims) || !Array.isArray(synthesis.citations) || !Array.isArray(synthesis.gaps)) {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].synthesis must contain claims, citations, and gaps arrays`);
    }
    if (row.responseParserVersion !== THINK_RESPONSE_PARSER_VERSION) {
      throw new ReviewAdapterError("invalid_provenance", `rows[${index}].responseParserVersion is unsupported`);
    }
    const quality = asRecord(row.quality, `rows[${index}].quality`);
    for (const key of [
      "answerCompleteness",
      "unsupportedClaimRate",
      "citationValidity",
      "citationPrecision",
      "citationCompleteness",
      "gapAccuracy",
      "abstentionCorrect",
    ]) {
      requiredRate(quality, key, `rows[${index}].quality`);
    }
    if (typeof quality.schemaValid !== "boolean") {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].quality.schemaValid must be boolean`);
    }
    if (!Array.isArray(quality.forbiddenMatches)) {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].quality.forbiddenMatches must be an array`);
    }
    if (!["pass", "fail", "not-scored"].includes(String(row.synthesisVerdict))) {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].synthesisVerdict is invalid`);
    }
    asRecord(row.usage, `rows[${index}].usage`);
    if (!["gateway_billed", "token_usage_estimate", "reserved_worst_case"].includes(String(row.costBasis))) {
      throw new ReviewAdapterError("invalid_provenance", `rows[${index}].costBasis is unsupported`);
    }
    if (!Array.isArray(row.evidence) || row.evidence.length > 12) {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].evidence must contain at most 12 items`);
    }
    row.evidence.forEach((item, evidenceIndex) => {
      const evidence = asRecord(item, `rows[${index}].evidence[${evidenceIndex}]`);
      requiredString(evidence, "id", `rows[${index}].evidence[${evidenceIndex}]`);
      requiredString(evidence, "text", `rows[${index}].evidence[${evidenceIndex}]`);
    });
    if (suiteId === "runir-think-e2e") {
      const retrieval = asRecord(row.retrieval, `rows[${index}].retrieval`);
      if (!["pass", "fail", "error"].includes(String(retrieval.status))) {
        throw new ReviewAdapterError("invalid_bundle", `rows[${index}].retrieval.status is invalid`);
      }
      if (retrieval.cap !== 12) {
        throw new ReviewAdapterError("invalid_provenance", `rows[${index}].retrieval.cap must be 12`);
      }
      if (retrieval.scores !== undefined) {
        const scores = asRecord(retrieval.scores, `rows[${index}].retrieval.scores`);
        for (const key of ["recall", "precision", "retainedRecall"]) {
          const value = scores[key];
          if (value !== null) requiredRate(scores, key, `rows[${index}].retrieval.scores`);
        }
        for (const key of ["firstRelevantRank", "meanRelevantRank"]) {
          const value = scores[key];
          if (value !== null && (requiredNumber(value, `rows[${index}].retrieval.scores.${key}`) < 1)) {
            throw new ReviewAdapterError("invalid_bundle", `rows[${index}].retrieval.scores.${key} must be positive`);
          }
        }
      }
    }
    return row;
  });
  return {
    manifest: manifest as unknown as ThinkRunManifest,
    manifestRecord: manifest,
    rows: rowRecords as unknown as ThinkBenchmarkRow[],
    rowRecords,
  };
}

function aggregate(rows: ReviewCaseResult[], candidates: ReviewCandidate[]): ReviewAggregate[] {
  return candidates.map((candidate) => {
    const cases = rows.filter((row) => row.candidateId === candidate.id);
    const values = (id: string) => cases.map((row) => row.metrics[id] ?? null);
    return {
      candidateId: candidate.id,
      label: candidate.label,
      modelId: candidate.modelId,
      n: cases.length,
      metrics: {
        schemaValidRate: mean(values("schemaValid")),
        meanAnswerCompleteness: mean(values("answerCompleteness")),
        meanUnsupportedClaimRate: mean(values("unsupportedClaimRate")),
        meanCitationValidity: mean(values("citationValidity")),
        meanCitationPrecision: mean(values("citationPrecision")),
        meanCitationCompleteness: mean(values("citationCompleteness")),
        meanGapAccuracy: mean(values("gapAccuracy")),
        abstentionAccuracy: mean(values("abstentionCorrect")),
        retrievalSuccessRate: mean(values("retrievalPass")),
        meanRetrievalRecall: mean(values("retrievalRecall")),
        meanRetrievalPrecision: mean(values("retrievalPrecision")),
        meanRetrievalRetainedRecall: mean(values("retrievalRetainedRecall")),
        meanRetrievalFirstRelevantRank: mean(values("retrievalFirstRelevantRank")),
        meanRetrievalMeanRelevantRank: mean(values("retrievalMeanRelevantRank")),
        p50LatencyMs: percentile(values("latencyMs").filter((value): value is number => value !== null), 50),
        p95LatencyMs: percentile(values("latencyMs").filter((value): value is number => value !== null), 95),
        meanLatencyMs: mean(values("latencyMs")),
        meanOutputTokens: mean(values("completionTokens")),
        meanCostPerThink: mean(values("billedCostUsd").map((value, index) => value ?? values("estimatedCostUsd")[index] ?? null)),
      },
    };
  });
}

export function adaptThinkBenchmarkRun(bundle: BenchmarkRunBundle): ReviewRun {
  const { manifest, manifestRecord, rows, rowRecords } = parseBundle(bundle);
  const git = asRecord(manifestRecord.git, "manifest.git");
  const disclosure = asRecord(manifestRecord.disclosure, "manifest.disclosure");
  const completion = asRecord(manifestRecord.completion, "manifest.completion");
  if (!["gateway_or_usage", "route_usage_or_reservation"].includes(String(disclosure.costObservation))) {
    throw new ReviewAdapterError("invalid_provenance", "manifest.disclosure.costObservation is unsupported");
  }
  if (typeof git.dirty !== "boolean") throw new ReviewAdapterError("invalid_bundle", "manifest.git.dirty must be boolean");
  const fixtureContentHash = hashString(manifestRecord, "fixtureContentHash");
  const promptTemplateHash = hashString(manifestRecord, "promptTemplateHash");
  const scoringContractVersion = requiredString(manifestRecord, "scoringContractVersion", "manifest");
  const retrievalFixtureContentHash = typeof manifestRecord.retrievalFixtureContentHash === "string"
    ? hashString(manifestRecord, "retrievalFixtureContentHash")
    : null;
  const retrievalMetricContractVersion =
    manifestRecord.retrievalMetricContractVersion === THINK_RETRIEVAL_METRIC_CONTRACT_VERSION
      ? THINK_RETRIEVAL_METRIC_CONTRACT_VERSION
      : null;
  const candidatesById = new Map<string, ReviewCandidate>();
  rows.forEach((row) => candidatesById.set(row.candidateId, {
    id: row.candidateId,
    label: row.candidateLabel,
    modelId: row.modelId,
  }));
  if (candidatesById.size === 0 && typeof disclosure.candidateId === "string") {
    candidatesById.set(disclosure.candidateId, {
      id: disclosure.candidateId,
      label: typeof disclosure.candidateLabel === "string" ? disclosure.candidateLabel : disclosure.candidateId,
      modelId: typeof disclosure.modelId === "string" ? disclosure.modelId : "unknown",
    });
  }
  const candidates = [...candidatesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const cases = rows.map((row, index): ReviewCaseResult => {
    const metrics = rowMetrics(row);
    const comparisonKey = buildComparisonKey({
      caseId: row.caseId,
      candidateId: row.candidateId,
      repetition: row.repetition,
    });
    const inputRef: ReviewArtifactRef = { kind: "think-case", locator: row.caseId };
    const outputRef: ReviewArtifactRef = { kind: "think-row", locator: comparisonKey };
    return {
      comparisonKey,
      caseId: row.caseId,
      repetition: row.repetition,
      candidateId: row.candidateId,
      status: caseStatus(row, metrics),
      metrics,
      inputRef,
      outputRef,
      diagnostics: [
        ...(row.errorClass
          ? [{ code: row.errorClass, message: `Think row failed: ${row.errorClass}`, severity: "error" as const }]
          : []),
        ...(row.retrieval?.status === "fail"
          ? [{
            code: "retrieval_miss",
            message: "Expected supporting evidence was not retained; synthesis metrics are unscored.",
            severity: "warning" as const,
          }]
          : row.retrieval?.status === "error"
            ? [{
              code: "retrieval_error",
              message: "Retrieval failed; synthesis metrics are unscored.",
              severity: "error" as const,
            }]
            : []),
      ],
      detail: {
        kind: manifest.suiteId === "runir-think-e2e" ? "think-e2e" : "think-synthesis",
        question: row.question.slice(0, 1_000),
        evidence: row.evidence.slice(0, 12).map((item) => ({
          id: item.id,
          preview: item.text.slice(0, 500),
        })),
        answer: row.synthesis.answer,
        claims: row.synthesis.claims.slice(0, 24).map((claim) => ({
          text: claim.text.slice(0, 1_000),
          citationIds: claim.citations.map((citation) => citation.id),
          droppedCitationIds: claim.droppedCitations,
        })),
        gaps: row.synthesis.gaps.slice(0, 12).map((gap) => gap.slice(0, 500)),
        synthesisVerdict: row.synthesisVerdict,
        quality: sanitize(row.quality) as Record<string, unknown>,
        usage: sanitize(row.usage) as Record<string, unknown>,
        latencyMs: row.latencyMs,
        estimatedCostUsd: row.estimatedCostUsd,
        costBasis: row.costBasis,
        ...(row.retrieval
          ? { retrieval: sanitize(row.retrieval) as Record<string, unknown> }
          : {}),
      },
      rawEvidence: {
        manifest: sanitize(manifestRecord) as Record<string, unknown>,
        row: sanitize(rowRecords[index]) as Record<string, unknown>,
        unknownManifestFields: Object.keys(manifestRecord).filter((key) => !KNOWN_MANIFEST_FIELDS.has(key)).sort(),
        unknownRowFields: Object.keys(rowRecords[index]!).filter((key) => !KNOWN_ROW_FIELDS.has(key)).sort(),
      },
    };
  });
  const keys = cases.map((item) => item.comparisonKey);
  if (new Set(keys).size !== keys.length) {
    throw new ReviewAdapterError("duplicate_comparison_key", `Duplicate comparison key in run ${manifest.runId}`);
  }
  const expectedRowCount = numberOrNull(disclosure.plannedRequestCount);
  const dryRun = disclosure.dryRun === true;
  const synthetic = disclosure.synthetic === true || dryRun;
  const incomplete = completion.status === "partial" ||
    manifest.rowCount !== rows.length ||
    (expectedRowCount !== null && expectedRowCount !== rows.length);
  const diagnostics: ReviewDiagnostic[] = [];
  if (git.dirty) diagnostics.push({ code: "dirty_git", message: "Run was produced from a dirty Git worktree.", severity: "warning" });
  if (dryRun) diagnostics.push({ code: "dry_run", message: "Run performed no paid model calls.", severity: "info" });
  if (synthetic) diagnostics.push({ code: "synthetic", message: "Run contains synthetic or dry-run provenance.", severity: "info" });
  if (incomplete) diagnostics.push({ code: "incomplete_run", message: "Manifest/plan row count does not match loaded rows.", severity: "warning" });
  const repetitionValues = [...new Set(rows.map((row) => row.repetition))].sort((a, b) => a - b);
  const suiteVersion = `runir-think-suite/v1-${canonicalHash({
    schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
    suiteId: manifest.suiteId,
    fixtureContentHash,
    promptTemplateHash,
    scoringContractVersion,
    parserVersion: THINK_RESPONSE_PARSER_VERSION,
    retrievalFixtureContentHash,
    retrievalMetricContractVersion,
  })}`;
  const cumulativeCostUsd = numberOrNull(completion.cumulativeCostUsd);
  return {
    schemaVersion: REVIEW_RUN_SCHEMA_VERSION,
    runId: manifest.runId,
    suiteId: manifest.suiteId,
    suiteLabel: manifest.suiteId === "runir-think-e2e" ? "Think end-to-end" : "Think fixed-evidence synthesis",
    suiteVersion,
    runKind: manifest.suiteId === "runir-think-e2e" ? "think-e2e" : "think-synthesis",
    casePresentation: manifest.suiteId === "runir-think-e2e" ? "think-e2e" : "think-synthesis",
    metricDefinitions: [...THINK_METRIC_DEFINITIONS],
    createdAt: manifest.createdAt,
    git: { sha: requiredString(git, "sha", "manifest.git"), dirty: git.dirty },
    configHash: canonicalHash({
      suiteId: manifest.suiteId,
      candidates,
      dryRun,
      maxOutputTokens: disclosure.maxOutputTokens ?? null,
      timeoutMs: disclosure.timeoutMs ?? null,
      gatewayBaseUrl: typeof disclosure.gatewayBaseUrl === "string"
        ? normalizeGatewayIdentity(disclosure.gatewayBaseUrl)
        : null,
      requests: rows.map((row) => row.effectiveRequest),
    }),
    fixtureHash: fixtureContentHash,
    sourceArtifacts: ["think-manifest", "think-rows"],
    candidates,
    cases,
    aggregates: aggregate(cases, candidates),
    provenance: {
      compatibility: "verified",
      fixtureContentHash,
      promptTemplateHash,
      scoringContractVersion,
      gitDirty: git.dirty,
      synthetic,
      dryRun,
      incomplete,
      rowCount: rows.length,
      expectedRowCount,
      completionStatus: completion.status === "partial" ? "partial" : "complete",
      stopReason: typeof completion.stopReason === "string" ? completion.stopReason : undefined,
      ...(cumulativeCostUsd !== null ? { cumulativeCostUsd } : {}),
      repetitionCount: repetitionValues.length ? Math.max(...repetitionValues) : 0,
      repetitionValues,
      candidateIds: candidates.map((candidate) => candidate.id),
    },
    diagnostics,
    rawManifest: sanitize(manifestRecord) as Record<string, unknown>,
  };
}
