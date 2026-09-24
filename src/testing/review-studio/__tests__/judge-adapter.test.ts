import { describe, expect, it } from "vitest";
import { adaptReviewRun } from "../adapter-registry.js";
import type { JudgeBenchmarkRow, JudgeRunManifest } from "../../judge-benchmark/types.js";

const SENTINEL = "UNIQUE_MEMORY_TEXT_SENTINEL";

function manifest(): JudgeRunManifest {
  return {
    schemaVersion: "runir-judge-benchmark/v1",
    scoringContractVersion: "runir-judge-scoring/v1",
    taskId: "supersession-pair/v1",
    runId: "judge-run-1",
    createdAt: "2026-09-24T00:00:00.000Z",
    datasetId: "demo",
    candidateId: "jev-noul-v1",
    git: { sha: "abc123", dirty: false },
    fixtureContentHash: "a".repeat(64),
    textSnapshotHash: "b".repeat(64),
    candidateConfigHashes: ["c".repeat(64)],
    split: "test",
    probe: "none",
    replayOnly: false,
    threshold: 0.5,
    thresholdSource: "candidate_default",
    rowCount: 1,
    disclosure: {
      candidateId: "jev-noul-v1",
      candidateConfigHash: "c".repeat(64),
      modelId: "typesafe/jev-1.13.0",
      pairs: 1,
      caseErrors: 0,
      plannedRequestCount: 1,
      dryRun: false,
      replayOnly: false,
      concurrency: 1,
      maxTotalCostUsd: 1,
      estimatedCostUsdUpper: 0.01,
      gatewayBaseUrl: "https://router.requesty.ai/v1",
      credentialSource: "REQUESTY_API_KEY (value never logged)",
      probe: "none",
    },
    completion: {
      status: "complete",
      plannedRequestCount: 1,
      completedRequestCount: 1,
      cumulativeCostUsd: 0,
    },
  };
}

function row(): JudgeBenchmarkRow & { oldText: string; rationale: string; reason: string } {
  return {
    schemaVersion: "runir-judge-benchmark/v1",
    runId: "judge-run-1",
    timestamp: "2026-09-24T00:00:00.000Z",
    pairId: "pair-1",
    datasetId: "demo",
    candidateId: "jev-noul-v1",
    candidateConfigHash: "c".repeat(64),
    repetition: 1,
    direction: "forward",
    split: "test",
    population: "probability",
    stratum: "c085-095",
    frame: null,
    legacyBinaryGold: false,
    gold: {
      label: "supersede",
      labelA: "supersede",
      labelB: "supersede",
      resolution: "agreed",
      headline: "supersede",
      strict: "supersede",
    },
    oldRef: { id: "old-id", sha256: "d".repeat(64) },
    newRef: { id: "new-id", sha256: "e".repeat(64) },
    decision: "retire",
    effectiveDecision: "retire",
    retireScore: 0.8,
    signals: { family: "noul", probability: 0.8 },
    outcome: "update_landed",
    latencyMs: 12,
    retryCount: 0,
    usage: {},
    billedCostUsd: null,
    estimatedCostUsd: 0.001,
    oldText: SENTINEL,
    rationale: SENTINEL,
    reason: SENTINEL,
  };
}

describe("judge review adapter", () => {
  it("round-trips the schema and keeps text out of rawEvidence when no snapshot is attached", () => {
    const run = adaptReviewRun({ manifest: manifest(), rows: [row()] });
    expect(run.runKind).toBe("judge-pairs");
    expect(run.casePresentation).toBe("judge-pairs");
    expect(run.cases).toHaveLength(1);
    const item = run.cases[0]!;
    expect(item.detail.kind).toBe("judge-pairs");
    if (item.detail.kind !== "judge-pairs") return;
    expect(item.detail.goldLabel).toBe("supersede");
    expect(item.detail.decision).toBe("retire");
    expect(item.detail.retireScore).toBe(0.8);
    expect(item.detail.latencyMs).toBe(12);
    expect(item.detail.oldPreview).toBeUndefined();
    expect(item.detail.newPreview).toBeUndefined();
    const evidence = JSON.stringify(item.rawEvidence);
    expect(evidence).not.toContain(SENTINEL);
    expect(evidence).not.toContain("oldText");
    expect(evidence).not.toContain("rationale");
    expect(run.aggregates[0]?.metrics.updateRecall).toBe(1);
  });

  it("drops unexpected text-bearing keys from rawEvidence", () => {
    const dirtyRow = {
      ...row(),
      errorClass: "http_429",
      httpStatus: 429,
      detail: SENTINEL,
      explanation: "EXPLANATION_SENTINEL",
      body: "BODY_SENTINEL",
    };
    const source = manifest();
    const dirtyManifest = {
      ...source,
      detail: SENTINEL,
      explanation: "EXPLANATION_SENTINEL",
      body: "BODY_SENTINEL",
      disclosure: { ...source.disclosure, body: "BODY_SENTINEL", explanation: "EXPLANATION_SENTINEL" },
    };
    const run = adaptReviewRun({ manifest: dirtyManifest, rows: [dirtyRow] });
    const evidence = JSON.stringify(run.cases[0]?.rawEvidence);
    const manifestEvidence = JSON.stringify(run.rawManifest);
    for (const blob of [evidence, manifestEvidence]) {
      expect(blob).not.toContain(SENTINEL);
      expect(blob).not.toContain("EXPLANATION_SENTINEL");
      expect(blob).not.toContain("BODY_SENTINEL");
      expect(blob).not.toContain("\"detail\"");
      expect(blob).not.toContain("\"explanation\"");
      expect(blob).not.toContain("\"body\"");
    }
    expect(evidence).toContain("pair-1");
    expect(evidence).toContain("retire");
    expect(evidence).toContain("\"latencyMs\":12");
    expect(evidence).toContain("\"errorClass\":\"http_429\"");
    expect(evidence).toContain("\"httpStatus\":429");
  });

  it("shows a preview on the detail only, even when a verified snapshot was supplied", () => {
    const run = adaptReviewRun({
      manifest: manifest(),
      rows: [row()],
      judgeTextPreviews: { "pair-1": { oldPreview: SENTINEL, newPreview: "newer" } },
    });
    const item = run.cases[0]!;
    expect(item.detail.kind).toBe("judge-pairs");
    if (item.detail.kind !== "judge-pairs") return;
    expect(item.detail.oldPreview).toBe(SENTINEL);
    expect(JSON.stringify(item.rawEvidence)).not.toContain(SENTINEL);
  });
});
