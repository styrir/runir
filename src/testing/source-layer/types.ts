export type GateStatus = "pass" | "fail" | "pending_fail_closed";
export type GateFamily = "privacy" | "storage" | "replay" | "retrieval" | "harm" | "perf";
export type GateResult = {
  id: string;
  family: GateFamily;
  status: GateStatus;
  counts: Record<string, number>;
  metrics?: Record<string, number | null>;
  note?: string;
};

export type RunManifest = {
  runId: string;
  gitSha: string;
  gitDirty: boolean;
  startedAt: string;
  machine: string;
  surrealUrl: string;
  surrealVersion: string;
  schemaVersion: string;
  redactionVersion: number;
  parserVersion: number;
  flags: { sourceStore: "on"; sourceRecall: "off" };
  concurrency: number;
  fixtureHashes: Record<string, string>;
  thresholds: Record<string, number>;
  inputCounts: Record<string, number>;
};
