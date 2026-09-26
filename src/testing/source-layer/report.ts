import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { GateResult, RunManifest } from "./types.js";

const REQUIRED = ["privacy", "storage", "replay"] as const;
export const REQUIRED_GATE_IDS = [
  "privacy.inventory", "storage.omitted_qualifier", "harm.cross_scope_lookup",
  "replay.pi_resend_fork", "replay.torn_line_restart", "replay.partial_db_outage",
  "replay.tombstone_pending", "replay.queue_bounded_drain", "replay.append_failure",
  "replay.claude_watermark", "replay.claude_epoch_reset", "replay.codex_watermark",
  "replay.codex_epoch_reset", "replay.app_append_unavailable", "replay.app_forget_race",
  "replay.forget_session", "replay.forget_user", "replay.forget_one_fact",
] as const;
const NOTE_CODES = new Set(["annotation_pending_slice5", "recall_off_source_emitted", "queue_cap_unenforced", "queue_64mib_case_omitted", "direct_spool_fault", "injection_pending_slice5"]);

export function summarize(results: GateResult[]) {
  const requiredPass = REQUIRED.every((family) => results.some((r) => r.family === family)
    && results.filter((r) => r.family === family).every((r) => r.status === "pass"));
  const requiredIdsPass = REQUIRED_GATE_IDS.every((id) => results.some((r) => r.id === id && r.status === "pass"));
  const pendingPresent = ["retrieval", "harm"].every((family) => results.some((r) => r.family === family && r.status === "pending_fail_closed"));
  return {
    slice4Complete: requiredPass && requiredIdsPass && pendingPresent,
    releaseReady: results.length > 0 && results.every((r) => r.status === "pass"),
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    pendingFailClosed: results.filter((r) => r.status === "pending_fail_closed").length,
  };
}

function assertCountOnly(manifest: RunManifest, results: GateResult[]): void {
  const bounded = (value: string, pattern: RegExp) => {
    if (!pattern.test(value)) throw new Error("unsafe manifest field");
  };
  bounded(manifest.runId, /^slice4[a-z0-9]{1,32}$/);
  bounded(manifest.gitSha, /^[0-9a-f]{40}$/);
  bounded(manifest.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
  bounded(manifest.machine, /^[a-zA-Z0-9 _.,()+-]{1,120}$/);
  bounded(manifest.surrealUrl, /^https?:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/);
  bounded(manifest.surrealVersion, /^[a-zA-Z0-9._/-]{1,100}$/);
  bounded(manifest.schemaVersion, /^[a-z0-9_-]{1,40}$/);
  if (manifest.flags.sourceStore !== "on" || manifest.flags.sourceRecall !== "off") throw new Error("unsafe measurement flags");
  for (const hash of Object.values(manifest.fixtureHashes)) bounded(hash, /^[0-9a-f]{64}$/);
  const numeric = (values: Record<string, number | null>) => {
    for (const [key, value] of Object.entries(values)) {
      bounded(key, /^[a-zA-Z][a-zA-Z0-9]{0,63}$/);
      if (value !== null && (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000)) throw new Error("unsafe metric");
    }
  };
  numeric(manifest.thresholds);
  numeric(manifest.inputCounts);
  for (const r of results) {
    if (!/^[a-z0-9_.-]+$/.test(r.id)) throw new Error("unsafe gate id");
    if (r.note && !NOTE_CODES.has(r.note)) throw new Error("unsafe gate note");
    numeric(r.counts);
    if (r.metrics) numeric(r.metrics);
  }
}

export async function writeReport(root: string, manifest: RunManifest, results: GateResult[]) {
  assertCountOnly(manifest, results);
  const summary = summarize(results);
  const dir = join(root, manifest.runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files = {
    manifest: join(dir, "manifest.json"), results: join(dir, "results.json"), report: join(dir, "report.md"),
  };
  const markdown = ["# Source-layer Slice 4 measurement", "", `Run: ${manifest.runId}`,
    `Slice 4 complete: ${summary.slice4Complete}`, `Release ready: ${summary.releaseReady}`, "",
    "| Gate | Family | Status | Counts | Metrics | Note |", "| --- | --- | --- | --- | --- | --- |",
    ...results.map((r) => `| ${r.id} | ${r.family} | ${r.status} | ${JSON.stringify(r.counts)} | ${JSON.stringify(r.metrics ?? {})} | ${r.note ?? ""} |`),
    "", "Direct-store and spool checks use production store functions where no HTTP route exists.",
    ...(results.some((r) => r.note === "queue_64mib_case_omitted")
      ? ["64 MiB queue case omitted: it requires at least 257 near-limit turns and a 64 MiB fsynced journal; the 1,000-turn boundary and stored-count recovery are measured."] : []),
    ""].join("\n");
  await writeFile(files.manifest, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await writeFile(files.results, JSON.stringify({ summary, results }, null, 2) + "\n", { mode: 0o600 });
  await writeFile(files.report, markdown, { mode: 0o600 });
  await Promise.all(Object.values(files).map((path) => chmod(path, 0o600)));
  return { summary, files };
}
