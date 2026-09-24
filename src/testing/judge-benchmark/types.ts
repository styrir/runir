export const JUDGE_BENCHMARK_SCHEMA_VERSION = "runir-judge-benchmark/v1";
export const JUDGE_SCORING_CONTRACT_VERSION = "runir-judge-scoring/v1";
export const JUDGE_TASK_ID = "supersession-pair/v1";

export const JEV_MODEL_ID = "typesafe/jev-1.13.0";
export const REQUESTY_DECISIONS_BASE_URL = "https://router.requesty.ai/v1";
export const PRODUCTION_DUPLICATE_FLOOR = 0.6;
export const NOUL_DEFAULT_THRESHOLD = 0.5;
export const CHOICE_DEFAULT_THRESHOLD = 0.5;

export const HARM_WILSON_GATE = 0.1;
export const UNDERPOWERED_N = 35;
export const INVALID_ERROR_RATE = 0.02;
export const ECE_BIN_COUNT = 10;
export const WILSON_Z = 1.959963984540054;

export type GoldLabel = "supersede" | "duplicate" | "independent";
export type Decision = "retire" | "duplicate" | "keep" | "error";
export type EffectiveDecision = "retire" | "duplicate" | "keep";
export type PairDirection = "forward" | "swapped";
export type JudgeSplit = "calibration" | "test" | "insample" | "heldout";
export type JudgePopulation = "probability" | "challenge" | "shadow" | "legacy";
export type JudgeFrame = "diverged" | "control" | "heldout";
export type GoldResolution =
  | "agreed"
  | "reconciled"
  | "disagreement_defaulted_over"
  | "reconciled_content_verified"
  /** Both labelers agreed, and orchestrator review repaired the label (see gold-audit log). */
  | "agreed_repaired";
export type SpotCheckVerdict = "confirmed" | "repaired" | "rejected";
export type CandidateId =
  | "judge-v2"
  | "judge-v3"
  | "jev-noul-v1"
  | "jev-choice-v1"
  | "jev-noul-v2"
  | "jev-noul-v3";
export type CandidateFamily = "judge" | "noul" | "choice";
export type ThresholdSource = "fitted" | "no_qualifying_threshold";
export type GateStatus = "pass" | "fail" | "invalid" | "descriptive" | "underpowered";
export type OutcomeId =
  | "update_landed"
  | "correction_dropped"
  | "missed_update"
  | "duplicate_as_retire"
  | "duplicate_as_duplicate"
  | "redundant_row"
  | "wrong_retirement"
  | "wrong_skip"
  | "correct_keep";

export type MemoryRef = {
  source: string;
  id: string;
  sha256: string;
  createdAt: string;
};

export type JudgeGold = {
  label: GoldLabel;
  labelA: GoldLabel;
  labelB: GoldLabel;
  resolution: GoldResolution;
  spotChecked: boolean;
  spotCheckVerdict: SpotCheckVerdict | null;
  /** Fresh datasets: true when every agreed non-independent label was individually reviewed. */
  positiveReviewed?: boolean;
};

export type JudgePair = {
  pairId: string;
  oldRef: MemoryRef;
  newRef: MemoryRef;
  stratum: string;
  split: JudgeSplit;
  origin: string;
  population: JudgePopulation;
  cosine: number | null;
  gold: JudgeGold;
  frame?: JudgeFrame;
  legacyBinaryGold?: boolean;
  goldHeadline?: GoldLabel | null;
  goldStrict?: GoldLabel | null;
};

export type JudgeLabelsFile = {
  schemaVersion: typeof JUDGE_BENCHMARK_SCHEMA_VERSION;
  taskId: typeof JUDGE_TASK_ID;
  datasetId: string;
  legacyBinaryGold: boolean;
  pairs: JudgePair[];
};

export type SnapshotLine = {
  id: string;
  sha256: string;
  text: string;
};

export type CaseErrorCode = "missing_text" | "sha256_mismatch";

export type LoadedPair = {
  pair: JudgePair;
  oldText: string | null;
  newText: string | null;
  caseError?: CaseErrorCode;
  caseErrorRef?: "old" | "new";
};

export type JudgeSignals =
  | { family: "judge"; verdict: GoldLabel; confidence: number }
  | { family: "noul"; probability: number }
  | { family: "choice"; argmax: GoldLabel; pSupersede: number | null }
  | { family: "none" };

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type JudgeBenchmarkRow = {
  schemaVersion: typeof JUDGE_BENCHMARK_SCHEMA_VERSION;
  runId: string;
  timestamp: string;
  pairId: string;
  datasetId: string;
  candidateId: CandidateId;
  candidateConfigHash: string;
  repetition: number;
  direction: PairDirection;
  split: JudgeSplit;
  population: JudgePopulation;
  stratum: string;
  frame: JudgeFrame | null;
  legacyBinaryGold: boolean;
  gold: {
    label: GoldLabel;
    labelA: GoldLabel;
    labelB: GoldLabel;
    resolution: GoldResolution;
    headline: GoldLabel | null;
    strict: GoldLabel | null;
  };
  oldRef: { id: string; sha256: string };
  newRef: { id: string; sha256: string };
  decision: Decision;
  effectiveDecision: EffectiveDecision;
  retireScore: number | null;
  signals: JudgeSignals;
  outcome: OutcomeId | null;
  latencyMs: number;
  retryCount: number;
  usage: TokenUsage;
  billedCostUsd: number | null;
  estimatedCostUsd: number | null;
  errorClass?: string;
  httpStatus?: number;
};

export type JudgeRunManifest = {
  schemaVersion: typeof JUDGE_BENCHMARK_SCHEMA_VERSION;
  scoringContractVersion: typeof JUDGE_SCORING_CONTRACT_VERSION;
  taskId: typeof JUDGE_TASK_ID;
  runId: string;
  createdAt: string;
  datasetId: string;
  candidateId: CandidateId;
  git: { sha: string; dirty: boolean };
  fixtureContentHash: string;
  textSnapshotHash: string;
  candidateConfigHashes: string[];
  split: JudgeSplit | null;
  probe: "none" | "order-swap";
  replayOnly: boolean;
  threshold: number;
  thresholdSource: ThresholdSource | "candidate_default";
  rowCount: number;
  disclosure: {
    candidateId: CandidateId;
    candidateConfigHash: string;
    modelId: string;
    pairs: number;
    caseErrors: number;
    plannedRequestCount: number;
    dryRun: boolean;
    replayOnly: boolean;
    concurrency: number;
    maxTotalCostUsd: number | null;
    estimatedCostUsdUpper: number;
    gatewayBaseUrl: string;
    credentialSource: string;
    probe: "none" | "order-swap";
  };
  completion: {
    status: "complete" | "partial";
    plannedRequestCount: number;
    completedRequestCount: number;
    cumulativeCostUsd: number;
    stopReason?: "cost_cap" | "auth_failure" | "timeout" | "runtime_error" | "cassette_miss";
  };
};

export type JudgeMetricGroup = {
  id: string;
  n: number;
  underpowered: boolean;
  harmful: number;
  wrongRetire: number;
  wrongSkip: number;
  harmfulRate: number | null;
  wilson95Upper: number | null;
  updateRecall: number | null;
  supersedeN: number;
  updateLanded: number;
  duplicateRecall: number | null;
  duplicateGoldN: number;
  duplicateAsDuplicate: number;
  duplicateAsRetire: number;
  correctionDropped: number;
  missedUpdate: number;
  auroc: number | null;
  ece: number | null;
  directionErrors: number;
  directionProbes: number;
  errorCount: number;
  errorRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  costP50Usd: number | null;
  costP95Usd: number | null;
  costTotalUsd: number;
  gate: GateStatus;
};

export type JudgeScoreReport = {
  schemaVersion: typeof JUDGE_SCORING_CONTRACT_VERSION;
  groups: JudgeMetricGroup[];
};

export type ThresholdFit = {
  threshold: number;
  thresholdSource: ThresholdSource;
  defaultThreshold: number;
  updateRecall: number | null;
  updateLanded: number;
  supersedeN: number;
  harmful: number;
  n: number;
  wilson95Upper: number;
  considered: number[];
};

export type ThresholdsFile = {
  schemaVersion: typeof JUDGE_SCORING_CONTRACT_VERSION;
  datasetId: string;
  candidateId: CandidateId;
  candidateConfigHash: string;
  split: JudgeSplit;
  threshold: number;
  thresholdSource: ThresholdSource;
  defaultThreshold: number;
  updateRecall: number | null;
  harmful: number;
  n: number;
  wilson95Upper: number;
  thresholdsHash: string;
};

export type PreflightDisclosure = JudgeRunManifest["disclosure"] & {
  schemaVersion: typeof JUDGE_BENCHMARK_SCHEMA_VERSION;
  command: "run";
  datasetId: string;
  git: { sha: string; dirty: boolean };
  fixtureContentHash: string;
  textSnapshotHash: string;
  networkCalls: 0;
  /** Test pairs dropped because `--split` was omitted. */
  testRowsExcluded: number;
  /** States whether test rows were excluded, not requested, or unlocked. */
  testSplitNote: string;
};

export type JudgeCommandResult = {
  code: number;
  error?: string;
  disclosure?: PreflightDisclosure;
  report?: string;
};
