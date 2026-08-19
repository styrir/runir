import { describe, expect, it } from "vitest";
import { adaptThinkBenchmarkRun } from "../testing/review-studio/think-adapter.js";
import {
  THINK_BENCHMARK_SCHEMA_VERSION,
  THINK_RESPONSE_PARSER_VERSION,
  THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
  THINK_SCORING_CONTRACT_VERSION,
} from "../testing/think-benchmark/types.js";

function bundle(withRetrievalMetrics: boolean) {
  const retrieval = {
    status: "pass",
    selectedBeforeCap: 24,
    selectedIds: ["relevant", "distractor"],
    retainedIds: ["relevant"],
    evidenceCount: 1,
    cap: 12,
    synthesisSkipped: false,
    ...(withRetrievalMetrics ? {
      gold: {
        relevantIds: ["semiote:relevant"],
        distractorIds: ["semiote:distractor"],
      },
      scores: {
        recall: 1,
        precision: 0.5,
        firstRelevantRank: 1,
        meanRelevantRank: 1,
        retainedRecall: 1,
        retrievedRelevantIds: ["relevant"],
        retrievedDistractorIds: ["distractor"],
        missingRelevantIds: [],
      },
    } : {}),
  };
  return {
    manifest: {
      schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
      runId: withRetrievalMetrics ? "distractor-scale" : "legacy",
      suiteId: "runir-think-e2e",
      createdAt: "2026-08-19T12:00:00.000Z",
      git: { sha: "a".repeat(40), dirty: false },
      fixtureContentHash: "b".repeat(64),
      ...(withRetrievalMetrics ? {
        retrievalFixtureContentHash: "d".repeat(64),
        retrievalMetricContractVersion: THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
      } : {}),
      promptTemplateHash: "c".repeat(64),
      scoringContractVersion: THINK_SCORING_CONTRACT_VERSION,
      rowCount: 1,
      disclosure: {
        candidateId: "luna",
        candidateLabel: "Luna",
        modelId: "openai/gpt-5.6-luna",
        repetitions: 1,
        plannedRequestCount: 1,
        dryRun: false,
        synthetic: true,
        maxOutputTokens: 1200,
        timeoutMs: 30_000,
        gatewayBaseUrl: "http://127.0.0.1:7700",
        costObservation: "route_usage_or_reservation",
      },
      completion: {
        status: "complete",
        plannedRequestCount: 1,
        completedRequestCount: 1,
        cumulativeCostUsd: 0,
      },
    },
    rows: [{
      schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
      runId: withRetrievalMetrics ? "distractor-scale" : "legacy",
      timestamp: "2026-08-19T12:00:00.000Z",
      caseId: "case-1",
      repetition: 1,
      candidateId: "luna",
      candidateLabel: "Luna",
      modelId: "openai/gpt-5.6-luna",
      question: "Which database?",
      evidence: [{ id: "relevant", text: "Rúnir uses SurrealDB." }],
      gold: {
        answerExpected: true,
        supportedClaims: [{
          id: "database",
          mustContain: ["SurrealDB"],
          evidenceIds: ["relevant"],
        }],
        forbiddenContains: [],
        requiredGapContains: [],
      },
      effectiveRequest: {
        model: "openai/gpt-5.6-luna",
        max_tokens: 1200,
        temperature: 0.2,
      },
      responseParserVersion: THINK_RESPONSE_PARSER_VERSION,
      synthesis: {
        answer: "Rúnir uses SurrealDB.",
        claims: [{
          text: "Rúnir uses SurrealDB.",
          citations: [{ id: "relevant", index: 0 }],
          droppedCitations: [],
        }],
        citations: [{ id: "relevant", index: 0 }],
        gaps: [],
        droppedCitations: [],
        schemaValid: true,
        parseClassification: "valid",
      },
      rawResponseHead: "{}",
      quality: {
        schemaValid: true,
        answerCompleteness: 1,
        unsupportedClaimRate: 0,
        citationValidity: 1,
        citationPrecision: 1,
        citationCompleteness: 1,
        gapAccuracy: 1,
        abstentionCorrect: 1,
        matchedClaimIds: ["database"],
        missingClaimIds: [],
        citedEvidenceIds: ["relevant"],
        missingEvidenceIds: [],
        forbiddenMatches: [],
      },
      synthesisVerdict: "pass",
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      latencyMs: 100,
      retryCount: 0,
      httpStatus: 200,
      estimatedCostUsd: 0,
      billedCostUsd: null,
      costBasis: "token_usage_estimate",
      retrieval,
    }],
  };
}

describe("Review Studio Think retrieval metrics", () => {
  it("exposes distractor-scale metrics while preserving legacy e2e bundles", () => {
    const current = adaptThinkBenchmarkRun(bundle(true));
    const legacy = adaptThinkBenchmarkRun(bundle(false));

    expect(current.cases[0]?.metrics).toMatchObject({
      retrievalRecall: 1,
      retrievalPrecision: 0.5,
      retrievalRetainedRecall: 1,
      retrievalFirstRelevantRank: 1,
      retrievalMeanRelevantRank: 1,
    });
    expect(current.aggregates[0]?.metrics).toMatchObject({
      meanRetrievalRecall: 1,
      meanRetrievalPrecision: 0.5,
      meanRetrievalRetainedRecall: 1,
      meanRetrievalFirstRelevantRank: 1,
      meanRetrievalMeanRelevantRank: 1,
    });
    expect(legacy.cases[0]?.metrics).toMatchObject({
      retrievalRecall: null,
      retrievalPrecision: null,
    });
    expect(current.suiteVersion).not.toBe(legacy.suiteVersion);
  });
});
