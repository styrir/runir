import { describe, expect, it } from "vitest";
import {
  BENCHMARK_SCHEMA_VERSION,
  RESPONSE_PARSER_VERSION,
  SCORING_CONTRACT_VERSION,
  type ResultRow,
} from "../testing/model-benchmark/types.js";
import {
  canonicalHash,
  fixtureContentHashFor,
  promptTemplateHashFor,
} from "../testing/model-benchmark/provenance.js";
import { promptHashFor } from "../testing/model-benchmark/request.js";
import {
  adaptBenchmarkRun,
  adaptBenchmarkRuns,
  assessReviewCompatibility,
  buildComparisonKey,
  compareReviewRuns,
  detectDuplicateRunIds,
  ReviewAdapterError,
  ReviewCompatibilityError,
} from "../testing/review-studio/benchmark-adapter.js";
import type { BenchmarkRunBundle } from "../testing/review-studio/types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function row(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId: "run-a",
    timestamp: "2026-08-06T10:00:00.000Z",
    git: { sha: "abc123", dirty: false },
    caseId: "case-1",
    repetition: 1,
    candidateId: "candidate-a",
    candidateLabel: "Candidate A",
    modelId: "model/a",
    gatewayBaseUrl: "https://gateway.example/v1",
    promptHash: "c".repeat(64),
    effectiveRequest: {
      modelId: "model/a",
      temperature: 0,
      max_tokens: 100,
      notes: [],
    },
    responseParserVersion: RESPONSE_PARSER_VERSION,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    latencyMs: 100,
    ttftMs: null,
    retryCount: 0,
    parse: {
      classification: "valid",
      schemaValid: true,
      facts: [{ l2: "stable fact" }],
      rawTextHead: "{\"facts\":[...]}"
    },
    quality: {
      schemaValid: true,
      atomicPrecision: 1,
      atomicRecall: 1,
      hallucinationRate: 0,
      omissionRate: 0,
      granularityCompliance: 1,
      evidenceFidelity: 1,
      abstentionCorrect: null,
      correctionHandling: null,
      matchedGoldIds: ["gold-1"],
      unmatchedExtracted: 0,
      unmatchedGold: 0,
    },
    estimatedCostUsd: 0.01,
    billedCostUsd: null,
    ...overrides,
  };
}

function manifest(
  runId: string,
  rows: readonly ResultRow[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId,
    createdAt: "2026-08-06T10:00:00.000Z",
    git: { sha: "abc123", dirty: false },
    disclosure: {
      candidates: [
        {
          id: "candidate-a",
          label: "Candidate A",
          modelId: "model/a",
          reasoningSupport: "native",
          effectiveNotes: [],
        },
      ],
      plannedRequestCount: rows.length,
      repetitions: Math.max(...rows.map((item) => item.repetition), 1),
      smokeMode: false,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      concurrency: 1,
      gatewayBaseUrl: "https://gateway.example/v1",
      dryRun: false,
    },
    fixtureContentHash: HASH_A,
    promptTemplateHash: HASH_B,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    promptHash: "c".repeat(64),
    fixturePath: "/Users/brooks/private/fixtures/corpus.json",
    rowCount: rows.length,
    producerExtension: { retained: true },
    apiKey: "do-not-expose",
    ...overrides,
  };
}

function bundle(
  runId: string,
  rows: readonly ResultRow[],
  manifestOverrides: Record<string, unknown> = {},
): BenchmarkRunBundle {
  return { manifest: manifest(runId, rows, manifestOverrides), rows };
}

describe("model-benchmark provenance hashing", () => {
  it("canonicalizes object key order and semantic fixture ordering", () => {
    expect(canonicalHash({ b: 2, a: { z: 1, y: 0 }, max_tokens: 100 })).toBe(
      canonicalHash({ a: { y: 0, z: 1 }, max_tokens: 100, b: 2 }),
    );
    const first = {
      version: "v1",
      cases: [
        { id: "b", gold: { facts: [{ id: "z" }, { id: "a" }] } },
        { id: "a", gold: { facts: [] } },
      ],
    };
    const equivalent = {
      cases: [
        { gold: { facts: [] }, id: "a" },
        { gold: { facts: [{ id: "a" }, { id: "z" }] }, id: "b" },
      ],
      version: "v1",
    };
    expect(fixtureContentHashFor(first)).toBe(fixtureContentHashFor(equivalent));
    expect(fixtureContentHashFor({ ...equivalent, cases: [{ ...equivalent.cases[0], id: "changed" }, equivalent.cases[1]] })).not.toBe(
      fixtureContentHashFor(equivalent),
    );
  });

  it("rejects secret-like hash fields and keeps template and timestamp hashes distinct", () => {
    expect(() => canonicalHash({ authorization: "Bearer secret" })).toThrow(/secret-like/);
    const templateHash = promptTemplateHashFor();
    expect(templateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(promptHashFor("template {SESSION_TIMESTAMP}")).not.toBe(templateHash);
  });
});

describe("runir-model-benchmark/v1 review adapter", () => {
  it("normalizes provenance, preserves raw unknown fields, and surfaces dirty/dry/synthetic state", () => {
    const sourceRows = [
      row({ runId: "run-a", errorClass: "dry_run", experimentalMetric: { score: 7 } } as Partial<ResultRow> & {
        experimentalMetric: unknown;
      }),
    ];
    const adapted = adaptBenchmarkRun({
      manifest: manifest("run-a", sourceRows, {
        git: { sha: "abc123", dirty: true },
        disclosure: { ...manifest("run-a", sourceRows).disclosure, dryRun: true, synthetic: true },
      }),
      rows: sourceRows,
    });
    expect(adapted.schemaVersion).toBe("runir-review-run/v1");
    expect(adapted.suiteId).toBe("runir-model-benchmark");
    expect(adapted.suiteVersion).toMatch(/^runir-model-benchmark-suite\/v1-/);
    expect(adapted.fixtureHash).toBe(HASH_A);
    expect(adapted.provenance).toMatchObject({
      compatibility: "verified",
      gitDirty: true,
      dryRun: true,
      synthetic: true,
    });
    expect(adapted.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["dirty_git", "dry_run", "synthetic"]),
    );
    expect(adapted.rawManifest.fixturePath).toBe("[REDACTED_PATH]");
    expect(adapted.rawManifest.apiKey).toBe("[REDACTED]");
    expect(adapted.cases[0]!.rawEvidence.unknownManifestFields).toContain("producerExtension");
    expect(adapted.cases[0]!.rawEvidence.unknownRowFields).toContain("experimentalMetric");
    expect(adapted.cases[0]!.rawEvidence.row.experimentalMetric).toEqual({ score: 7 });
    expect(adapted.cases[0]!.comparisonKey).toBe(
      buildComparisonKey({ caseId: "case-1", candidateId: "candidate-a", repetition: 1 }),
    );
  });

  it("surfaces reference condition and partial cost-cap provenance without changing suite identity", () => {
    const sourceRows = [row({ runId: "reference-run-a" })];
    const referenceA = adaptBenchmarkRun(
      bundle("reference-run-a", sourceRows, {
        conditionId: "reference-a",
        completion: {
          status: "partial",
          plannedRequestCount: 3,
          completedRequestCount: 1,
          cumulativeCostUsd: 0.005,
          stopReason: "cost_cap",
        },
        artifactTargets: {
          rawPath: "/tmp/reference-a.jsonl",
          manifestPath: "/tmp/reference-a.manifest.json",
          reportPath: "/tmp/reference-a.md",
        },
        disclosure: {
          ...manifest("reference-run-a", sourceRows).disclosure,
          plannedRequestCount: 3,
        },
      }),
    );
    const referenceB = adaptBenchmarkRun(
      bundle("reference-run-b", [row({ runId: "reference-run-b" })], {
        conditionId: "reference-b",
      }),
    );

    expect(referenceA.conditionId).toBe("reference-a");
    expect(referenceA.provenance).toMatchObject({
      conditionId: "reference-a",
      completionStatus: "partial",
      stopReason: "cost_cap",
      cumulativeCostUsd: 0.005,
      incomplete: true,
    });
    expect(referenceA.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["incomplete_run", "cost_cap_stop"]),
    );
    expect(referenceA.cases[0]!.rawEvidence.unknownManifestFields).not.toContain("conditionId");
    expect(referenceA.cases[0]!.rawEvidence.unknownManifestFields).not.toContain("completion");
    expect(referenceA.cases[0]!.rawEvidence.unknownManifestFields).not.toContain("artifactTargets");
    expect(
      (referenceA.rawManifest.artifactTargets as Record<string, unknown>).rawPath,
    ).toBe("[REDACTED_PATH]");
    expect(referenceA.suiteVersion).toBe(referenceB.suiteVersion);
    expect(referenceA.cases[0]!.comparisonKey).toBe(referenceB.cases[0]!.comparisonKey);
    expect(compareReviewRuns(referenceA, referenceB).compatibility).toMatchObject({
      status: "compatible",
      pairing: "automatic",
    });
  });

  it("computes aggregate and case deltas with metric direction", () => {
    const baselineRows = [row({ runId: "baseline", latencyMs: 100 })];
    const candidateRows = [
      row({
        runId: "candidate",
        latencyMs: 80,
        quality: {
          ...row().quality,
          atomicPrecision: 0.9,
          hallucinationRate: 0.1,
        },
      }),
    ];
    const baseline = adaptBenchmarkRun(bundle("baseline", baselineRows));
    const candidate = adaptBenchmarkRun(bundle("candidate", candidateRows));
    const comparison = compareReviewRuns(baseline, candidate);
    expect(comparison.compatibility.status).toBe("compatible");
    expect(comparison.caseDeltas).toHaveLength(1);
    expect(comparison.caseDeltas[0]!.metrics.latencyMs).toEqual({ delta: -20, assessment: "improved" });
    expect(comparison.caseDeltas[0]!.metrics.atomicPrecision!.assessment).toBe("regressed");
    expect(comparison.caseDeltas[0]!.metrics.atomicPrecision!.delta).toBeCloseTo(-0.1);
    expect(comparison.caseDeltas[0]!.metrics.hallucinationRate).toEqual({ delta: 0.1, assessment: "regressed" });
    expect(comparison.aggregateDeltas[0]!.metrics.p95LatencyMs).toEqual({ delta: -20, assessment: "improved" });
  });

  it("refuses mismatched suites and requires explicit pairing for legacy artifacts", () => {
    const baseline = adaptBenchmarkRun(bundle("baseline", [row({ runId: "baseline" })]));
    const changedSuite = adaptBenchmarkRun(
      bundle("candidate", [row({ runId: "candidate" })], { fixtureContentHash: "d".repeat(64) }),
    );
    expect(() => compareReviewRuns(baseline, changedSuite)).toThrow(ReviewCompatibilityError);
    expect(() => compareReviewRuns(baseline, changedSuite)).toThrow(/suiteVersion differs/);
    const forced = compareReviewRuns(baseline, changedSuite, { allowIncompatible: true });
    expect(forced.compatibility).toMatchObject({ status: "incompatible", pairing: "explicit-override" });

    const legacyA = { ...manifest("legacy-a", [row({ runId: "legacy-a" })]) };
    const legacyB = { ...manifest("legacy-b", [row({ runId: "legacy-b" })]) };
    delete legacyA.fixtureContentHash;
    delete legacyA.promptTemplateHash;
    delete legacyA.scoringContractVersion;
    delete legacyB.fixtureContentHash;
    delete legacyB.promptTemplateHash;
    delete legacyB.scoringContractVersion;
    const legacyRunA = adaptBenchmarkRun({ manifest: legacyA, rows: [row({ runId: "legacy-a" })] });
    const legacyRunB = adaptBenchmarkRun({ manifest: legacyB, rows: [row({ runId: "legacy-b" })] });
    expect(assessReviewCompatibility(legacyRunA, legacyRunB).status).toBe("legacy-unverified");
    expect(() => compareReviewRuns(legacyRunA, legacyRunB)).toThrow(/unverified/);
    expect(compareReviewRuns(legacyRunA, legacyRunB, { allowUnverifiedPairing: true }).compatibility).toMatchObject({
      status: "legacy-unverified",
      pairing: "explicit-override",
    });
  });

  it("keeps repetition and candidate mismatches explicit instead of silently intersecting", () => {
    const baselineRows = [row({ runId: "baseline", repetition: 1 })];
    const candidateRows = [
      row({
        runId: "candidate",
        candidateId: "candidate-b",
        candidateLabel: "Candidate B",
        modelId: "model/b",
        repetition: 2,
      }),
    ];
    const baseline = adaptBenchmarkRun(bundle("baseline", baselineRows));
    const candidate = adaptBenchmarkRun(bundle("candidate", candidateRows));
    const comparison = compareReviewRuns(baseline, candidate);
    expect(comparison.compatibility.status).toBe("compatible");
    expect(comparison.compatibility.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/repetition count differs/),
        expect.stringMatching(/candidate set differs/),
      ]),
    );
    expect(comparison.caseDeltas.map((item) => item.availability)).toEqual(["baseline-only", "candidate-only"]);
  });

  it("detects duplicate run IDs without network or silent overwrite", () => {
    const first = bundle("duplicate", [row({ runId: "duplicate" })]);
    const second = bundle("duplicate", [row({ runId: "duplicate" })]);
    expect(detectDuplicateRunIds([first, second])).toEqual(["duplicate"]);
    const set = adaptBenchmarkRuns([first, second]);
    expect(set.duplicateRunIds).toEqual(["duplicate"]);
    expect(set.runs).toHaveLength(2);
    expect(set.diagnostics[0]!.code).toBe("duplicate_run_id");
  });

  it("refuses unsupported producer schema versions", () => {
    expect(() =>
      adaptBenchmarkRun({
        manifest: { ...manifest("bad", [row({ runId: "bad" })]), schemaVersion: "runir-model-benchmark/v0" },
        rows: [row({ runId: "bad" })],
      }),
    ).toThrow(ReviewAdapterError);
  });
});
