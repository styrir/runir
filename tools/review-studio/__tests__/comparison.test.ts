import { describe, expect, it } from "vitest";

import {
  aggregateDeltasForMetric,
  buildCaseSelection,
  candidateDescriptor,
  loadCaseEntries,
} from "../ui/review-studio.js";

const baselineCase = {
  comparisonKey: "[\"unaligned\",\"candidate-a\",1]",
  caseId: "unaligned",
  repetition: 1,
  candidateId: "candidate-a",
  metrics: { atomicPrecision: 0.8 },
};

const candidateCase = {
  ...baselineCase,
  metrics: { atomicPrecision: 0.9 },
};

const comparison = {
  baselineRunId: "baseline-run",
  candidateRunId: "candidate-run",
  aggregateDeltas: [
    {
      candidateId: "candidate-a",
      baseline: { candidateId: "candidate-a", label: "Candidate A", modelId: "model-a", metrics: { meanAtomicPrecision: 0.8 } },
      candidate: { candidateId: "candidate-a", label: "Candidate A", modelId: "model-a", metrics: { meanAtomicPrecision: 0.9 } },
      metrics: { meanAtomicPrecision: { delta: 0.1, assessment: "improved" } },
    },
    {
      candidateId: "candidate-b",
      baseline: { candidateId: "candidate-b", label: "Candidate B", modelId: "model-b", metrics: { meanAtomicPrecision: 0.7 } },
      candidate: { candidateId: "candidate-b", label: "Candidate B", modelId: "model-b", metrics: { meanAtomicPrecision: 0.6 } },
      metrics: { meanAtomicPrecision: { delta: -0.1, assessment: "regressed" } },
    },
  ],
  caseDeltas: [
    {
      comparisonKey: baselineCase.comparisonKey,
      caseId: baselineCase.caseId,
      repetition: baselineCase.repetition,
      candidateId: baselineCase.candidateId,
      availability: "baseline-only",
      baseline: { ...baselineCase, baselineRunId: "wrong-case-level-id" },
      candidate: null,
      metrics: { atomicPrecision: { delta: null, assessment: "unknown" } },
    },
  ],
};

describe("Review Studio comparison selection helpers", () => {
  it("retains every candidate aggregate for a metric and its identity metadata", () => {
    const deltas = aggregateDeltasForMetric(comparison, "meanAtomicPrecision");

    expect(deltas).toHaveLength(2);
    expect(deltas.map((delta) => candidateDescriptor(delta))).toEqual([
      { id: "candidate-a", label: "Candidate A", modelId: "model-a" },
      { id: "candidate-b", label: "Candidate B", modelId: "model-b" },
    ]);
  });

  it("uses comparison-root run IDs and preserves an absent side in an unaligned case", () => {
    const selection = buildCaseSelection(comparison, baselineCase.comparisonKey, "catalog-baseline", "catalog-candidate");

    expect(selection?.entries).toEqual([
      { catalogId: "catalog-baseline", runId: "baseline-run", side: "baseline", available: true },
      { catalogId: "catalog-candidate", runId: "candidate-run", side: "candidate", available: false },
    ]);
  });

  it("keeps the other side loaded when one available case request returns 404", async () => {
    const bothComparison = {
      ...comparison,
      caseDeltas: [{ ...comparison.caseDeltas[0], availability: "both", candidate: candidateCase }],
    };
    const selection = buildCaseSelection(bothComparison, baselineCase.comparisonKey, "catalog-baseline", "catalog-candidate");
    const requestedSides: string[] = [];
    const entries = await loadCaseEntries(selection!, async (entry) => {
      requestedSides.push(entry.side);
      if (entry.side === "baseline") {
        const error = new Error("case_not_found");
        Object.assign(error, { status: 404 });
        throw error;
      }
      return candidateCase;
    });

    expect(requestedSides).toEqual(["baseline", "candidate"]);
    expect(entries[0]).toMatchObject({ side: "baseline", case: null, unavailableReason: "not present in this run" });
    expect(entries[1]).toMatchObject({ side: "candidate", case: candidateCase, unavailableReason: "" });
  });
});
