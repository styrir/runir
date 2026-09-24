import type { JudgeBenchmarkRow } from "./types.js";

type IdentityField = Exclude<keyof JudgeBenchmarkRow, "runId" | "timestamp">;

/**
 * Every raw-row field except `runId` and `timestamp`.
 * Record and replay must match on these fields and on the scored metrics.
 * The two excluded fields are per-run metadata and are expected to change.
 */
export const scoredRowIdentityFields = [
  "schemaVersion",
  "pairId",
  "datasetId",
  "candidateId",
  "candidateConfigHash",
  "repetition",
  "direction",
  "split",
  "population",
  "stratum",
  "frame",
  "legacyBinaryGold",
  "gold",
  "oldRef",
  "newRef",
  "decision",
  "effectiveDecision",
  "retireScore",
  "signals",
  "outcome",
  "latencyMs",
  "retryCount",
  "usage",
  "billedCostUsd",
  "estimatedCostUsd",
  "errorClass",
  "httpStatus",
] as const satisfies readonly IdentityField[];

type ListedField = (typeof scoredRowIdentityFields)[number];
const identityFieldCoverage: [Exclude<IdentityField, ListedField>, Exclude<ListedField, IdentityField>] extends [never, never]
  ? true
  : never = true;
void identityFieldCoverage;

export function scoredRowIdentity(row: JudgeBenchmarkRow): Omit<JudgeBenchmarkRow, "runId" | "timestamp"> {
  const { runId: _runId, timestamp: _timestamp, ...identity } = row;
  return identity;
}
