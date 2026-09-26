/** Synthetic, isolated Slice 4 measurement. This process never selects main. */
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { SOURCE_REDACTION_VERSION } from "../../src/shared/source-redaction.js";
import { SOURCE_FORMAT } from "../../src/capture/source-turn-identity.js";
import { loadSyntheticFixtures, OMITTED_QUALIFIER, CAPTURE_20X4K, CORRECTION_CASE, SCOPED_CASES, seedScopedFixtures, syntheticHmacKey } from "../../src/testing/source-layer/fixtures.js";
import { privacyGate } from "../../src/testing/source-layer/gates/privacy.js";
import { storageGate } from "../../src/testing/source-layer/gates/storage.js";
import { replaySpoolGates } from "../../src/testing/source-layer/gates/replay.js";
import { retrievalGate } from "../../src/testing/source-layer/gates/retrieval.js";
import { harmGates } from "../../src/testing/source-layer/gates/harm.js";
import { perfGate } from "../../src/testing/source-layer/gates/perf.js";
import { writeReport } from "../../src/testing/source-layer/report.js";
import { lookupLinkedTurns } from "../../src/storage/surreal/source-turn-lookup.js";
import { cosineSimilarity } from "../../src/shared/cosine.js";
import type { SurrealClient } from "../../src/storage/surreal/surreal-store.js";
import type { GateResult, RunManifest } from "../../src/testing/source-layer/types.js";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const startedAt = new Date().toISOString();
const namespace = `slice4${suffix}`;
const database = `slice4${suffix}`;
if (namespace === "main" || database === "main" || !/^slice4[0-9a-f]{12}$/.test(namespace)) throw new Error("unsafe measurement target");
const url = process.env.SOURCE_LAYER_MEASURE_SURREAL_URL ?? "http://127.0.0.1:8000";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("measurement requires local SurrealDB");
const spoolDir = await mkdtemp(join(tmpdir(), "runir-slice4-spool-"));
const vaultDir = await mkdtemp(join(tmpdir(), "runir-slice4-vault-"));
for (const dir of [spoolDir, vaultDir]) {
  const absolute = resolve(dir);
  if (!isAbsolute(absolute) || !absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe temporary directory");
}
Object.assign(process.env, {
  SURREAL_URL: url, SURREAL_USER: "root", SURREAL_PASS: "root", SURREAL_NS: namespace, SURREAL_DB: database,
  RUNIR_TEST_MODE: "1", RUNIR_TEST_FAKE_EMBEDDINGS: "1", RUNIR_API_KEY: randomBytes(32).toString("hex"),
  RUNIR_SOURCE_HMAC_KEY: randomBytes(32).toString("hex"), RUNIR_SOURCE_STORE: "on", RUNIR_SOURCE_RECALL: "off",
  RUNIR_SOURCE_SPOOL_DIR: spoolDir, VAULT_EXPORT_PATH: vaultDir, VAULT_TEST_EXPORT_PATH: vaultDir,
  RUNIR_SUPERSEDE_JUDGE_GATE: "off", RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM: "off",
});
for (const key of ["NOMIC_API_KEY", "EMBEDDINGS_PROVIDER", "OPENROUTER_API_KEY", "RUNIR_CAPTURE_API_KEY"]) delete process.env[key];

const logs: string[] = [];
const original = { stdout: process.stdout.write, stderr: process.stderr.write, log: console.log, warn: console.warn, error: console.error };
function tee(value: unknown) { logs.push(String(value)); return true; }
const results: GateResult[] = [];
let stage = "import";
let cleanupDb: SurrealClient | undefined;
let stopDrainForCleanup: (() => Promise<void>) | undefined;
try {
  process.stdout.write = tee as typeof process.stdout.write;
  process.stderr.write = tee as typeof process.stderr.write;
  console.log = (...args: unknown[]) => { args.forEach(tee); };
  console.warn = (...args: unknown[]) => { args.forEach(tee); };
  console.error = (...args: unknown[]) => { args.forEach(tee); };
  const { createApp } = await import("../../index.js");
  const { runtime } = await import("../../src/app/runtime.js");
  cleanupDb = runtime.db;
  if (runtime.cfg.surrealdb.namespace !== namespace || runtime.cfg.surrealdb.database !== database
    || runtime.cfg.surrealdb.namespace === "main" || runtime.cfg.surrealdb.database === "main")
    throw new Error("runtime target mismatch");
  const { runDeploymentPreflight } = await import("../../src/app/readiness.js");
  const { runVaultExport } = await import("../../src/lifecycle/archive/vault-exporter.js");
  const { sourceTurnSpoolForTesting, stopSourceDrainForTesting } = await import("../../src/app/routes/hooks/index.js");
  stopDrainForCleanup = stopSourceDrainForTesting;
  const { forgetSourceSession, forgetSourceUser, markFactSourceLink, reconcileSourceTurnLinks } = await import("../../src/storage/surreal/source-turn-link-store.js");
  const { upsertSourceTurn } = await import("../../src/storage/surreal/session-turn-store.js");
  const { prepareSourceTurn } = await import("../../src/capture/source-turn-identity.js");
  const { getLastWatermark } = await import("../../src/storage/surreal/session-watermark-store.js");
  const db = runtime.db;
  const fixtures = await loadSyntheticFixtures();
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RUNIR_API_KEY}` };
  stage = "database";
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await db.query("INFO FOR DB;"); break; }
    catch (error) {
      if (attempt === 29 || !(error instanceof Error) || !error.message.includes("Transaction conflict")) throw error;
      await new Promise((done) => setTimeout(done, Math.min(1000, 100 * (attempt + 1))));
    }
  }
  stage = "preflight";
  await runDeploymentPreflight({ db, provider: runtime.provider, strict: true });
  const app = createApp();
  const post = async (path: string, body: unknown) => app.request(path, { method: "POST", headers: auth, body: JSON.stringify(body) });
  stage = "capture";
  const safeContent = fixtures.canaries.safe.join("\n");
  const canaryContent = [...fixtures.canaries.secrets, ...fixtures.canaries.sourcePii].join("\n");
  const messages = [{ role: "user", content: `${safeContent}\nThe code name is ORCHID-42, ${OMITTED_QUALIFIER}.\n${canaryContent}`, turnIndex: 0, sessionEpoch: "epoch-1" }];
  const captured = await post("/hooks/capture", { userId: "synthetic-A", client: "claude", sessionId: "synthetic-primary",
    disableHexis: true, messages, captureFixtureFacts: [{ l2: "The synthetic code name is ORCHID-42.", confidence: 0.99, source_turn_index: 0 }] });
  const capture = await captured.json() as { units?: Array<{ id?: string }>; factsFound?: number };
  const factId = capture.units?.[0]?.id;
  if (captured.status !== 200 || !factId) throw new Error("synthetic capture fact missing");
  const paired = await post("/hooks/capture", { userId: "synthetic-A", client: "codex", sessionId: "synthetic-paired-pii",
    disableHexis: true, messages: [{ role: "user", content: `Synthetic support contact ${fixtures.canaries.pairedEmail}.`, turnIndex: 0, sessionEpoch: "e" }],
    captureFixtureFacts: [{ l2: `The synthetic support contact is ${fixtures.canaries.pairedEmail}.`, confidence: 0.99, source_turn_index: 0 }] });
  if (paired.status !== 200) throw new Error("synthetic paired PII capture failed");
  const correctionOutcomes: Array<{ created: number; superseded: number; skipped: number; merged: number; factsFound: number }> = [];
  const correctionIds: string[] = [];
  for (const [index, factText] of [CORRECTION_CASE.older, CORRECTION_CASE.newer].entries()) {
    const correctionCapture = await post("/hooks/capture", { userId: "synthetic-correction", client: "codex",
      sessionId: `correction-${index}`, disableHexis: true,
      messages: [{ role: "user", content: factText, turnIndex: 0, sessionEpoch: "e" }],
      captureFixtureFacts: [{ l2: factText, l0: "synthetic release window", confidence: 0.99, source_turn_index: 0,
        atomicFact: { subject: CORRECTION_CASE.subject, predicate: CORRECTION_CASE.predicate,
          value: index === 0 ? CORRECTION_CASE.olderValue : CORRECTION_CASE.newerValue } }] });
    if (correctionCapture.status !== 200) throw new Error("synthetic correction capture failed");
    const correctionBody = await correctionCapture.json() as { outcomes?: Record<string, number>; factsFound?: number; units?: Array<{ id?: string }> };
    if (correctionBody.units?.[0]?.id) correctionIds.push(correctionBody.units[0].id);
    correctionOutcomes.push({ created: correctionBody.outcomes?.create ?? 0,
      superseded: correctionBody.outcomes?.supersede ?? 0, skipped: correctionBody.outcomes?.skip ?? 0,
      merged: correctionBody.outcomes?.["merge-update"] ?? 0, factsFound: correctionBody.factsFound ?? 0 });
  }
  let fact: Record<string, any> | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    fact = (await db.query<Record<string, any>>("SELECT * FROM type::record('semiote', $id);", { id: factId.replace(/^semiote:/, "") }))[0]?.[0];
    if (fact?.source_turn_link_state === "linked") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  results.push(await storageGate(db, factId, "synthetic-A", {
    turnId: String(fact?.source_turn_id ?? ""), epoch: "epoch-1", fingerprint: String(fact?.source_turn_key_fingerprint ?? "") }));
  const query = { userId: "synthetic-A", scope: "user" as const, factId, maxChunks: 8 };
  const lookupMs: number[] = [];
  for (let i = 0; i < 30; i++) { const start = performance.now(); await lookupLinkedTurns(db, query); lookupMs.push(performance.now() - start); }
  const foreign = await lookupLinkedTurns(db, { ...query, userId: "synthetic-B" });
  const scopeCases = SCOPED_CASES;
  stage = "seed";
  await seedScopedFixtures(db, syntheticHmacKey());
  let scopedLeaks = foreign.length;
  let scopedVisible = 0;
  for (const item of scopeCases) {
    const owner = item.id === "other-user" ? "synthetic-B" : "synthetic-A";
    const id = `scope_${item.id.replace(/-/g, "_")}`;
    const exact = { userId: owner, scope: item.scope, factId: id, sessionId: item.sessionId,
      teamId: item.teamId, projectKey: item.projectKey, path: item.path, maxChunks: 4 };
    scopedVisible += (await lookupLinkedTurns(db, exact)).length;
    scopedLeaks += (await lookupLinkedTurns(db, { ...exact, userId: owner === "synthetic-A" ? "synthetic-B" : "synthetic-A" })).length;
    scopedLeaks += (await lookupLinkedTurns(db, { ...exact, scope: "user", sessionId: "other", path: "src/other-path.ts" })).length;
    if (item.teamId) scopedLeaks += (await lookupLinkedTurns(db, { ...exact, teamId: "foreign-T" })).length;
    if (item.projectKey) scopedLeaks += (await lookupLinkedTurns(db, { ...exact, projectKey: "foreign-P" })).length;
  }
  const recallResponse = await post("/hooks/recall", { userId: "synthetic-A", sessionId: "synthetic-primary", prompt: "ORCHID-42" });
  stage = "recall";
  const recall = await recallResponse.json();
  const quoteRecall = await (await post("/hooks/recall", { userId: "synthetic-A", sessionId: "synthetic-primary", prompt: "only on Tuesday" })).json();
  const paraphraseRecall = await (await post("/hooks/recall", { userId: "synthetic-A", sessionId: "synthetic-primary", prompt: "Which weekday limits the code?" })).json();
  const correctionRecall = await (await post("/hooks/recall", { userId: "synthetic-correction", prompt: CORRECTION_CASE.query })).json();
  const correctionContext = String((correctionRecall as { prependContext?: string }).prependContext ?? "");
  const newerAt = correctionContext.indexOf(CORRECTION_CASE.newer);
  const olderAt = correctionContext.indexOf(CORRECTION_CASE.older);
  const correctionRows: Array<{ payload?: { l2?: string }; active?: boolean; superseded_by?: unknown }> = [];
  for (const id of correctionIds) correctionRows.push(...(await db.query<typeof correctionRows[number]>(
    "SELECT * FROM type::record('semiote', $id);", { id: id.replace(/^semiote:/, "") }))[0] ?? []);
  const olderRow = correctionRows.find((row) => row.payload?.l2 === CORRECTION_CASE.older);
  const newerRow = correctionRows.find((row) => row.payload?.l2 === CORRECTION_CASE.newer);
  const cosine = cosineSimilarity(await runtime.provider.embedDocument(CORRECTION_CASE.older),
    await runtime.provider.embedDocument(CORRECTION_CASE.newer));
  results.push({ id: "harm.newer_correction", family: "harm", status: cosine < 0.95 && Boolean(newerRow)
    && newerRow?.active === true && Boolean(olderRow) && olderRow?.active === false
    && Boolean(olderRow?.superseded_by) && correctionOutcomes[1]?.superseded === 1 ? "pass" : "fail",
    counts: { newerPresent: Number(newerAt >= 0), olderPresent: Number(olderAt >= 0), newerFirst: Number(newerAt >= 0 && (olderAt < 0 || newerAt < olderAt)),
      newerStored: Number(Boolean(newerRow)), olderStored: Number(Boolean(olderRow)), newerActive: Number(newerRow?.active === true),
      olderActive: Number(olderRow?.active === true), olderSuperseded: Number(Boolean(olderRow?.superseded_by)),
      olderCreated: correctionOutcomes[0]?.created ?? 0, newerSupersedeOutcome: correctionOutcomes[1]?.superseded ?? 0,
      newerSkipOutcome: correctionOutcomes[1]?.skipped ?? 0, newerCreateOutcome: correctionOutcomes[1]?.created ?? 0,
      newerMergeOutcome: correctionOutcomes[1]?.merged ?? 0, correctionUnitIds: correctionIds.length,
      correctionRows: correctionRows.length, cosine: Number(cosine.toFixed(4)) } });
  // Source recall is off. No source-excerpt field is allowed to appear in this response.
  const recallSerialized = JSON.stringify([recall, quoteRecall, paraphraseRecall, correctionRecall]);
  const sourceExcerptCount = (recallSerialized.match(/source_excerpt|sourceExcerpt|source_turn_id/gi)?.length ?? 0)
    + Number(recallSerialized.includes(fixtures.canaries.safe[0] ?? "__missing_fixture__"));
  const factNeedle = "The synthetic code name is ORCHID-42.";
  const factHit = (body: unknown) => Number(String((body as { prependContext?: string }).prependContext ?? "").includes(factNeedle));
  results.push(retrievalGate(sourceExcerptCount, 4, { identifier: factHit(recall), quote: factHit(quoteRecall),
    paraphrase: factHit(paraphraseRecall) }), ...harmGates(scopedLeaks === 0 && scopedVisible === scopeCases.length, sourceExcerptCount));
  results.find((r) => r.id === "harm.cross_scope_lookup")!.counts = { variants: scopeCases.length, visible: scopedVisible, foreignExcerpts: scopedLeaks };
  await runVaultExport(db, vaultDir, { userId: "synthetic-A" });
  stage = "vault";
  const vaultTexts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) vaultTexts.push(await readFile(path, "utf8"));
    }
  };
  await walk(vaultDir);
  results.push(await privacyGate(db, fixtures.canaries, { recallJson: [recall, quoteRecall, paraphraseRecall, correctionRecall], logs: logs.join("\n"), vaultTexts }));
  original.stderr.call(process.stderr, "source-layer stage: replay gates\n");
  await stopSourceDrainForTesting();
  const singletonForReplay = sourceTurnSpoolForTesting();
  results.push(...await replaySpoolGates({ db, databaseUrl: url, namespace, database, spool: singletonForReplay,
    routeSnapshot: async () => {
      const response = await app.request("/hooks/source-spool", { headers: auth });
      if (response.status !== 200) throw new Error("source spool snapshot route failed");
      return response.json();
    } }));
  stage = "performance";
  original.stderr.call(process.stderr, "source-layer stage: performance gates\n");
  results.push(perfGate("perf.linked_lookup", lookupMs, 100));
  const captureMs = { off: [] as number[], on: [] as number[] };
  const cpuBefore = process.cpuUsage();
  const captureDelta: number[] = [];
  for (let sample = 0; sample < 31; sample++) {
    const pair: { off?: number; on?: number } = {};
    for (const mode of (sample % 2 === 0 ? ["off", "on"] : ["on", "off"]) as Array<"off" | "on">) {
      process.env.RUNIR_SOURCE_STORE = mode;
      const start = performance.now();
      const response = await post("/hooks/capture", { userId: "synthetic-perf", client: "codex",
        sessionId: `synthetic-perf-${mode}-${sample}`, disableHexis: true, messages: CAPTURE_20X4K,
        captureFixtureFacts: [{ l2: `Synthetic benchmark fact ${mode} ${sample} is stable.`, confidence: 0.99, source_turn_index: 0 }] });
      const body = await response.json() as { skipped?: boolean; factsFound?: number };
      if (response.status !== 200 || body.skipped !== false || !body.factsFound) throw new Error("synthetic capture performance request failed");
      if (sample) { pair[mode] = performance.now() - start; captureMs[mode].push(pair[mode]); }
    }
    if (sample) captureDelta.push(pair.on! - pair.off!);
    if (sample % 10 === 0) original.stderr.call(process.stderr, `source-layer performance pairs: ${sample}\n`);
  }
  process.env.RUNIR_SOURCE_STORE = "on";
  const cpu = process.cpuUsage(cpuBefore);
  const offP95 = perfGate("perf.capture_off", captureMs.off);
  const onP95 = perfGate("perf.capture_on", captureMs.on);
  const pairedStats = perfGate("perf.capture_added", captureDelta, 20);
  const addedP95 = pairedStats.metrics?.p95Ms ?? 0;
  results.push(offP95, onP95, { id: "perf.capture_added", family: "perf", status: addedP95 < 20 ? "pass" : "fail",
    counts: { samplesPerMode: 30, pairs: captureDelta.length, concurrency: 1 }, metrics: {
      addedP95Ms: Number(addedP95.toFixed(3)), medianDeltaMs: pairedStats.metrics?.p50Ms ?? null, targetMs: 20,
      offP50Ms: offP95.metrics?.p50Ms ?? null, offP95Ms: offP95.metrics?.p95Ms ?? null, offP99Ms: offP95.metrics?.p99Ms ?? null,
      onP50Ms: onP95.metrics?.p50Ms ?? null, onP95Ms: onP95.metrics?.p95Ms ?? null, onP99Ms: onP95.metrics?.p99Ms ?? null,
      cpuUserMs: Number((cpu.user / 1000).toFixed(3)), cpuSystemMs: Number((cpu.system / 1000).toFixed(3)) } });
  original.stderr.call(process.stderr, `source-layer performance pending before drain: ${singletonForReplay.snapshot().pending}\n`);
  for (let drainAttempt = 0; singletonForReplay.snapshot().pending > 0 && drainAttempt < 8; drainAttempt++) {
    await singletonForReplay.drain(async (turn) => {
      await upsertSourceTurn(db, turn);
      await reconcileSourceTurnLinks(db, turn);
    });
  }
  original.stderr.call(process.stderr, `source-layer performance pending after drain: ${singletonForReplay.snapshot().pending}\n`);
  let spool = {} as { pending?: number; pendingBytes?: number; oldestPendingAgeMs?: number;
    appended?: number; replayed?: number; appendFailures?: number; persistFailures?: number; conflicts?: number };
  const drainDeadline = Date.now() + 60_000;
  do {
    const spoolResponse = await app.request("/hooks/source-spool", { headers: auth });
    spool = await spoolResponse.json() as typeof spool;
    if (spool.pending === 0) break;
    await new Promise((done) => setTimeout(done, 250));
  } while (Date.now() < drainDeadline);
  const tableCounts = await db.query<{ total: number }>("SELECT count() AS total FROM session_turn GROUP ALL; SELECT count() AS total FROM session_turn_chunk GROUP ALL;");
  const turnCount = Number(tableCounts[0]?.[0]?.total ?? 0);
  const indexes = (await db.query<Record<string, unknown>>("INFO FOR TABLE session_turn;"))[0]?.[0]?.indexes;
  const indexDefinitions = indexes && typeof indexes === "object" ? Object.keys(indexes).length : 0;
  const spoolTurnCount = turnCount - scopeCases.length - 1; // direct outage recovery row
  results.push({ id: "perf.load_counters", family: "perf", status: (spool.appendFailures ?? 0) === 0 && spool.pending === 0 && spoolTurnCount === spool.appended ? "pass" : "fail",
    counts: { turns: Number(tableCounts[0]?.[0]?.total ?? 0), chunks: Number(tableCounts[1]?.[0]?.total ?? 0),
      pending: spool.pending ?? 0, appended: spool.appended ?? 0, replayed: spool.replayed ?? 0,
      appendFailures: spool.appendFailures ?? 0, persistFailures: spool.persistFailures ?? 0, conflicts: spool.conflicts ?? 0,
      indexDefinitions, directSeedTurns: scopeCases.length, fixtureSpoolLoss: Math.max(0, (spool.appended ?? 0) - spoolTurnCount),
      sourceTokens: 0 }, metrics: { pendingBytes: spool.pendingBytes ?? 0, oldestPendingAgeMs: spool.oldestPendingAgeMs ?? 0 } });
  results.push({ id: "perf.source_tokens", family: "perf", status: "pending_fail_closed", counts: { injectedTokens: 0 },
    metrics: { targetMaxTokens: 360 }, note: "injection_pending_slice5" });
  stage = "route replay";
  const waitTurnCount = async (userId: string, sessionId: string, expected: number): Promise<number> => {
    let count = 0;
    const until = Date.now() + 15_000;
    do {
      count = Number((await db.query<{ total: number }>("SELECT count() AS total FROM session_turn WHERE user_id = $userId AND session_id = $sessionId GROUP ALL;",
        { userId, sessionId }))[0]?.[0]?.total ?? 0);
      if (count >= expected) break;
      await new Promise((done) => setTimeout(done, 100));
    } while (Date.now() < until);
    return count;
  };
  for (const client of ["claude", "codex"] as const) {
    const sessionId = `synthetic-replay-${client}`;
    const message = { role: "user", content: `Synthetic ${client} watermark turn`, turnIndex: 0, sessionEpoch: "epoch-1" };
    const body = { userId: "synthetic-replay", client, sessionId, disableHexis: true, messages: [message], captureFixtureFacts: [] };
    const first = await post("/hooks/capture", body);
    const captureResend = await post("/hooks/capture", body);
    const dedupedCount = await waitTurnCount("synthetic-replay", sessionId, 1);
    results.push({ id: `replay.${client}_capture_resend_dedupe`, family: "replay",
      status: first.status === 200 && captureResend.status === 200 && dedupedCount === 1 ? "pass" : "fail",
      counts: { captureCalls: 2, turns: dedupedCount } });
    const end = await post("/hooks/session-end", { userId: "synthetic-replay", client, sessionId, messageOffset: 1, messages: [message] });
    const watermarkBefore = await getLastWatermark(db, sessionId, "synthetic-replay");
    const coveredNewKey = { ...message, content: `Synthetic ${client} covered new key`, turnIndex: 99 };
    const resend = await post("/hooks/session-end", { userId: "synthetic-replay", client, sessionId,
      messageOffset: 1, messages: [coveredNewKey] });
    const resendBody = await resend.json() as { skipped?: boolean; reason?: string };
    const watermarkAfter = await getLastWatermark(db, sessionId, "synthetic-replay");
    const count = await waitTurnCount("synthetic-replay", sessionId, 1);
    results.push({ id: `replay.${client}_watermark`, family: "replay", status: first.status === 200
      && end.status === 200 && resend.status === 200 && resendBody.skipped === true
      && resendBody.reason === "no new messages since last watermark" && watermarkBefore?.message_count === 1
      && watermarkAfter?.message_count === 1 && count === 1 ? "pass" : "fail",
      counts: { turns: count, sessionEndCalls: 2, skipped: Number(resendBody.skipped === true),
        watermarkBefore: watermarkBefore?.message_count ?? 0, watermarkAfter: watermarkAfter?.message_count ?? 0,
        coveredNewKeyLanded: Number(count > 1) } });
    const next = await post("/hooks/capture", { ...body, messages: [{ ...message, sessionEpoch: "epoch-2" }] });
    await waitTurnCount("synthetic-replay", sessionId, 2);
    const epochs = (await db.query<{ session_epoch: string }>("SELECT session_epoch FROM session_turn WHERE user_id = $userId AND session_id = $sessionId;",
      { userId: "synthetic-replay", sessionId }))[0] ?? [];
    results.push({ id: `replay.${client}_epoch_reset`, family: "replay", status: next.status === 200 && new Set(epochs.map((r) => r.session_epoch)).size === 2 ? "pass" : "fail",
      counts: { turns: epochs.length, epochs: new Set(epochs.map((r) => r.session_epoch)).size } });
  }
  stage = "append fault";
  const singletonSpool = sourceTurnSpoolForTesting();
  const journal = join(spoolDir, "turns.jsonl");
  const savedJournal = join(spoolDir, "turns.saved.jsonl");
  await rename(journal, savedJournal);
  await mkdir(journal);
  const appendBefore = singletonSpool.snapshot().appendFailures;
  let faultFactId: string | undefined;
  try {
    const response = await post("/hooks/capture", { userId: "synthetic-fault", client: "claude", sessionId: "fault",
      disableHexis: true, messages: [{ role: "user", content: "Synthetic append fault turn", turnIndex: 0, sessionEpoch: "e" }],
      captureFixtureFacts: [{ l2: "Synthetic append fault fact persists without its source.", confidence: 0.99, source_turn_index: 0 }] });
    const body = await response.json() as { units?: Array<{ id?: string }> };
    faultFactId = body.units?.[0]?.id;
  } finally {
    await rm(journal, { recursive: true, force: true });
    await rename(savedJournal, journal);
  }
  const fault = faultFactId ? (await db.query<{ source_turn_link_state?: string }>(
    "SELECT source_turn_link_state FROM type::record('semiote', $id);", { id: faultFactId.replace(/^semiote:/, "") }))[0]?.[0] : undefined;
  const appendDelta = singletonSpool.snapshot().appendFailures - appendBefore;
  results.push({ id: "replay.app_append_unavailable", family: "replay", status: appendDelta > 0 && fault?.source_turn_link_state === "unavailable" ? "pass" : "fail",
    counts: { appendFailuresDelta: appendDelta, unavailableFacts: Number(fault?.source_turn_link_state === "unavailable") } });
  stage = "forget";
  const pendingTurn = prepareSourceTurn({ userId: "synthetic-forget", client: "pi", sessionId: "pending-session", sessionEpoch: "e",
    turnKey: "pi:pending", role: "user", content: "Synthetic pending forget turn", occurredAt: new Date().toISOString(), scope: "user" }, syntheticHmacKey());
  const pendingBefore = singletonSpool.snapshot().pending;
  const appendAccepted = await singletonSpool.append(pendingTurn);
  const pendingAfterAppend = singletonSpool.snapshot().pending;
  stage = "forget pending";
  await forgetSourceSession(db, "synthetic-forget", "pending-session", singletonSpool);
  const pendingAfter = singletonSpool.snapshot().pending;
  await singletonSpool.drain((turn) => upsertSourceTurn(db, turn));
  const forgottenPending = (await db.query<{ total: number }>("SELECT count() AS total FROM session_turn WHERE user_id = 'synthetic-forget' GROUP ALL;"))[0]?.[0]?.total ?? 0;
  results.push({ id: "replay.app_forget_race", family: "replay", status: appendAccepted
    && pendingAfterAppend === pendingBefore + 1 && pendingAfter === pendingBefore && Number(forgottenPending) === 0 ? "pass" : "fail",
    counts: { appendAccepted: Number(appendAccepted), pendingBefore, pendingAfterAppend, pendingAfter,
      resurrected: Number(forgottenPending) } });
  stage = "forget session";
  await forgetSourceSession(db, "synthetic-A", "synthetic-primary", singletonSpool);
  stage = "forget session verify";
  const forgotten = await db.query<{ total: number }>(
    "SELECT count() AS total FROM session_turn WHERE user_id = $userId AND session_id = $sessionId GROUP ALL; SELECT count() AS total FROM session_turn_chunk WHERE user_id = $userId AND turn_id = $turnId GROUP ALL; SELECT count() AS total FROM source_turn_evidence WHERE user_id = $userId AND turn_id = $turnId GROUP ALL;",
    { userId: "synthetic-A", sessionId: "synthetic-primary", turnId: String(fact?.source_turn_id ?? "") });
  const factAfter = (await db.query<{ source_turn_id?: string }>("SELECT source_turn_id FROM type::record('semiote', $id);", { id: factId.replace(/^semiote:/, "") }))[0]?.[0];
  results.push({ id: "replay.forget_session", family: "replay", status: forgotten.every((rows) => Number(rows[0]?.total ?? 0) === 0) && !factAfter?.source_turn_id ? "pass" : "fail",
    counts: { turns: Number(forgotten[0]?.[0]?.total ?? 0), chunks: Number(forgotten[1]?.[0]?.total ?? 0),
      evidence: Number(forgotten[2]?.[0]?.total ?? 0), links: Number(Boolean(factAfter?.source_turn_id)) } });
  const userTurn = prepareSourceTurn({ userId: "synthetic-delete-user", client: "pi", sessionId: "delete-user", sessionEpoch: "e",
    turnKey: "pi:user", role: "user", content: "Synthetic user deletion turn", occurredAt: new Date().toISOString(), scope: "user" }, syntheticHmacKey());
  await db.query("CREATE semiote:delete_user SET user_id = 'synthetic-delete-user', scope = 'user', payload = { l2: 'synthetic fact' }, created_at = time::now(), updated_at = time::now();");
  await upsertSourceTurn(db, userTurn);
  stage = "forget user link";
  await markFactSourceLink(db, "delete_user", "synthetic-delete-user", userTurn, "pending");
  await reconcileSourceTurnLinks(db, userTurn);
  stage = "forget user";
  await forgetSourceUser(db, "synthetic-delete-user", singletonSpool);
  stage = "forget user verify";
  const userRows = await db.query<{ total: number }>("SELECT count() AS total FROM session_turn WHERE user_id = 'synthetic-delete-user' GROUP ALL; SELECT count() AS total FROM session_turn_chunk WHERE user_id = 'synthetic-delete-user' GROUP ALL;");
  results.push({ id: "replay.forget_user", family: "replay", status: userRows.every((rows) => Number(rows[0]?.total ?? 0) === 0) ? "pass" : "fail",
    counts: { turns: Number(userRows[0]?.[0]?.total ?? 0), chunks: Number(userRows[1]?.[0]?.total ?? 0) } });
  stage = "fact forget route";
  const sharedTurn = prepareSourceTurn({ userId: "synthetic-fact-forget", client: "pi", sessionId: "shared",
    sessionEpoch: "e", turnKey: "pi:shared", role: "user", content: "Synthetic shared linked turn",
    occurredAt: new Date().toISOString(), scope: "user" }, syntheticHmacKey());
  await upsertSourceTurn(db, sharedTurn);
  for (const id of ["route_forget_one", "route_forget_two"]) {
    await db.query("CREATE type::record('semiote', $id) CONTENT { user_id: 'synthetic-fact-forget', scope: 'user', payload: { l2: 'synthetic linked fact' }, created_at: time::now(), updated_at: time::now() };", { id });
    await markFactSourceLink(db, id, "synthetic-fact-forget", sharedTurn, "pending");
  }
  await reconcileSourceTurnLinks(db, sharedTurn);
  const forgetRoute = await post("/memory/forget", { userId: "synthetic-fact-forget", memoryId: "route_forget_one", hardDelete: true });
  const remainingFact = (await db.query<{ source_turn_id?: string }>("SELECT source_turn_id FROM semiote:route_forget_two;"))[0]?.[0];
  const remainingTurn = (await db.query<Record<string, unknown>>("SELECT id FROM type::record('session_turn', $id);", { id: sharedTurn.id }))[0]?.length ?? 0;
  results.push({ id: "replay.forget_one_fact", family: "replay", status: forgetRoute.status === 200 && remainingFact?.source_turn_id === sharedTurn.id && remainingTurn === 1 ? "pass" : "fail",
    counts: { routeStatus: forgetRoute.status, remainingLinks: Number(remainingFact?.source_turn_id === sharedTurn.id), remainingTurns: remainingTurn } });
  const version = await fetch(`${url}/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.text()).catch(() => "unknown");
  stage = "report";
  const manifest: RunManifest = { runId: namespace, gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    gitDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    startedAt, machine: cpus()[0]?.model ?? "unknown", surrealUrl: url,
    surrealVersion: version.trim().slice(0, 100), schemaVersion: "preflight-current", redactionVersion: SOURCE_REDACTION_VERSION,
    parserVersion: SOURCE_FORMAT, flags: { sourceStore: "on", sourceRecall: "off" }, concurrency: 1,
    fixtureHashes: fixtures.hashes, thresholds: { captureAddedP95Ms: 20, linkedLookupP95Ms: 100, sourceTokens: 360, fixtureSpoolLoss: 0 },
    inputCounts: { ...fixtures.inputCounts, capturedFacts: Number(capture.factsFound ?? 0), adjudicatedPairs: 1, correctionPairs: 1 } };
  const output = await writeReport(join(process.cwd(), ".styrir/analysis/source-layer"), manifest, results);
  original.stdout.call(process.stdout, JSON.stringify({ runId: namespace, summary: output.summary, gates: results.map((r) => ({ id: r.id, status: r.status })) }) + "\n");
  if (!output.summary.slice4Complete) process.exitCode = 1;
} catch (error) {
  const kind = error instanceof Error ? error.name : "unknown";
  const detail = (stage === "database" || stage.includes("verify")) && error instanceof Error
    ? error.message.replace(/[^a-zA-Z0-9 .:_-]/g, "").slice(0, 180) : "";
  original.stderr.call(process.stderr, `source-layer measurement failed at ${stage} (${kind}) ${detail}; no source values printed\n`);
  process.exitCode = 1;
} finally {
  process.stdout.write = original.stdout;
  process.stderr.write = original.stderr;
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
  process.env.RUNIR_SOURCE_STORE = "off";
  await stopDrainForCleanup?.().catch(() => { process.exitCode = 1; });
  let removed = !cleanupDb;
  for (let attempt = 0; cleanupDb && attempt < 20; attempt++) {
    try { await cleanupDb.query(`REMOVE NAMESPACE ${namespace};`); removed = true; break; }
    catch {
      await new Promise((done) => setTimeout(done, Math.min(1000, 100 * (attempt + 1))));
    }
  }
  if (!removed) {
    original.stderr.call(process.stderr, `source-layer namespace cleanup failed for ${namespace}\n`);
    process.exitCode = 1;
  }
  await cleanupDb?.close().catch(() => undefined);
  await rm(spoolDir, { recursive: true, force: true });
  await rm(vaultDir, { recursive: true, force: true });
}
