import type { ThinkEvidenceItem, ThinkSynthesis } from "../../recall/orchestrator/think-synthesis.js";

export const THINK_BENCHMARK_SCHEMA_VERSION = "runir-think-benchmark/v1";
export const THINK_SCORING_CONTRACT_VERSION = "runir-think-scoring/v2";
export const THINK_RESPONSE_PARSER_VERSION = "think-claim-cited-json/v2";

export type ThinkSuiteId = "runir-think-synthesis" | "runir-think-e2e";

export type ThinkGoldClaim = {
  id: string;
  mustContain: string[];
  evidenceIds: string[];
};

export type ThinkBenchmarkCase = {
  id: string;
  description: string;
  question: string;
  evidence: ThinkEvidenceItem[];
  gold: {
    answerExpected: boolean;
    supportedClaims: ThinkGoldClaim[];
    forbiddenContains: string[];
    requiredGapContains: string[];
  };
};

export type ThinkQualityScores = {
  schemaValid: boolean;
  answerCompleteness: number;
  unsupportedClaimRate: number;
  citationValidity: number;
  citationPrecision: number;
  citationCompleteness: number;
  gapAccuracy: number;
  abstentionCorrect: number;
  matchedClaimIds: string[];
  missingClaimIds: string[];
  citedEvidenceIds: string[];
  missingEvidenceIds: string[];
  forbiddenMatches: string[];
};

export type ThinkUsageCounters = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ThinkBenchmarkRow = {
  schemaVersion: typeof THINK_BENCHMARK_SCHEMA_VERSION;
  runId: string;
  timestamp: string;
  caseId: string;
  repetition: number;
  candidateId: string;
  candidateLabel: string;
  modelId: string;
  question: string;
  evidence: ThinkEvidenceItem[];
  gold: ThinkBenchmarkCase["gold"];
  effectiveRequest: {
    model: string;
    max_tokens: number;
    temperature: number;
    reasoning?: never;
  };
  responseParserVersion: typeof THINK_RESPONSE_PARSER_VERSION;
  synthesis: ThinkSynthesis;
  rawResponseHead: string;
  quality: ThinkQualityScores;
  synthesisVerdict: "pass" | "fail" | "not-scored";
  usage: ThinkUsageCounters;
  latencyMs: number;
  retryCount: number;
  httpStatus?: number;
  errorClass?: string;
  requestId?: string;
  estimatedCostUsd: number | null;
  billedCostUsd: number | null;
  costBasis: "gateway_billed" | "token_usage_estimate" | "reserved_worst_case";
  retrieval?: {
    status: "pass" | "fail" | "error";
    selectedBeforeCap: number;
    selectedIds: string[];
    retainedIds: string[];
    evidenceCount: number;
    cap: 12;
    synthesisSkipped: boolean;
    retrievalLatencyMs?: number;
    policyVersion?: string;
    retrievalTraceId?: string;
  };
};

export type ThinkRunManifest = {
  schemaVersion: typeof THINK_BENCHMARK_SCHEMA_VERSION;
  runId: string;
  suiteId: ThinkSuiteId;
  createdAt: string;
  git: { sha: string; dirty: boolean };
  fixtureContentHash: string;
  promptTemplateHash: string;
  scoringContractVersion: typeof THINK_SCORING_CONTRACT_VERSION;
  rowCount: number;
  disclosure: {
    candidateId: string;
    candidateLabel: string;
    modelId: string;
    repetitions: number;
    plannedRequestCount: number;
    dryRun: boolean;
    synthetic: boolean;
    maxOutputTokens: number;
    timeoutMs: number;
    gatewayBaseUrl: string;
    costObservation: "gateway_or_usage" | "route_usage_or_reservation";
  };
  completion: {
    status: "complete" | "partial";
    plannedRequestCount: number;
    completedRequestCount: number;
    cumulativeCostUsd: number;
    stopReason?: "cost_cap" | "auth_failure" | "model_rejected" | "timeout" | "operator_abort" | "runtime_error";
  };
};
