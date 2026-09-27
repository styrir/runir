import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { REQUIRED_GATE_IDS, SLICE5_GATE_IDS, summarize, writeReport } from "../testing/source-layer/report.js";
import { harmGates } from "../testing/source-layer/gates/harm.js";
import { percentiles } from "../testing/source-layer/gates/perf.js";
import type { GateResult, RunManifest } from "../testing/source-layer/types.js";

const gates: GateResult[] = [
  ...REQUIRED_GATE_IDS.map((id): GateResult => ({ id, family: id.split(".")[0] as GateResult["family"], status: "pass", counts: {} })),
  ...SLICE5_GATE_IDS.map((id): GateResult => ({ id, family: id.split(".")[0] as GateResult["family"], status: "pass", counts: {} })),
  { id: "retrieval.annotation", family: "retrieval", status: "pass", counts: { excerpts: 1 } },
  { id: "harm.annotation", family: "harm", status: "pass", counts: { excerpts: 1 } },
];
const manifest: RunManifest = {
  runId: "slice4unit", gitSha: "a".repeat(40), gitDirty: true, startedAt: "2026-01-01T00:00:00Z",
  machine: "synthetic", surrealUrl: "http://127.0.0.1:8000", surrealVersion: "synthetic",
  schemaVersion: "current", redactionVersion: 1, parserVersion: 1,
  flags: { sourceStore: "on", sourceRecall: "off" }, concurrency: 1,
  fixtureHashes: { canaries: "b".repeat(64) }, thresholds: { linkedLookupP95Ms: 100 }, inputCounts: { facts: 1 },
};
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

it("distinguishes Slice 4 completion from release readiness and fails on replay gaps", () => {
  expect(summarize(gates)).toMatchObject({ slice4Complete: true, slice5Complete: true, releaseReady: true, pendingFailClosed: 0 });
  expect(summarize([...gates, { id: "replay.queue", family: "replay", status: "fail", counts: {} }]).slice4Complete).toBe(false);
  expect(harmGates({ crossScopePass: true, correctionPass: true, injectionPass: true, shadowPass: true, sourceFailurePass: true }).map((r) => r.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
  expect(percentiles([1, 2, 3, 4, 5])).toEqual({ p50Ms: 3, p95Ms: 5, p99Ms: 5 });
});

it("writes mode-0600 count-only report and required manifest fields", async () => {
  dir = await mkdtemp(join(tmpdir(), "runir-slice4-report-"));
  const { files } = await writeReport(dir, manifest, gates);
  for (const path of Object.values(files)) {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const value = await readFile(path, "utf8");
    expect(value.includes("Bearer ")).toBe(false);
    expect(value.includes("only on Tuesday")).toBe(false);
  }
  expect(JSON.parse(await readFile(files.manifest, "utf8"))).toMatchObject({ redactionVersion: 1, parserVersion: 1, surrealVersion: "synthetic", concurrency: 1 });
  await expect(writeReport(dir, manifest, [...gates, { id: "privacy.bad", family: "privacy", status: "fail",
    counts: {}, note: "synthetic source text" }])).rejects.toThrow("unsafe gate note");
});
