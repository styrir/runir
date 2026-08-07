/** Schema version stamped into every raw result row. */
export const BENCHMARK_SCHEMA_VERSION = "runir-model-benchmark/v1";
export const RESPONSE_PARSER_VERSION = "capture-extract-json/v1";
/** Version of the human-gold scoring contract used by new manifests. */
export const SCORING_CONTRACT_VERSION = "runir-model-benchmark-scoring/v1";

export type ReasoningLevel = "none" | "low" | "medium" | "high";
export type JsonModePolicy = "required" | "best-effort" | "off";
export type ReasoningSupport = "native" | "unsupported" | "default-only";

export type Candidate = {
  /** Stable matrix key (not necessarily the wire model id). */
  id: string;
  label: string;
  /** Exact gateway model id used on the wire. */
  modelId: string;
  reasoning?: ReasoningLevel;
  /**
   * How reasoning is supported for this candidate.
   * - native: emit the configured reasoning parameter
   * - unsupported: fail closed if a non-default reasoning is requested
   * - default-only: do not claim low/none; omit reasoning params and mark provenance
   */
  reasoningSupport: ReasoningSupport;
  jsonMode: JsonModePolicy;
  /** Optional extra OpenAI-compatible body fields (never secrets). */
  extraRequestFields?: Record<string, unknown>;
  /** Price table reference (USD per 1M tokens), orientation only. */
  pricePer1M?: { input: number; output: number; asOf: string; source: string };
};

export type GoldFact = {
  id: string;
  /** Substrings that must appear in l2 (case-insensitive) for a match. */
  mustContain: string[];
  /** If any match, fact is counted as a hallucination against this gold id when unpaired. */
  category?: string;
  /** When true, gold expects abstention for the case overall (no facts). */
  required?: boolean;
};

export type BenchmarkCase = {
  id: string;
  description: string;
  family:
    | "atomic"
    | "multi-claim"
    | "correction"
    | "identifiers"
    | "negative"
    | "code"
    | "noisy"
    | "abstention"
    | "fabrication-trap"
    | "alias"
    | "malformed-risk";
  sessionTimestamp?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  gold: {
    /** Required gold facts (empty + abstain=true for abstention cases). */
    facts: GoldFact[];
    abstain: boolean;
    /** Independent claims expected (granularity). */
    independentClaimCount?: number;
  };
};

export type CliOptions = {
  models: string[];
  fixturesPath: string;
  repetitions: number;
  concurrency: number;
  timeoutMs: number;
  maxOutputTokens: number;
  conditionId?: string;
  maxTotalCostUsd?: number;
  requireCleanGit: boolean;
  allowArtifactOverwrite: boolean;
  dryRun: boolean;
  confirmCost: boolean;
  smoke: boolean;
  outRaw: string;
  outReport: string;
  baseUrl?: string;
  help: boolean;
};

export type EffectiveRequestConfig = {
  modelId: string;
  temperature: number;
  max_tokens: number;
  seed?: number;
  response_format?: { type: "json_object" };
  reasoning?: ReasoningLevel;
  reasoningParam?: Record<string, unknown>;
  notes: string[];
};

export type ParseClassification =
  | "valid"
  | "fenced"
  | "prose_prefixed"
  | "malformed"
  | "wrong_schema"
  | "empty_content";

export type ParsedExtraction = {
  classification: ParseClassification;
  schemaValid: boolean;
  facts: Array<{
    l2: string;
    l0?: string;
    l1?: string;
    confidence?: number;
    source_turn_index?: number;
    category?: string;
    tier?: string;
    tags?: string[];
  }>;
  rawTextHead: string;
  parseError?: string;
};

export type QualityScores = {
  schemaValid: boolean;
  atomicPrecision: number | null;
  atomicRecall: number | null;
  hallucinationRate: number | null;
  omissionRate: number | null;
  granularityCompliance: number | null;
  evidenceFidelity: number | null;
  abstentionCorrect: boolean | null;
  correctionHandling: number | null;
  matchedGoldIds: string[];
  unmatchedExtracted: number;
  unmatchedGold: number;
};

export type UsageCounters = {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedPromptTokens?: number;
  totalTokens?: number;
};

export type ResultRow = {
  schemaVersion: string;
  runId: string;
  timestamp: string;
  git: { sha: string; dirty: boolean };
  caseId: string;
  repetition: number;
  candidateId: string;
  candidateLabel: string;
  modelId: string;
  gatewayBaseUrl: string;
  promptHash: string;
  effectiveRequest: EffectiveRequestConfig;
  responseParserVersion: string;
  usage: UsageCounters;
  latencyMs: number;
  ttftMs: number | null;
  httpStatus?: number;
  retryCount: number;
  errorClass?: string;
  requestId?: string;
  parse: ParsedExtraction;
  quality: QualityScores;
  estimatedCostUsd: number | null;
  billedCostUsd: number | null;
};

export type PreflightDisclosure = {
  candidateModelIds: string[];
  candidates: Array<{
    id: string;
    label: string;
    modelId: string;
    reasoning?: ReasoningLevel;
    reasoningSupport: ReasoningSupport;
    effectiveNotes: string[];
  }>;
  corpusSize: number;
  smokeMode: boolean;
  repetitions: number;
  plannedRequestCount: number;
  gatewayBaseUrl: string;
  credentialSourceLabel: string;
  maxOutputTokens: number;
  timeoutMs: number;
  concurrency: number;
  conditionId?: string;
  requireCleanGit: boolean;
  allowArtifactOverwrite: boolean;
  costEstimate: {
    available: boolean;
    currency: "USD";
    /** Calibrated planning estimate, not a guaranteed ceiling. */
    estimatedTotalUsd: number | null;
    assumedPromptTokensPerRequest: number;
    assumedCompletionTokensPerRequest: number;
    maxTotalCostUsd: number | null;
    /** Legacy producer field retained only for old in-memory fixtures. */
    conservativeTotalUsd?: number | null;
    note: string;
  };
  dryRun: boolean;
  confirmCost: boolean;
};

export type RunCompletion = {
  status: "complete" | "partial";
  plannedRequestCount: number;
  completedRequestCount: number;
  cumulativeCostUsd: number;
  stopReason?:
    | "cost_cap"
    | "auth_failure"
    | "model_rejected"
    | "http_error"
    | "network_error"
    | "timeout"
    | "schema_invalid"
    | "invalid_usage"
    | "artifact_collision";
};

export type RunArtifactTargets = {
  rawPath: string;
  manifestPath: string;
  reportPath: string;
};

export type RunManifest = {
  schemaVersion: string;
  runId: string;
  createdAt: string;
  git: { sha: string; dirty: boolean };
  /** Human-selected identity for independently repeated reference conditions. */
  conditionId?: string;
  /** Additive so legacy runir-model-benchmark/v1 artifacts remain readable. */
  completion?: RunCompletion;
  /** Exact output targets used by this invocation. */
  artifactTargets?: RunArtifactTargets;
  disclosure: PreflightDisclosure;
  /** Canonical hash of fixture content, independent of its filesystem path. */
  fixtureContentHash: string;
  /** Hash of DEFAULT_CAPTURE_PROMPT before timestamp substitution. */
  promptTemplateHash: string;
  /** Versioned implementation contract for the score fields in ResultRow. */
  scoringContractVersion: string;
  /** Timestamp-specific prompt hash retained for exact run reproduction. */
  promptHash: string;
  fixturePath: string;
  rowCount: number;
};

export type AggregateMetrics = {
  candidateId: string;
  label: string;
  modelId: string;
  n: number;
  schemaValidRate: number;
  meanAtomicPrecision: number | null;
  meanAtomicRecall: number | null;
  meanHallucinationRate: number | null;
  meanOmissionRate: number | null;
  abstentionAccuracy: number | null;
  latency: {
    p50: number;
    p90: number;
    p95: number;
    mean: number;
    min: number;
    max: number;
  };
  validCompletionRate: number;
  firstAttemptSuccessRate: number;
  timeoutRate: number;
  meanOutputTokens: number | null;
  p95OutputTokens: number | null;
  meanCostPerExtraction: number | null;
  projectedCostPer1000Turns: number | null;
  costPerCorrectGoldFact: number | null;
};
