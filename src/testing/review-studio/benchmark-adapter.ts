import {
  BENCHMARK_SCHEMA_VERSION,
  RESPONSE_PARSER_VERSION,
  type ResultRow,
} from "../model-benchmark/types.js";
import { canonicalHash, canonicalJson } from "../model-benchmark/provenance.js";
import type {
  BenchmarkRunBundle,
  ReviewAggregate,
  ReviewAggregateDelta,
  ReviewArtifactRef,
  ReviewCaseDelta,
  ReviewCaseResult,
  ReviewCandidate,
  ReviewComparison,
  ReviewComparisonCompatibility,
  ReviewDiagnostic,
  ReviewMetricAssessment,
  ReviewMetricDefinition,
  ReviewMetricDirection,
  ReviewRawEvidence,
  ReviewRun,
  ReviewRunSet,
} from "./types.js";
import {
  REVIEW_COMPARISON_SCHEMA_VERSION,
  REVIEW_RUN_SCHEMA_VERSION,
} from "./types.js";

export const MODEL_BENCHMARK_SUITE_ID = "runir-model-benchmark";

/**
 * Metrics available to the review surface. Directions are metadata, not a
 * composite score: quality, latency, and cost remain separately reviewable.
 */
export const REVIEW_METRIC_DEFINITIONS: readonly ReviewMetricDefinition[] = [
  { id: "schemaValid", label: "Schema valid", direction: "higher_is_better" },
  { id: "atomicPrecision", label: "Atomic precision", direction: "higher_is_better" },
  { id: "atomicRecall", label: "Atomic recall", direction: "higher_is_better" },
  { id: "hallucinationRate", label: "Hallucination rate", direction: "lower_is_better" },
  { id: "omissionRate", label: "Omission rate", direction: "lower_is_better" },
  { id: "granularityCompliance", label: "Granularity compliance", direction: "higher_is_better" },
  { id: "evidenceFidelity", label: "Evidence fidelity", direction: "higher_is_better" },
  { id: "abstentionCorrect", label: "Abstention correct", direction: "higher_is_better" },
  { id: "correctionHandling", label: "Correction handling", direction: "higher_is_better" },
  { id: "latencyMs", label: "Latency", direction: "lower_is_better" },
  { id: "promptTokens", label: "Prompt tokens", direction: "lower_is_better" },
  { id: "completionTokens", label: "Completion tokens", direction: "lower_is_better" },
  { id: "totalTokens", label: "Total tokens", direction: "lower_is_better" },
  { id: "estimatedCostUsd", label: "Estimated cost", direction: "lower_is_better" },
  { id: "billedCostUsd", label: "Billed cost", direction: "lower_is_better" },
  { id: "schemaValidRate", label: "Schema-valid rate", direction: "higher_is_better" },
  { id: "meanAtomicPrecision", label: "Mean atomic precision", direction: "higher_is_better" },
  { id: "meanAtomicRecall", label: "Mean atomic recall", direction: "higher_is_better" },
  { id: "meanHallucinationRate", label: "Mean hallucination rate", direction: "lower_is_better" },
  { id: "meanOmissionRate", label: "Mean omission rate", direction: "lower_is_better" },
  { id: "abstentionAccuracy", label: "Abstention accuracy", direction: "higher_is_better" },
  { id: "p50LatencyMs", label: "p50 latency", direction: "lower_is_better" },
  { id: "p95LatencyMs", label: "p95 latency", direction: "lower_is_better" },
  { id: "meanLatencyMs", label: "Mean latency", direction: "lower_is_better" },
  { id: "validCompletionRate", label: "Valid completion rate", direction: "higher_is_better" },
  { id: "firstAttemptSuccessRate", label: "First-attempt success rate", direction: "higher_is_better" },
  { id: "timeoutRate", label: "Timeout rate", direction: "lower_is_better" },
  { id: "meanOutputTokens", label: "Mean output tokens", direction: "lower_is_better" },
  { id: "p95OutputTokens", label: "p95 output tokens", direction: "lower_is_better" },
  { id: "meanCostPerExtraction", label: "Mean cost per extraction", direction: "lower_is_better" },
  { id: "projectedCostPer1000Turns", label: "Projected cost per 1,000 turns", direction: "lower_is_better" },
  { id: "costPerCorrectGoldFact", label: "Cost per correct gold fact", direction: "lower_is_better" },
];

const METRIC_BY_ID = new Map(REVIEW_METRIC_DEFINITIONS.map((metric) => [metric.id, metric]));

const KNOWN_MANIFEST_FIELDS = new Set([
  "schemaVersion",
  "runId",
  "createdAt",
  "git",
  "conditionId",
  "completion",
  "artifactTargets",
  "disclosure",
  "fixtureContentHash",
  "promptTemplateHash",
  "scoringContractVersion",
  "promptHash",
  "fixturePath",
  "rowCount",
]);

const KNOWN_ROW_FIELDS = new Set([
  "schemaVersion",
  "runId",
  "timestamp",
  "git",
  "caseId",
  "repetition",
  "candidateId",
  "candidateLabel",
  "modelId",
  "gatewayBaseUrl",
  "promptHash",
  "effectiveRequest",
  "responseParserVersion",
  "usage",
  "latencyMs",
  "ttftMs",
  "httpStatus",
  "retryCount",
  "errorClass",
  "requestId",
  "parse",
  "quality",
  "estimatedCostUsd",
  "billedCostUsd",
]);

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|bearer|credential|password|secret|^token$)/i;
const PATH_KEY_PATTERN = /(?:path|file|filename|directory|cwd|root)$/i;

export type ReviewAdapterErrorCode =
  | "invalid_bundle"
  | "unsupported_schema"
  | "invalid_provenance"
  | "duplicate_comparison_key"
  | "incompatible_runs";

export class ReviewAdapterError extends Error {
  constructor(
    public readonly code: ReviewAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewAdapterError";
  }
}

export class ReviewCompatibilityError extends ReviewAdapterError {
  constructor(public readonly compatibility: ReviewComparisonCompatibility) {
    super(
      "incompatible_runs",
      `Review comparison refused: ${compatibility.reasons.join("; ") || "compatibility is unverified"}`,
    );
    this.name = "ReviewCompatibilityError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ReviewAdapterError("invalid_bundle", `${label} must be an object`);
  }
  return value;
}

function requiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ReviewAdapterError("invalid_bundle", `${label}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return value === undefined ? undefined : typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReviewAdapterError("invalid_bundle", `${label} must be a finite number`);
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hashString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new ReviewAdapterError("invalid_provenance", `${label} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function unknownFields(source: Record<string, unknown>, known: Set<string>): string[] {
  return Object.keys(source).filter((key) => !known.has(key)).sort();
}

function sanitizeEvidence(value: unknown, key = ""): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (PATH_KEY_PATTERN.test(key) || key === "fixturePath" || key === "sourceRoot") {
      return "[REDACTED_PATH]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeEvidence(entry, key));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = sanitizeEvidence(childValue, childKey);
    }
    return out;
  }
  return value;
}

function sanitizedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeEvidence(value) as Record<string, unknown>;
}

function normalizeGatewayIdentity(value: string): string {
  try {
    const url = new URL(value);
    // Deliberately omit userinfo, query, and fragment. A gateway identity is
    // useful for compatibility, but credentials and request-specific data are
    // not part of a provenance hash.
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return value.replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

function effectiveRequestForHash(value: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "modelId",
    "apiStyle",
    "endpoint",
    "temperature",
    "max_tokens",
    "seed",
    "response_format",
    "textFormat",
    "reasoning",
    "reasoningParam",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

function buildConfigHash(
  manifest: Record<string, unknown>,
  rows: readonly ResultRow[],
  dryRun: boolean,
): string {
  const disclosure = isRecord(manifest.disclosure) ? manifest.disclosure : {};
  const candidateConfigs = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of rows) {
    const variants = candidateConfigs.get(row.candidateId) ?? new Map<string, Record<string, unknown>>();
    const request = effectiveRequestForHash(record(row.effectiveRequest, `row ${row.caseId}.effectiveRequest`));
    variants.set(canonicalJson(request), request);
    candidateConfigs.set(row.candidateId, variants);
  }

  const disclosureCandidates = Array.isArray(disclosure.candidates) ? disclosure.candidates : [];
  const candidates = [...candidateConfigs.keys()]
    .sort()
    .map((candidateId) => {
      const disclosureCandidate = disclosureCandidates
        .map((entry) => (isRecord(entry) ? entry : null))
        .find((entry) => entry?.id === candidateId);
      const row = rows.find((entry) => entry.candidateId === candidateId)!;
      return {
        id: candidateId,
        modelId: row.modelId,
        reasoning: disclosureCandidate?.reasoning ?? row.effectiveRequest.reasoning ?? null,
        reasoningSupport: disclosureCandidate?.reasoningSupport ?? null,
        requestVariants: [...candidateConfigs.get(candidateId)!.values()].sort((a, b) =>
          canonicalJson(a).localeCompare(canonicalJson(b)),
        ),
      };
    });

  const gatewayIdentities = [
    ...new Set(rows.map((row) => normalizeGatewayIdentity(row.gatewayBaseUrl))),
  ].sort();
  return canonicalHash({
    benchmarkSchemaVersion: BENCHMARK_SCHEMA_VERSION,
    candidates,
    smokeMode: disclosure.smokeMode === true,
    repetitions: typeof disclosure.repetitions === "number" ? disclosure.repetitions : null,
    maxOutputTokens:
      typeof disclosure.maxOutputTokens === "number" ? disclosure.maxOutputTokens : null,
    timeoutMs: typeof disclosure.timeoutMs === "number" ? disclosure.timeoutMs : null,
    concurrency: typeof disclosure.concurrency === "number" ? disclosure.concurrency : null,
    dryRun,
    gatewayIdentities,
  });
}

function suiteVersionFor(args: {
  fixtureContentHash?: string;
  promptTemplateHash?: string;
  scoringContractVersion?: string;
  parserVersions: string[];
}): string {
  if (!args.fixtureContentHash || !args.promptTemplateHash || !args.scoringContractVersion) {
    return "legacy-unverified";
  }
  return `runir-model-benchmark-suite/v1-${canonicalHash({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    fixtureContentHash: args.fixtureContentHash,
    promptTemplateHash: args.promptTemplateHash,
    parserVersions: args.parserVersions,
    scoringContractVersion: args.scoringContractVersion,
  })}`;
}

export function buildComparisonKey(args: {
  caseId: string;
  candidateId: string;
  repetition: number;
}): string {
  // JSON tuple encoding is stable and unambiguous even when producer IDs
  // contain punctuation. Display labels/text never participate.
  return canonicalJson([args.caseId, args.candidateId, args.repetition]);
}

function metricValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowMetrics(row: ResultRow): Record<string, number | null> {
  const quality = record(row.quality, `row ${row.caseId}.quality`);
  const usage = record(row.usage, `row ${row.caseId}.usage`);
  return {
    schemaValid: quality.schemaValid === true ? 1 : 0,
    atomicPrecision: metricValue(quality.atomicPrecision),
    atomicRecall: metricValue(quality.atomicRecall),
    hallucinationRate: metricValue(quality.hallucinationRate),
    omissionRate: metricValue(quality.omissionRate),
    granularityCompliance: metricValue(quality.granularityCompliance),
    evidenceFidelity: metricValue(quality.evidenceFidelity),
    abstentionCorrect:
      typeof quality.abstentionCorrect === "boolean" ? (quality.abstentionCorrect ? 1 : 0) : null,
    correctionHandling: metricValue(quality.correctionHandling),
    latencyMs: metricValue(row.latencyMs),
    promptTokens: metricValue(usage.promptTokens),
    completionTokens: metricValue(usage.completionTokens),
    totalTokens: metricValue(usage.totalTokens),
    estimatedCostUsd: metricValue(row.estimatedCostUsd),
    billedCostUsd: metricValue(row.billedCostUsd),
  };
}

function caseStatus(row: ResultRow, metrics: Record<string, number | null>): ReviewCaseResult["status"] {
  if (row.errorClass) return "error";
  const quality = record(row.quality, `row ${row.caseId}.quality`);
  const hasScoredValue = Object.entries(metrics).some(
    ([key, value]) => !key.startsWith("_") && key !== "schemaValid" && value !== null,
  );
  if (!hasScoredValue) return "unscored";
  if (
    metrics.schemaValid === 0 ||
    (metrics.hallucinationRate !== null && metrics.hallucinationRate > 0) ||
    (metrics.omissionRate !== null && metrics.omissionRate > 0) ||
    quality.abstentionCorrect === false
  ) {
    return "fail";
  }
  return "pass";
}

function rowDiagnostics(row: ResultRow): ReviewDiagnostic[] {
  const diagnostics: ReviewDiagnostic[] = [];
  if (row.errorClass) {
    diagnostics.push({
      code: row.errorClass,
      message: `Producer recorded ${row.errorClass}`,
      severity: "error",
      field: "errorClass",
    });
  }
  const parseError = isRecord(row.parse) ? optionalString(row.parse, "parseError") : undefined;
  if (parseError) {
    diagnostics.push({ code: "parse_error", message: parseError, severity: "warning", field: "parse.parseError" });
  }
  if (row.retryCount > 0) {
    diagnostics.push({
      code: "retried",
      message: `Producer retried this request ${row.retryCount} time(s)`,
      severity: "warning",
      field: "retryCount",
    });
  }
  return diagnostics;
}

function artifactRef(kind: ReviewArtifactRef["kind"], locator: string): ReviewArtifactRef {
  return { kind, locator };
}

function adaptCase(row: ResultRow, manifest: Record<string, unknown>): ReviewCaseResult {
  const comparisonKey = buildComparisonKey({
    caseId: row.caseId,
    candidateId: row.candidateId,
    repetition: row.repetition,
  });
  const metrics = rowMetrics(row);
  const rawEvidence: ReviewRawEvidence = {
    manifest: sanitizedRecord(manifest),
    row: sanitizedRecord(row as unknown as Record<string, unknown>),
    unknownManifestFields: unknownFields(manifest, KNOWN_MANIFEST_FIELDS),
    unknownRowFields: unknownFields(row as unknown as Record<string, unknown>, KNOWN_ROW_FIELDS),
  };
  return {
    comparisonKey,
    caseId: row.caseId,
    repetition: row.repetition,
    candidateId: row.candidateId,
    status: caseStatus(row, metrics),
    metrics,
    inputRef: artifactRef("benchmark-case", encodeURIComponent(row.caseId)),
    outputRef: artifactRef("benchmark-row", encodeURIComponent(comparisonKey)),
    diagnostics: rowDiagnostics(row),
    rawEvidence,
  };
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (1 - (rank - lo)) + sorted[hi]! * (rank - lo);
}

function aggregateCases(cases: ReviewCaseResult[], candidates: ReviewCandidate[]): ReviewAggregate[] {
  const byCandidate = new Map<string, ReviewCaseResult[]>();
  for (const item of cases) {
    const group = byCandidate.get(item.candidateId) ?? [];
    group.push(item);
    byCandidate.set(item.candidateId, group);
  }
  const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return [...byCandidate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([candidateId, group]) => {
      const rows = group.map((item) => item.rawEvidence.row as unknown as ResultRow);
      const latencies = rows.map((row) => row.latencyMs).filter(Number.isFinite);
      const outputTokens = rows
        .map((row) => optionalNumber(record(row.usage, "usage").completionTokens))
        .filter((value): value is number => value !== null);
      const costs = rows
        .map((row) => optionalNumber(row.billedCostUsd) ?? optionalNumber(row.estimatedCostUsd))
        .filter((value): value is number => value !== null && value >= 0);
      const completed = rows.filter((row) => !row.errorClass);
      const firstAttempt = rows.filter((row) => !row.errorClass && row.retryCount === 0);
      const timeouts = rows.filter((row) => row.errorClass === "timeout");
      const quality = rows.map((row) => record(row.quality, "quality"));
      const matchedGold = quality.reduce((sum, value) => {
        const ids = Array.isArray(value.matchedGoldIds) ? value.matchedGoldIds : [];
        return sum + ids.length;
      }, 0);
      const totalCost = costs.reduce((sum, value) => sum + value, 0);
      const label = candidateMap.get(candidateId)?.label ?? rows[0]?.candidateLabel ?? candidateId;
      const modelId = candidateMap.get(candidateId)?.modelId ?? rows[0]?.modelId ?? "unknown";
      return {
        candidateId,
        label,
        modelId,
        n: group.length,
        metrics: {
          schemaValidRate: mean(group.map((item) => item.metrics.schemaValid)),
          meanAtomicPrecision: mean(group.map((item) => item.metrics.atomicPrecision)),
          meanAtomicRecall: mean(group.map((item) => item.metrics.atomicRecall)),
          meanHallucinationRate: mean(group.map((item) => item.metrics.hallucinationRate)),
          meanOmissionRate: mean(group.map((item) => item.metrics.omissionRate)),
          abstentionAccuracy: mean(group.map((item) => item.metrics.abstentionCorrect)),
          p50LatencyMs: percentile(latencies, 50),
          p95LatencyMs: percentile(latencies, 95),
          meanLatencyMs: mean(latencies),
          validCompletionRate: group.length ? completed.length / group.length : null,
          firstAttemptSuccessRate: group.length ? firstAttempt.length / group.length : null,
          timeoutRate: group.length ? timeouts.length / group.length : null,
          meanOutputTokens: mean(outputTokens),
          p95OutputTokens: percentile(outputTokens, 95),
          meanCostPerExtraction: mean(costs),
          projectedCostPer1000Turns: costs.length ? (totalCost / costs.length) * 1000 : null,
          costPerCorrectGoldFact: matchedGold > 0 && costs.length ? totalCost / matchedGold : null,
        },
      };
    });
}

function parseManifestAndRows(
  manifestInput: unknown,
  rowsInput: readonly unknown[],
): { manifest: Record<string, unknown>; rows: ResultRow[] } {
  if (!Array.isArray(rowsInput)) {
    throw new ReviewAdapterError("invalid_bundle", "rows must be an array");
  }
  const manifest = record(manifestInput, "manifest");
  const schemaVersion = requiredString(manifest, "schemaVersion", "manifest");
  if (schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new ReviewAdapterError(
      "unsupported_schema",
      `Unsupported benchmark manifest schema ${schemaVersion}; expected ${BENCHMARK_SCHEMA_VERSION}`,
    );
  }
  const runId = requiredString(manifest, "runId", "manifest");
  const rows = rowsInput.map((input, index) => {
    const row = record(input, `rows[${index}]`);
    const rowSchema = requiredString(row, "schemaVersion", `rows[${index}]`);
    if (rowSchema !== BENCHMARK_SCHEMA_VERSION) {
      throw new ReviewAdapterError(
        "unsupported_schema",
        `Unsupported benchmark row schema ${rowSchema}; expected ${BENCHMARK_SCHEMA_VERSION}`,
      );
    }
    if (requiredString(row, "runId", `rows[${index}]`) !== runId) {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].runId does not match manifest.runId`);
    }
    requiredString(row, "caseId", `rows[${index}]`);
    requiredString(row, "candidateId", `rows[${index}]`);
    requiredString(row, "candidateLabel", `rows[${index}]`);
    requiredString(row, "modelId", `rows[${index}]`);
    requiredString(row, "gatewayBaseUrl", `rows[${index}]`);
    requiredString(row, "promptHash", `rows[${index}]`);
    requiredString(row, "responseParserVersion", `rows[${index}]`);
    requiredString(row, "timestamp", `rows[${index}]`);
    const repetition = finiteNumber(row.repetition, `rows[${index}].repetition`);
    if (!Number.isInteger(repetition) || repetition < 1) {
      throw new ReviewAdapterError("invalid_bundle", `rows[${index}].repetition must be a positive integer`);
    }
    finiteNumber(row.latencyMs, `rows[${index}].latencyMs`);
    finiteNumber(row.retryCount, `rows[${index}].retryCount`);
    record(row.effectiveRequest, `rows[${index}].effectiveRequest`);
    record(row.usage, `rows[${index}].usage`);
    record(row.parse, `rows[${index}].parse`);
    record(row.quality, `rows[${index}].quality`);
    return row as unknown as ResultRow;
  });
  return { manifest, rows };
}

export function adaptBenchmarkRun(bundle: BenchmarkRunBundle): ReviewRun {
  const { manifest, rows } = parseManifestAndRows(bundle.manifest, bundle.rows);
  const runId = requiredString(manifest, "runId", "manifest");
  const git = record(manifest.git, "manifest.git");
  const gitSha = requiredString(git, "sha", "manifest.git");
  if (typeof git.dirty !== "boolean") {
    throw new ReviewAdapterError("invalid_bundle", "manifest.git.dirty must be boolean");
  }
  const disclosure = record(manifest.disclosure, "manifest.disclosure");
  const fixtureContentHash = hashString(manifest.fixtureContentHash, "manifest.fixtureContentHash");
  const promptTemplateHash = hashString(manifest.promptTemplateHash, "manifest.promptTemplateHash");
  if (manifest.scoringContractVersion !== undefined && typeof manifest.scoringContractVersion !== "string") {
    throw new ReviewAdapterError("invalid_provenance", "manifest.scoringContractVersion must be a string");
  }
  const scoringContractVersion = optionalString(manifest, "scoringContractVersion");
  const promptHash = optionalString(manifest, "promptHash");
  const conditionId = optionalString(manifest, "conditionId");
  if (manifest.conditionId !== undefined && conditionId === undefined) {
    throw new ReviewAdapterError("invalid_provenance", "manifest.conditionId must be a string");
  }
  const completion = manifest.completion === undefined
    ? undefined
    : record(manifest.completion, "manifest.completion");
  const completionStatus =
    completion?.status === "complete" || completion?.status === "partial"
      ? completion.status
      : undefined;
  if (completion !== undefined && completionStatus === undefined) {
    throw new ReviewAdapterError(
      "invalid_provenance",
      "manifest.completion.status must be complete or partial",
    );
  }
  const stopReason = completion ? optionalString(completion, "stopReason") : undefined;
  const cumulativeCost = completion
    ? optionalNumber(completion.cumulativeCostUsd)
    : null;
  if (
    completion?.cumulativeCostUsd !== undefined &&
    (cumulativeCost === null || cumulativeCost < 0)
  ) {
    throw new ReviewAdapterError(
      "invalid_provenance",
      "manifest.completion.cumulativeCostUsd must be a non-negative finite number",
    );
  }
  const compatibility: ReviewRun["provenance"]["compatibility"] =
    fixtureContentHash && promptTemplateHash && scoringContractVersion ? "verified" : "legacy-unverified";
  const runCases = rows.map((row) => adaptCase(row, manifest));
  const keys = new Set<string>();
  for (const item of runCases) {
    if (keys.has(item.comparisonKey)) {
      throw new ReviewAdapterError(
        "duplicate_comparison_key",
        `Duplicate comparison key in run ${runId}: ${item.comparisonKey}`,
      );
    }
    keys.add(item.comparisonKey);
  }

  const candidatesById = new Map<string, ReviewCandidate>();
  for (const row of rows) {
    if (!candidatesById.has(row.candidateId)) {
      candidatesById.set(row.candidateId, {
        id: row.candidateId,
        label: row.candidateLabel,
        modelId: row.modelId,
        reasoning: typeof row.effectiveRequest.reasoning === "string" ? row.effectiveRequest.reasoning : undefined,
      });
    }
  }
  // The manifest disclosure is the configured matrix. Retain declared
  // candidates even when a partial run produced no row for one of them so a
  // comparison cannot silently turn a candidate failure into a missing set.
  if (Array.isArray(disclosure.candidates)) {
    for (const entry of disclosure.candidates) {
      if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
      if (candidatesById.has(entry.id)) continue;
      candidatesById.set(entry.id, {
        id: entry.id,
        label: typeof entry.label === "string" ? entry.label : entry.id,
        modelId: typeof entry.modelId === "string" ? entry.modelId : "unknown",
        reasoning: typeof entry.reasoning === "string" ? entry.reasoning : undefined,
      });
    }
  }
  const candidates = [...candidatesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const candidateIds = candidates.map((candidate) => candidate.id);
  const parserVersions = [...new Set(rows.map((row) => row.responseParserVersion))].sort();
  const dryRun =
    disclosure.dryRun === true ||
    runId.startsWith("dry-") ||
    rows.some((row) => row.errorClass === "dry_run");
  const synthetic =
    disclosure.synthetic === true ||
    runId.startsWith("synthetic-") ||
    rows.some((row) => row.errorClass === "synthetic") ||
    dryRun;
  const expectedRowCount =
    typeof disclosure.plannedRequestCount === "number" && Number.isFinite(disclosure.plannedRequestCount)
      ? disclosure.plannedRequestCount
      : null;
  const manifestRowCount = optionalNumber(manifest.rowCount);
  const incomplete =
    completionStatus === "partial" ||
    (manifestRowCount !== null && manifestRowCount !== rows.length) ||
    (expectedRowCount !== null && expectedRowCount !== rows.length);
  const repetitionCount = rows.reduce((max, row) => Math.max(max, row.repetition), 0);
  const repetitionValues = [...new Set(rows.map((row) => row.repetition))].sort((a, b) => a - b);
  const diagnostics: ReviewDiagnostic[] = [];
  if (compatibility === "legacy-unverified") {
    diagnostics.push({
      code: "legacy_unverified_compatibility",
      message: "Manifest lacks additive fixture/template/scoring provenance; pairing requires explicit human approval.",
      severity: "warning",
    });
  }
  if (git.dirty === true) {
    diagnostics.push({ code: "dirty_git", message: "Run was produced from a dirty Git worktree.", severity: "warning" });
  }
  if (dryRun) {
    diagnostics.push({ code: "dry_run", message: "Run performed no paid model calls.", severity: "info" });
  }
  if (synthetic) {
    diagnostics.push({ code: "synthetic", message: "Run contains synthetic or dry-run provenance.", severity: "info" });
  }
  if (incomplete) {
    diagnostics.push({
      code: "incomplete_run",
      message: `Manifest/plan row count does not match loaded rows (${rows.length}).`,
      severity: "warning",
    });
  }
  if (completionStatus === "partial") {
    diagnostics.push({
      code: stopReason === "cost_cap" ? "cost_cap_stop" : "partial_run",
      message: stopReason
        ? `Producer stopped the run early: ${stopReason}.`
        : "Producer marked the run partial.",
      severity: "warning",
      field: "completion.status",
    });
  }
  if (parserVersions.length !== 1 || (parserVersions[0] !== RESPONSE_PARSER_VERSION && compatibility === "verified")) {
    diagnostics.push({
      code: "parser_version_variance",
      message: `Rows carry parser versions: ${parserVersions.join(", ") || "none"}.`,
      severity: "warning",
      field: "responseParserVersion",
    });
  }

  const suiteVersion = suiteVersionFor({
    fixtureContentHash,
    promptTemplateHash,
    scoringContractVersion,
    parserVersions,
  });
  const aggregates = aggregateCases(runCases, candidates);
  return {
    schemaVersion: REVIEW_RUN_SCHEMA_VERSION,
    runId,
    conditionId,
    suiteId: MODEL_BENCHMARK_SUITE_ID,
    suiteVersion,
    runKind: "model-benchmark",
    createdAt: requiredString(manifest, "createdAt", "manifest"),
    git: { sha: gitSha, dirty: git.dirty },
    configHash: buildConfigHash(manifest, rows, dryRun),
    fixtureHash: fixtureContentHash,
    sourceArtifacts: ["benchmark-manifest", "benchmark-rows"],
    candidates,
    cases: runCases,
    aggregates,
    provenance: {
      compatibility,
      conditionId,
      fixtureContentHash,
      promptTemplateHash,
      scoringContractVersion,
      promptHash,
      gitDirty: git.dirty,
      synthetic,
      dryRun,
      incomplete,
      rowCount: rows.length,
      expectedRowCount,
      completionStatus,
      stopReason,
      ...(cumulativeCost !== null ? { cumulativeCostUsd: cumulativeCost } : {}),
      repetitionCount,
      repetitionValues,
      candidateIds,
    },
    diagnostics,
    rawManifest: sanitizedRecord(manifest),
  };
}

export const adaptModelBenchmarkRun = adaptBenchmarkRun;

function runIdFromInput(input: string | { runId: string } | BenchmarkRunBundle): string | undefined {
  if (typeof input === "string") return input;
  if ("runId" in input && typeof input.runId === "string") return input.runId;
  if ("manifest" in input && isRecord(input.manifest) && typeof input.manifest.runId === "string") {
    return input.manifest.runId;
  }
  return undefined;
}

/** Detect duplicate run IDs without silently overwriting an artifact root. */
export function detectDuplicateRunIds(
  inputs: readonly (string | { runId: string } | BenchmarkRunBundle)[],
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const input of inputs) {
    const runId = runIdFromInput(input);
    if (!runId) continue;
    if (seen.has(runId)) duplicates.add(runId);
    seen.add(runId);
  }
  return [...duplicates].sort();
}

export function adaptBenchmarkRuns(bundles: readonly BenchmarkRunBundle[]): ReviewRunSet {
  const duplicateRunIds = detectDuplicateRunIds(bundles);
  const diagnostics: ReviewDiagnostic[] = duplicateRunIds.map((runId) => ({
    code: "duplicate_run_id",
    message: `Duplicate runId ${runId} found across artifact roots; no bundle was discarded.`,
    severity: "error",
    field: "runId",
  }));
  return {
    runs: bundles.map((bundle) => adaptBenchmarkRun(bundle)),
    duplicateRunIds,
    diagnostics,
  };
}

function directionFor(metricId: string): ReviewMetricDirection {
  return METRIC_BY_ID.get(metricId)?.direction ?? "neutral";
}

function assessDelta(delta: number | null, direction: ReviewMetricDirection): ReviewMetricAssessment {
  if (delta === null || !Number.isFinite(delta)) return "unknown";
  if (direction === "neutral") return "neutral";
  if (delta === 0) return "unchanged";
  if (direction === "higher_is_better") return delta > 0 ? "improved" : "regressed";
  return delta < 0 ? "improved" : "regressed";
}

function metricDelta(
  baseline: number | null | undefined,
  candidate: number | null | undefined,
  metricId: string,
): { delta: number | null; assessment: ReviewMetricAssessment } {
  const delta =
    typeof baseline === "number" && typeof candidate === "number" && Number.isFinite(baseline) && Number.isFinite(candidate)
      ? candidate - baseline
      : null;
  return { delta, assessment: assessDelta(delta, directionFor(metricId)) };
}

function sortedMetricIds(values: Array<Record<string, number | null>>): string[] {
  const ids = new Set<string>();
  for (const value of values) for (const key of Object.keys(value)) ids.add(key);
  return [...ids].sort();
}

function aggregateDelta(
  baseline: ReviewAggregate | null,
  candidate: ReviewAggregate | null,
): ReviewAggregateDelta {
  const metricIds = sortedMetricIds([
    baseline?.metrics ?? {},
    candidate?.metrics ?? {},
  ]);
  return {
    candidateId: candidate?.candidateId ?? baseline?.candidateId ?? "unknown",
    baseline,
    candidate,
    metrics: Object.fromEntries(
      metricIds.map((metricId) => [
        metricId,
        metricDelta(baseline?.metrics[metricId], candidate?.metrics[metricId], metricId),
      ]),
    ),
  };
}

function caseDelta(baseline: ReviewCaseResult | null, candidate: ReviewCaseResult | null): ReviewCaseDelta {
  const source = baseline ?? candidate!;
  const metricIds = sortedMetricIds([
    baseline?.metrics ?? {},
    candidate?.metrics ?? {},
  ]);
  return {
    comparisonKey: source.comparisonKey,
    caseId: source.caseId,
    repetition: source.repetition,
    candidateId: source.candidateId,
    availability: baseline && candidate ? "both" : baseline ? "baseline-only" : "candidate-only",
    baseline,
    candidate,
    metrics: Object.fromEntries(
      metricIds.map((metricId) => [
        metricId,
        metricDelta(baseline?.metrics[metricId], candidate?.metrics[metricId], metricId),
      ]),
    ),
  };
}

export function assessReviewCompatibility(
  baseline: ReviewRun,
  candidate: ReviewRun,
): ReviewComparisonCompatibility {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (baseline.suiteId !== candidate.suiteId) {
    reasons.push(`suiteId differs (${baseline.suiteId} vs ${candidate.suiteId})`);
  }
  if (baseline.suiteVersion !== candidate.suiteVersion) {
    reasons.push("suiteVersion differs; fixture, prompt, parser, or scoring provenance changed");
  }
  if (baseline.provenance.compatibility === "legacy-unverified" || candidate.provenance.compatibility === "legacy-unverified") {
    warnings.push("one or both runs lack additive compatibility provenance");
  }
  if (baseline.configHash !== candidate.configHash) {
    warnings.push("run configuration differs; compare shared cases with configuration variance visible");
  }
  if (
    baseline.provenance.repetitionCount !== candidate.provenance.repetitionCount ||
    canonicalJson(baseline.provenance.repetitionValues) !== canonicalJson(candidate.provenance.repetitionValues)
  ) {
    const repetitionMessage =
      baseline.provenance.repetitionCount !== candidate.provenance.repetitionCount
        ? `repetition count differs (${baseline.provenance.repetitionCount} vs ${candidate.provenance.repetitionCount})`
        : `repetition values differ (${baseline.provenance.repetitionValues.join(",") || "none"} vs ${candidate.provenance.repetitionValues.join(",") || "none"})`;
    warnings.push(
      repetitionMessage,
    );
  }
  const baselineCandidates = new Set(baseline.provenance.candidateIds);
  const candidateCandidates = new Set(candidate.provenance.candidateIds);
  if (
    baselineCandidates.size !== candidateCandidates.size ||
    [...baselineCandidates].some((id) => !candidateCandidates.has(id))
  ) {
    warnings.push("candidate set differs; missing candidate rows remain explicit in the comparison");
  }
  const status = reasons.length
    ? "incompatible"
    : baseline.provenance.compatibility === "verified" && candidate.provenance.compatibility === "verified"
      ? "compatible"
      : "legacy-unverified";
  return { status, pairing: "automatic", reasons, warnings };
}

export type CompareReviewRunsOptions = {
  /** Explicit human pairing of legacy artifacts lacking compatibility hashes. */
  allowUnverifiedPairing?: boolean;
  /** Deliberate override for a suite mismatch; the result remains marked. */
  allowIncompatible?: boolean;
};

export function compareReviewRuns(
  baseline: ReviewRun,
  candidate: ReviewRun,
  options: CompareReviewRunsOptions = {},
): ReviewComparison {
  const assessed = assessReviewCompatibility(baseline, candidate);
  const explicitOverride = options.allowIncompatible === true || options.allowUnverifiedPairing === true;
  if (assessed.status === "incompatible" && !options.allowIncompatible) {
    throw new ReviewCompatibilityError(assessed);
  }
  if (assessed.status === "legacy-unverified" && !options.allowUnverifiedPairing && !options.allowIncompatible) {
    throw new ReviewCompatibilityError(assessed);
  }
  const compatibility: ReviewComparisonCompatibility = {
    ...assessed,
    pairing: explicitOverride ? "explicit-override" : "automatic",
  };

  const baselineAggregates = new Map(baseline.aggregates.map((aggregate) => [aggregate.candidateId, aggregate]));
  const candidateAggregates = new Map(candidate.aggregates.map((aggregate) => [aggregate.candidateId, aggregate]));
  const aggregateIds = [...new Set([...baselineAggregates.keys(), ...candidateAggregates.keys()])].sort();
  const baselineCases = new Map(baseline.cases.map((item) => [item.comparisonKey, item]));
  const candidateCases = new Map(candidate.cases.map((item) => [item.comparisonKey, item]));
  const caseKeys = [...new Set([...baselineCases.keys(), ...candidateCases.keys()])].sort();
  const diagnostics: ReviewDiagnostic[] = compatibility.warnings.map((message) => ({
    code: message.startsWith("repetition") ? "repetition_mismatch" : message.startsWith("candidate") ? "candidate_set_mismatch" : "configuration_mismatch",
    message,
    severity: "warning",
  }));
  if (explicitOverride) {
    diagnostics.push({
      code: "explicit_pairing_override",
      message: "Human explicitly requested comparison despite unverified or incompatible provenance.",
      severity: "warning",
    });
  }
  return {
    schemaVersion: REVIEW_COMPARISON_SCHEMA_VERSION,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    compatibility,
    aggregateDeltas: aggregateIds.map((id) => aggregateDelta(baselineAggregates.get(id) ?? null, candidateAggregates.get(id) ?? null)),
    caseDeltas: caseKeys.map((key) => caseDelta(baselineCases.get(key) ?? null, candidateCases.get(key) ?? null)),
    diagnostics,
  };
}

export const compareRuns = compareReviewRuns;

export function rawEvidenceFor(run: ReviewRun, comparisonKey: string): ReviewRawEvidence | undefined {
  return run.cases.find((item) => item.comparisonKey === comparisonKey)?.rawEvidence;
}
