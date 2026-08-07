export type CandidateFunnelStage = {
  readonly id: "base" | "noema" | "admitted" | "selected";
  readonly label: string;
  readonly count: number;
  readonly sourceField: string;
};

export type CandidateFunnel =
  | {
      readonly available: true;
      readonly stages: readonly CandidateFunnelStage[];
      readonly source: "persisted retrievalAudit";
    }
  | {
      readonly available: false;
      readonly reason: string;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function arrayCount(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

/**
 * Build the V1 candidate-count funnel from persisted retrievalAudit fields.
 * Debug-only attribution and stage timing fields are intentionally ignored.
 */
export function buildCandidateFunnel(trace: unknown): CandidateFunnel {
  const traceRecord = record(trace);
  const audit = record(traceRecord?.retrievalAudit);
  if (audit === undefined) {
    return {
      available: false,
      reason: "Evidence unavailable: this receipt has no persisted retrievalAudit candidate counts.",
    };
  }

  const stages: CandidateFunnelStage[] = [];
  const baseCandidateCount = count(audit.baseCandidateCount);
  if (baseCandidateCount !== undefined) {
    stages.push({
      id: "base",
      label: "Base candidates",
      count: baseCandidateCount,
      sourceField: "retrievalAudit.baseCandidateCount",
    });
  }

  const noema = record(audit.noema);
  const noemaCandidateCount = count(noema?.candidateCount);
  if (noemaCandidateCount !== undefined) {
    stages.push({
      id: "noema",
      label: "Noema candidates",
      count: noemaCandidateCount,
      sourceField: "retrievalAudit.noema.candidateCount",
    });
  }

  const admissibility = record(audit.admissibility);
  const admittedCount = arrayCount(admissibility?.admittedIds);
  if (admittedCount !== undefined) {
    stages.push({
      id: "admitted",
      label: "Admitted candidates",
      count: admittedCount,
      sourceField: "retrievalAudit.admissibility.admittedIds.length",
    });
  }

  const selectedCount = arrayCount(audit.finalSelectedIds);
  if (selectedCount !== undefined) {
    stages.push({
      id: "selected",
      label: "Final selected",
      count: selectedCount,
      sourceField: "retrievalAudit.finalSelectedIds.length",
    });
  }

  if (stages.length < 2) {
    return {
      available: false,
      reason: "Evidence unavailable: persisted retrievalAudit does not contain enough candidate-count fields.",
    };
  }
  return { available: true, stages, source: "persisted retrievalAudit" };
}
