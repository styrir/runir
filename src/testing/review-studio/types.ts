export const REVIEW_RUN_SCHEMA_VERSION = "runir-review-run/v1";
export const REVIEW_COMPARISON_SCHEMA_VERSION = "runir-review-comparison/v1";

export type ReviewMetricDirection = "higher_is_better" | "lower_is_better" | "neutral";
export type ReviewMetricAssessment = "improved" | "regressed" | "unchanged" | "neutral" | "unknown";

export type ReviewMetricDefinition = {
  id: string;
  label: string;
  direction: ReviewMetricDirection;
};

export type ReviewCandidate = {
  id: string;
  label: string;
  modelId: string;
  reasoning?: string;
};

export type ReviewArtifactRef = {
  kind: "benchmark-case" | "benchmark-row" | "benchmark-manifest";
  locator: string;
};

export type ReviewDiagnostic = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  field?: string;
};

export type ReviewRawEvidence = {
  /** Sanitized complete manifest; unknown producer fields remain reachable. */
  manifest: Record<string, unknown>;
  /** Sanitized complete raw row; unknown producer fields remain reachable. */
  row: Record<string, unknown>;
  unknownManifestFields: string[];
  unknownRowFields: string[];
};

export type ReviewCaseStatus = "pass" | "fail" | "error" | "unscored";

export type ReviewCaseResult = {
  comparisonKey: string;
  caseId: string;
  repetition: number;
  candidateId: string;
  status: ReviewCaseStatus;
  metrics: Record<string, number | null>;
  inputRef: ReviewArtifactRef;
  outputRef: ReviewArtifactRef;
  diagnostics: ReviewDiagnostic[];
  rawEvidence: ReviewRawEvidence;
};

export type ReviewAggregate = {
  candidateId: string;
  label: string;
  modelId: string;
  n: number;
  metrics: Record<string, number | null>;
};

export type ReviewCompatibilityStatus = "verified" | "legacy-unverified";

export type ReviewRunProvenance = {
  compatibility: ReviewCompatibilityStatus;
  conditionId?: string;
  fixtureContentHash?: string;
  promptTemplateHash?: string;
  scoringContractVersion?: string;
  promptHash?: string;
  gitDirty: boolean;
  synthetic: boolean;
  dryRun: boolean;
  incomplete: boolean;
  rowCount: number;
  expectedRowCount: number | null;
  completionStatus?: "complete" | "partial";
  stopReason?: string;
  cumulativeCostUsd?: number;
  repetitionCount: number;
  repetitionValues: number[];
  candidateIds: string[];
};

export type ReviewRun = {
  schemaVersion: typeof REVIEW_RUN_SCHEMA_VERSION;
  runId: string;
  conditionId?: string;
  suiteId: string;
  suiteVersion: string;
  runKind: "model-benchmark";
  createdAt: string;
  git: { sha: string; dirty: boolean };
  configHash: string;
  fixtureHash?: string;
  sourceArtifacts: string[];
  candidates: ReviewCandidate[];
  cases: ReviewCaseResult[];
  aggregates: ReviewAggregate[];
  provenance: ReviewRunProvenance;
  diagnostics: ReviewDiagnostic[];
  /** Sanitized manifest for direct provenance/raw-field review. */
  rawManifest: Record<string, unknown>;
};

export type ReviewMetricDelta = {
  delta: number | null;
  assessment: ReviewMetricAssessment;
};

export type ReviewCaseDelta = {
  comparisonKey: string;
  caseId: string;
  repetition: number;
  candidateId: string;
  availability: "both" | "baseline-only" | "candidate-only";
  baseline: ReviewCaseResult | null;
  candidate: ReviewCaseResult | null;
  metrics: Record<string, ReviewMetricDelta>;
};

export type ReviewAggregateDelta = {
  candidateId: string;
  baseline: ReviewAggregate | null;
  candidate: ReviewAggregate | null;
  metrics: Record<string, ReviewMetricDelta>;
};

export type ReviewComparisonCompatibility = {
  status: "compatible" | "legacy-unverified" | "incompatible";
  pairing: "automatic" | "explicit-override";
  reasons: string[];
  warnings: string[];
};

export type ReviewComparison = {
  schemaVersion: typeof REVIEW_COMPARISON_SCHEMA_VERSION;
  baselineRunId: string;
  candidateRunId: string;
  compatibility: ReviewComparisonCompatibility;
  aggregateDeltas: ReviewAggregateDelta[];
  caseDeltas: ReviewCaseDelta[];
  diagnostics: ReviewDiagnostic[];
};

export type BenchmarkRunBundle = {
  manifest: unknown;
  rows: readonly unknown[];
  /** Optional caller label; it is not used as a compatibility identity. */
  sourceRoot?: string;
};

export type ReviewRunSet = {
  runs: ReviewRun[];
  duplicateRunIds: string[];
  diagnostics: ReviewDiagnostic[];
};
