/** Full in-process HTTP acceptance latency on synthetic capture-20x4k turns.
 * Fixture mode supplies an empty extraction result, so no LLM is called. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CAPTURE_20X4K } from "../../src/__tests__/fixtures/capture-20x4k.js";
import { SurrealClient } from "../../src/storage/surreal/surreal-store.js";
import { runDeploymentPreflight } from "../../src/app/readiness.js";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const namespace = `runir277bench${suffix}`;
const database = `slice2${suffix}`;
if (namespace === "main" || database === "main") throw new Error("unsafe benchmark target");
const url = process.env.RUNIR_TEST_SURREAL_URL ?? "http://127.0.0.1:18000";
const spoolDir = await mkdtemp(join(tmpdir(), "runir277-capture-latency-"));
Object.assign(process.env, {
  SURREAL_URL: url, SURREAL_USER: "root", SURREAL_PASS: "root",
  SURREAL_NS: namespace, SURREAL_DB: database,
  RUNIR_TEST_MODE: "1", RUNIR_SOURCE_HMAC_KEY: "synthetic-benchmark-key",
  RUNIR_API_KEY: "synthetic-benchmark-api-key",
  RUNIR_SOURCE_STORE: "on",
  RUNIR_SOURCE_SPOOL_DIR: spoolDir,
});
const { createApp } = await import("../../index.js");
const { runtime } = await import("../../src/app/runtime.js");
const app = createApp();
const db = new SurrealClient({ url, username: "root", password: "root", namespace, database });
const latency = { off: [] as number[], on: [] as number[] };
const oldLog = console.log;
try {
  await db.query("INFO FOR DB;");
  await runDeploymentPreflight({ db, strict: true });
  console.log = () => undefined;
  for (const mode of ["off", "on"] as const) {
    process.env.RUNIR_SOURCE_STORE = mode;
    for (let sample = 0; sample < 31; sample++) {
      const start = performance.now();
      const response = await app.request("/hooks/capture", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-benchmark-api-key" },
        body: JSON.stringify({ userId: "synthetic", client: "benchmark", disableHexis: true,
          sessionId: `sample:${mode}:${sample}`,
          messages: CAPTURE_20X4K, captureFixtureFacts: [] }),
      });
      const body = await response.json() as { error?: string; skipped?: boolean };
      if (response.status !== 200 || body.error || body.skipped !== false)
        throw new Error(`benchmark capture failed: mode=${mode} status=${response.status}`);
      if (sample > 0) latency[mode].push(performance.now() - start);
    }
  }
  console.log = oldLog;
  const percentile = (samples: number[], p: number) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return Number(sorted[Math.ceil(p * sorted.length) - 1]!.toFixed(3));
  };
  const stats = (samples: number[]) => ({
    p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99),
  });
  const off = stats(latency.off);
  const on = stats(latency.on);
  const delta = {
    p50Ms: Number((on.p50Ms - off.p50Ms).toFixed(3)),
    p95Ms: Number((on.p95Ms - off.p95Ms).toFixed(3)),
    p99Ms: Number((on.p99Ms - off.p99Ms).toFixed(3)),
  };
  let persistedTurns = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await db.query<any>("SELECT count() AS total FROM session_turn WHERE user_id = 'synthetic' GROUP ALL;");
    persistedTurns = Number(rows[0]?.[0]?.total ?? 0);
    if (persistedTurns >= 20 * 31) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (persistedTurns !== 20 * 31) throw new Error(`benchmark source persistence incomplete: ${persistedTurns}`);
  process.stdout.write(JSON.stringify({ fixture: "capture-20x4k", path: "app.request(/hooks/capture)",
    samplesPerMode: 30, concurrency: 1, machine: cpus()[0]?.model, memoryGiB: Math.round(totalmem() / 2 ** 30),
    surrealVersion: execFileSync("surreal", ["version"], { encoding: "utf8" }).trim(),
    extraction: "empty fixture result", persistedTurns, off, on, delta }) + "\n");
} finally {
  console.log = oldLog;
  await db.query(`REMOVE NAMESPACE ${namespace};`).catch(() => undefined);
  await db.close().catch(() => undefined);
  await runtime.db.close().catch(() => undefined);
  await rm(spoolDir, { recursive: true, force: true });
}
