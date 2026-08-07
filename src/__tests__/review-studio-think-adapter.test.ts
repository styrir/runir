import { describe, expect, it } from "vitest";
import type { ThinkBenchmarkRow, ThinkRunManifest, ThinkSuiteId } from "../testing/think-benchmark/types.js";
import {
  THINK_BENCHMARK_SCHEMA_VERSION,
  THINK_RESPONSE_PARSER_VERSION,
  THINK_SCORING_CONTRACT_VERSION,
} from "../testing/think-benchmark/types.js";
import { adaptReviewRun, REVIEW_RUN_ADAPTERS } from "../testing/review-studio/adapter-registry.js";
import {
  ReviewAdapterError,
  ReviewCompatibilityError,
  compareReviewRuns,
} from "../testing/review-studio/benchmark-adapter.js";
import { adaptThinkBenchmarkRun } from "../testing/review-studio/think-adapter.js";

function bundle(suiteId: ThinkSuiteId, runId: string, latencyMs: number) {
  const row: ThinkBenchmarkRow = {
    schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
    runId,
    timestamp: "2026-08-07T12:00:00.000Z",
    caseId: "case-1",
    repetition: 1,
    candidateId: "luna",
    candidateLabel: "Luna",
    modelId: "openai/gpt-5.6-luna",
    question: "Which database?",
    evidence: [{ id: "semiote:database", text: "Rúnir uses SurrealDB." }],
    gold: {
      answerExpected: true,
      supportedClaims: [{ id: "database", mustContain: ["SurrealDB"], evidenceIds: ["semiote:database"] }],
      forbiddenContains: ["PostgreSQL"],
      requiredGapContains: [],
    },
    effectiveRequest: { model: "openai/gpt-5.6-luna", max_tokens: 1200, temperature: 0.2 },
    responseParserVersion: THINK_RESPONSE_PARSER_VERSION,
    synthesis: {
      answer: "Rúnir uses SurrealDB.",
      claims: [{
        text: "Rúnir uses SurrealDB.",
        citations: [{ id: "semiote:database", index: 0 }],
        droppedCitations: [],
      }],
      citations: [{ id: "semiote:database", index: 0 }],
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
      citedEvidenceIds: ["semiote:database"],
      missingEvidenceIds: [],
      forbiddenMatches: [],
    },
    synthesisVerdict: "pass",
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    latencyMs,
    retryCount: 0,
    httpStatus: 200,
    estimatedCostUsd: 0.001,
    billedCostUsd: null,
    costBasis: "token_usage_estimate",
    ...(suiteId === "runir-think-e2e" ? {
      retrieval: {
        status: "pass" as const,
        selectedBeforeCap: 1,
        selectedIds: ["semiote:database"],
        retainedIds: ["semiote:database"],
        evidenceCount: 1,
        cap: 12 as const,
        synthesisSkipped: false,
        retrievalTraceId: "trace-1",
      },
    } : {}),
  };
  const manifest: ThinkRunManifest = {
    schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
    runId,
    suiteId,
    createdAt: "2026-08-07T12:00:00.000Z",
    git: { sha: "a".repeat(40), dirty: false },
    fixtureContentHash: "b".repeat(64),
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
      gatewayBaseUrl: "https://router.example/v1",
      costObservation: "gateway_or_usage",
    },
    completion: {
      status: "complete",
      plannedRequestCount: 1,
      completedRequestCount: 1,
      cumulativeCostUsd: 0.001,
    },
  };
  return { manifest, rows: [row] };
}

describe("Review Studio Think adapter", () => {
  it("registers each source schema exactly once", () => {
    expect(new Set(REVIEW_RUN_ADAPTERS.map((adapter) => adapter.sourceSchemaVersion)).size)
      .toBe(REVIEW_RUN_ADAPTERS.length);
  });

  it("normalizes synthesis and e2e artifacts with distinct suite identities and claim detail", () => {
    const synthesis = adaptReviewRun(bundle("runir-think-synthesis", "synthesis", 100));
    const e2e = adaptThinkBenchmarkRun(bundle("runir-think-e2e", "e2e", 150));
    expect(synthesis.runKind).toBe("think-synthesis");
    expect(synthesis.cases[0]?.detail.kind).toBe("think-synthesis");
    expect(e2e.runKind).toBe("think-e2e");
    expect(e2e.cases[0]?.detail.kind).toBe("think-e2e");
    expect(synthesis.metricDefinitions.find((metric) => metric.id === "unsupportedClaimRate")?.direction)
      .toBe("lower_is_better");
  });

  it("compares only the same Think suite and permanently refuses cross-suite overrides", () => {
    const baseline = adaptThinkBenchmarkRun(bundle("runir-think-synthesis", "baseline", 100));
    const candidate = adaptThinkBenchmarkRun(bundle("runir-think-synthesis", "candidate", 80));
    expect(compareReviewRuns(baseline, candidate).caseDeltas[0]?.metrics.latencyMs?.assessment).toBe("improved");
    const e2e = adaptThinkBenchmarkRun(bundle("runir-think-e2e", "e2e", 80));
    expect(() => compareReviewRuns(baseline, e2e, { allowIncompatible: true }))
      .toThrow(ReviewCompatibilityError);
  });

  it("attributes an e2e evidence miss to retrieval and leaves synthesis quality unscored", () => {
    const missed = bundle("runir-think-e2e", "retrieval-miss", 80);
    missed.rows[0]!.retrieval = {
      ...missed.rows[0]!.retrieval!,
      status: "fail",
      retainedIds: [],
      evidenceCount: 0,
    };
    missed.rows[0]!.synthesisVerdict = "not-scored";
    const run = adaptThinkBenchmarkRun(missed);
    expect(run.cases[0]).toMatchObject({
      status: "fail",
      metrics: {
        retrievalPass: 0,
        answerCompleteness: null,
        citationCompleteness: null,
      },
    });
    expect(run.cases[0]!.diagnostics.map((item) => item.code)).toContain("retrieval_miss");
  });

  it("rejects unknown source schemas and invalid parser provenance", () => {
    expect(() => adaptReviewRun({ manifest: { schemaVersion: "unknown" }, rows: [] }))
      .toThrow(ReviewAdapterError);
    const invalid = bundle("runir-think-synthesis", "bad-parser", 100);
    invalid.rows[0]!.responseParserVersion = "other" as typeof THINK_RESPONSE_PARSER_VERSION;
    expect(() => adaptThinkBenchmarkRun(invalid)).toThrow(/responseParserVersion/);
  });

  it("strips gateway userinfo before exposing raw manifest evidence", () => {
    const sensitive = bundle("runir-think-synthesis", "userinfo", 100);
    sensitive.manifest.disclosure.gatewayBaseUrl = "https://user:password@router.example/v1?secret=x";
    const run = adaptThinkBenchmarkRun(sensitive);
    expect(JSON.stringify(run.rawManifest)).not.toContain("password");
    expect(JSON.stringify(run.rawManifest)).not.toContain("secret=x");
    expect(run.rawManifest).toMatchObject({
      disclosure: { gatewayBaseUrl: "https://router.example/v1" },
    });
  });
});
