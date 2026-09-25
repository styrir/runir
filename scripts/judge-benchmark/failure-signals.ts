#!/usr/bin/env npx tsx
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset, parseLabelsJson } from "../../src/testing/judge-benchmark/dataset.js";
import { labelsPathFor, textsPathFor } from "../../src/testing/judge-benchmark/paths.js";
import { isHarmfulOutcome } from "../../src/testing/judge-benchmark/score.js";
import type { JudgeBenchmarkRow } from "../../src/testing/judge-benchmark/types.js";
import { absent, auc, captureEqual, categoryDifference, clusterBootstrap, contextSignal, contrastLevel, ENUMS, present, quantile, shortBefore, storedCosine, textSignals, timeBucket, timeGap, validatePrivateArtifact, type Signal } from "../../src/testing/judge-benchmark/failure-signals.js";

const ROOT = ".styrir/analysis/judge-benchmark";
const OUT = join(ROOT, "failure-groups");
const SNAPSHOT = join(OUT, "db-snapshot.json");
const SIGNALS = join(OUT, "signals.jsonl");
const REPORT = join(OUT, "signals-report.md");
const DATASET = "supersession-shadow-v1";
const SHADOW_IDS = /^shadow-snapshot:([A-Za-z0-9_-]+)$/u;
const UUID = /^[0-9a-f-]{36}$/u;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const round = (x: number) => Number(x.toFixed(6));
const fmt = (x: number | null) => x === null ? "n/a" : x.toFixed(3);
const iso = (x: unknown): string | null => {
  if (typeof x !== "string") return null;
  const d = new Date(x);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
const str = (x: unknown): string | null => typeof x === "string" && x.length ? x : null;
const id = (x: unknown): string | null => {
  if (typeof x === "string") return x.replace(/^semiote:/u, "").replace(/^⟨|⟩$/gu, "");
  if (x && typeof x === "object" && "id" in x) return str((x as { id: unknown }).id);
  return null;
};
type DbRecord = { id: string; session_id?: unknown; project_key?: unknown; created_at?: unknown; provenance?: { extraction?: { capturedAt?: unknown } }; embedding?: unknown };
type Shadow = { id: string; occurred_at?: unknown; session_id?: unknown; applied_outcome?: unknown; applied_memory_id?: unknown; would_matched_id?: unknown; would_outcome?: unknown; would_band?: unknown };
type SnapshotRow = { pairId: string; cluster: number; oldCreatedAt: string | null; occurredAt: string | null; sameSession: Signal<boolean>; capturedAtEqual: Signal<boolean>; sameProject: Signal<boolean>; storedCosine: Signal<number>; appliedOutcome: Signal<string>; wouldOutcome: Signal<string>; wouldBand: Signal<string> };
type Snapshot = { fetchedAt: string; namespaceVerified: boolean; namespaceOverlapCount: number; rows: SnapshotRow[] };
const enumSignal = (v: unknown, role: string): Signal<string> => contextSignal(str(v), role, ENUMS);
const equality = (a: unknown, b: unknown): Signal<boolean> => str(a) && str(b) ? present(a === b) : absent("missing_value");

async function fetchSnapshot(pairIds: readonly { pairId: string; shadowId: string; oldId: string | null; snapshotRole: string }[]): Promise<Snapshot> {
  const shadowIds = pairIds.map((x) => x.shadowId);
  if (shadowIds.some((x) => !/^[A-Za-z0-9_-]+$/u.test(x))) throw new Error("invalid shadow id");
  const sql = `SELECT meta::id(id) AS id, occurred_at, session_id, applied_outcome, applied_memory_id, would_matched_id, would_outcome, would_band FROM supersede_shadow WHERE meta::id(id) IN ${JSON.stringify(shadowIds)}; SELECT meta::id(id) AS id, session_id, project_key, created_at, provenance, embedding FROM semiote WHERE user_id = 'brooks';`;
  const auth = Buffer.from(`${process.env.SURREAL_USER ?? "root"}:${process.env.SURREAL_PASS ?? "root"}`).toString("base64");
  const response = await fetch("http://127.0.0.1:8000/sql", { method: "POST", headers: { Accept: "application/json", Authorization: `Basic ${auth}`, "surreal-ns": "main", "surreal-db": "main" }, body: sql, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`local database HTTP ${response.status}`);
  const body = await response.json() as Array<{ status?: string; result?: unknown }>;
  if (body.length !== 2 || body.some((x) => x.status !== "OK" || !Array.isArray(x.result))) throw new Error("local database SELECT failed");
  const shadows = new Map((body[0]!.result as Shadow[]).map((x) => [String(x.id), x]));
  const semiotes = new Map((body[1]!.result as DbRecord[]).map((x) => [String(x.id), x]));
  const sessions = new Set([...semiotes.values()].map((x) => str(x.session_id)).filter((x): x is string => x !== null));
  const namespaceOverlapCount = [...shadows.values()].filter((x) => { const s = str(x.session_id); return s !== null && sessions.has(s); }).length;
  const namespaceVerified = namespaceOverlapCount > 0;
  const oldIds = [...new Set(pairIds.map((x) => x.oldId).filter((x): x is string => x !== null))].sort();
  const cluster = new Map(oldIds.map((x, i) => [x, i + 1]));
  const rows = pairIds.map(({ pairId, shadowId, oldId, snapshotRole }) => {
    const shadow = shadows.get(shadowId), old = oldId ? semiotes.get(oldId) : undefined;
    const applied = shadow ? semiotes.get(id(shadow.applied_memory_id) ?? "") : undefined;
    const outcome = str(shadow?.applied_outcome) ?? "none";
    if (!ENUMS.has(outcome)) throw new Error("unknown applied outcome");
    const oldCaptured = iso(old?.provenance?.extraction?.capturedAt);
    const appliedCaptured = iso(applied?.provenance?.extraction?.capturedAt);
    const cosine = storedCosine(Array.isArray(old?.embedding) ? old.embedding as number[] : null, Array.isArray(applied?.embedding) ? applied.embedding as number[] : null, outcome);
    return { pairId, cluster: cluster.get(oldId ?? "") ?? 0, oldCreatedAt: iso(old?.created_at), occurredAt: iso(shadow?.occurred_at), sameSession: !namespaceVerified ? absent<boolean>("namespace_unverified") : !old || !shadow ? absent<boolean>("missing_record") : equality(shadow.session_id, old.session_id), capturedAtEqual: outcome !== "create" && outcome !== "supersede" ? absent<boolean>("not_applicable") : !old || !shadow ? absent<boolean>("missing_record") : captureEqual(outcome, oldCaptured, appliedCaptured), sameProject: !old ? absent<boolean>("missing_record") : !applied ? absent<boolean>("not_applicable") : equality(old.project_key, applied.project_key), storedCosine: cosine.value === null ? cosine : present(round(cosine.value)), appliedOutcome: enumSignal(shadow?.applied_outcome, snapshotRole), wouldOutcome: enumSignal(shadow?.would_outcome, snapshotRole), wouldBand: enumSignal(shadow?.would_band, snapshotRole) };
  }).sort((a, b) => a.pairId.localeCompare(b.pairId));
  return { fetchedAt: new Date().toISOString(), namespaceVerified, namespaceOverlapCount, rows };
}

type SignalRow = ReturnType<typeof makeSignalRow>;
function makeSignalRow(row: JudgeBenchmarkRow, oldText: string, newText: string, db: SnapshotRow, role: string) {
  const text = textSignals(oldText, newText);
  const gap = timeGap(db.occurredAt, db.oldCreatedAt);
  const numeric = (x: number) => present(round(x));
  const group = isHarmfulOutcome(row.outcome!) ? "harmful" : row.outcome === "correct_keep" ? "baseline" : "other";
  return { pairId: row.pairId, cluster: db.cluster, outcome: row.outcome, gold: row.gold.label, group, snapshotRole: role,
    indistinguishable: text.indistinguishable, sameSession: db.sameSession, capturedAtEqual: db.capturedAtEqual,
    oldCreatedShortlyBeforeLog: shortBefore(gap), timeGapSeconds: gap.value === null ? gap : numeric(gap.value), timeBucket: gap.value === null ? absent<string>(gap.reason!) : present(timeBucket(gap.value)),
    oldInNew: numeric(text.oldInNew), newInOld: numeric(text.newInOld), jaccard: numeric(text.jaccard), lengthRatio: numeric(text.lengthRatio),
    oldSource: present(text.oldSource), newSource: present(text.newSource), oldList: present(text.oldList), newList: present(text.newList), blockRelation: present(text.relation),
    storedCosine: db.storedCosine, sameProject: db.sameProject, appliedOutcome: db.appliedOutcome, wouldOutcome: db.wouldOutcome, wouldBand: db.wouldBand };
}
const SIGNAL_NAMES = ["sameSession", "capturedAtEqual", "oldCreatedShortlyBeforeLog", "timeGapSeconds", "timeBucket", "oldInNew", "newInOld", "jaccard", "lengthRatio", "oldSource", "newSource", "oldList", "newList", "blockRelation", "storedCosine", "snapshotRole", "appliedOutcome", "wouldOutcome", "wouldBand", "sameProject"] as const;
const NUMERIC = new Set<string>(["timeGapSeconds", "oldInNew", "newInOld", "jaccard", "lengthRatio", "storedCosine"]);
const DESCRIPTIVE = new Set<string>(["snapshotRole", "appliedOutcome", "wouldOutcome", "wouldBand"]);
const LEVELS: Record<string, readonly string[]> = { timeBucket: ["<2m", "<1h", "<1d", "<7d", ">=7d"], blockRelation: ["none", "identical", "different", "one_sided"], snapshotRole: ["matched_candidate", "blocked_nomination"], appliedOutcome: ["create", "supersede", "skip", "merge", "merge-update", "none"], wouldOutcome: ["create", "supersede", "skip", "merge", "merge-update", "judge_pending", "none"], wouldBand: ["exact-dup", "correction-supersede", "recent-near-dup-skip", "store-near-dup-skip", "merge-band", "none"] };
const GROUPS = ["harmful", "baseline", "wrong_retirement", "wrong_skip", "duplicate", "supersede"] as const;
function inGroup(row: SignalRow, group: typeof GROUPS[number]): boolean { return group === "duplicate" || group === "supersede" ? row.gold === group : group === "wrong_retirement" || group === "wrong_skip" ? row.outcome === group : row.group === group; }
function valueOf(row: SignalRow, name: typeof SIGNAL_NAMES[number]): string | number | boolean | null {
  if (name === "snapshotRole") return row.snapshotRole;
  const signal = row[name] as Signal<string | number | boolean>;
  return signal.value;
}
function nullReason(row: SignalRow, name: typeof SIGNAL_NAMES[number]): string | null { return name === "snapshotRole" ? null : (row[name] as Signal<unknown>).reason; }
function summarize(rows: readonly SignalRow[], name: typeof SIGNAL_NAMES[number], group: typeof GROUPS[number]): string {
  const selected = rows.filter((r) => inGroup(r, group));
  const valid = selected.map((r) => valueOf(r, name)).filter((x): x is string | number | boolean => x !== null);
  const nulls = new Map<string, number>();
  for (const row of selected) { const reason = nullReason(row, name); if (reason) nulls.set(reason, (nulls.get(reason) ?? 0) + 1); }
  const missing = [...nulls].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
  if (NUMERIC.has(name)) { const numbers = valid as number[]; return `n=${selected.length}; valid=${numbers.length}; null=${selected.length - numbers.length} (${missing}); median=${fmt(quantile(numbers, .5))}; Q1=${fmt(quantile(numbers, .25))}; Q3=${fmt(quantile(numbers, .75))}`; }
  const counts = new Map<string, number>();
  for (const v of valid) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  return `n=${selected.length}; valid=${valid.length}; null=${selected.length - valid.length} (${missing}); ${[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}:${n}/${valid.length} (${fmt(valid.length ? n / valid.length : null)})`).join(", ") || "no values"}`;
}
function comparison(rows: readonly SignalRow[], name: typeof SIGNAL_NAMES[number], level = contrastLevel(name, NUMERIC)): { metric: string; point: number | null; interval: [number, number] | null; nullCount: number; separates: boolean; noVariance: boolean } {
  const comparable = rows.filter((r) => !r.indistinguishable && (r.group === "harmful" || r.group === "baseline"));
  const observed = comparable.map((r) => valueOf(r, name)).filter((x) => x !== null);
  const noVariance = !NUMERIC.has(name) && new Set(observed).size <= 1;
  const statistic = (sample: readonly SignalRow[]): number | null => {
    const harmful = sample.filter((r) => r.group === "harmful").map((r) => valueOf(r, name)).filter((x) => x !== null);
    const baseline = sample.filter((r) => r.group === "baseline").map((r) => valueOf(r, name)).filter((x) => x !== null);
    if (!harmful.length || !baseline.length) return null;
    if (NUMERIC.has(name)) return auc(harmful as number[], baseline as number[]);
    return categoryDifference(harmful, baseline, level);
  };
  const point = statistic(comparable), bootstrap = noVariance ? { interval: null, nullCount: 0 } : clusterBootstrap(comparable, statistic);
  const { interval, nullCount } = bootstrap;
  const threshold = NUMERIC.has(name) ? .5 : 0;
  return { metric: NUMERIC.has(name) ? "AUC" : `difference in ${String(level)} proportion`, point, interval, nullCount, noVariance, separates: interval !== null && (interval[0] > threshold || interval[1] < threshold) };
}
function renderReport(rows: readonly SignalRow[], snapshot: Snapshot, snapshotHash: string): string {
  const lines = ["# Step 2 failure signals", "", `DB fetch: ${snapshot.fetchedAt}; db-snapshot.json SHA-256: ${snapshotHash}.`, `Population: ${rows.length} shadow pairs with a candidate snapshot and resolvable text; these results do not cover all captures.`, "Current provenance, session, and project fields can be overwritten after creation. Session and capture-batch proxies are WEAK current-state signals; OLD created_at is the primary time anchor.", `S1 namespace check: ${snapshot.namespaceVerified ? "passed" : "unverified"}; overlap count ${snapshot.namespaceOverlapCount}.`, "", "## Population", ""];
  for (const group of GROUPS) { const subset = rows.filter((r) => inGroup(r, group)); lines.push(`- ${group}: ${subset.length}; OLD clusters: ${new Set(subset.map((r) => r.cluster)).size}`); }
  lines.push(`- duplicate_as_retire: ${rows.filter((r) => r.outcome === "duplicate_as_retire").length}`, `- deterministic indistinguishable keeps: ${rows.filter((r) => r.indistinguishable).length}; excluded from model-behaviour comparisons.`, "", "## Signal distributions", "", "Each line gives counts/rates or quartiles; null counts include reasons. Intervals are 95% cluster bootstrap (OLD record ID, fixed seed, 2000 resamples); null resamples are counted beside each interval. Numeric AUC treats HARMFUL as positive. Categorical contrasts use fixed levels.", "");
  const separated: string[] = [], inconclusive: string[] = [];
  for (const name of SIGNAL_NAMES) {
    const c = comparison(rows, name);
    lines.push(`### ${name}${["sameSession", "capturedAtEqual", "oldCreatedShortlyBeforeLog", "sameProject"].includes(name) ? " (WEAK)" : ""}${["snapshotRole", "appliedOutcome", "wouldOutcome", "wouldBand"].includes(name) ? " (DESCRIPTIVE ONLY)" : ""}`, "");
    for (const group of GROUPS) lines.push(`- ${group}: ${summarize(rows, name, group)}`);
    const intervalText = (result: typeof c) => result.noVariance ? "no variance" : result.interval ? `[${fmt(result.interval[0])}, ${fmt(result.interval[1])}]` : "n/a";
    if (!DESCRIPTIVE.has(name)) lines.push(`- model comparison: ${c.metric} ${fmt(c.point)}; interval ${intervalText(c)}; null bootstrap resamples ${c.nullCount}.`);
    lines.push(`- snapshot role matched_candidate: harmful ${summarize(rows.filter((r) => r.snapshotRole === "matched_candidate"), name, "harmful")}; baseline ${summarize(rows.filter((r) => r.snapshotRole === "matched_candidate"), name, "baseline")}`, `- snapshot role blocked_nomination: harmful ${summarize(rows.filter((r) => r.snapshotRole === "blocked_nomination"), name, "harmful")}; baseline ${summarize(rows.filter((r) => r.snapshotRole === "blocked_nomination"), name, "baseline")}`);
    if (LEVELS[name]) {
      lines.push("- Per-level differences (HARMFUL minus BASELINE):");
      for (const level of LEVELS[name]) { const item = comparison(rows, name, level); lines.push(`  - ${level}: ${fmt(item.point)}; interval ${intervalText(item)}; null bootstrap resamples ${item.nullCount}.`); }
    }
    lines.push("");
    if (!DESCRIPTIVE.has(name)) {
      const entry = `${name}${NUMERIC.has(name) ? " (AUC)" : ` = ${String(contrastLevel(name, NUMERIC))}`}: ${intervalText(c)}`;
      (c.separates ? separated : inconclusive).push(entry);
    }
  }
  lines.push("## Interval criterion", "", "Signals meeting the criterion:", ...(separated.length ? separated.map((s) => `- ${s}`) : ["- None."]), "", "Inconclusive signals:", ...inconclusive.map((s) => `- ${s}`), "", "This is descriptive evidence about capture input and judge behaviour, not a causal attribution. Labels came from dual-model plus orchestrator review rather than humans, and the v2.1 labeling protocol ignored provenance blocks. Historical applied/would outcomes ran under earlier conditions and post-judge guards; they do not explain v3 replay errors. Same capture batch does not establish a shared turn, and unequal capture times do not establish different turns.", "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const rawRows = readFileSync(join(ROOT, "runs", `${DATASET}-judge-v3-heldout.jsonl`), "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x) as JudgeBenchmarkRow);
  const labels = parseLabelsJson(readFileSync(labelsPathFor(DATASET), "utf8"));
  const loaded = loadDataset(labels, readFileSync(textsPathFor(DATASET), "utf8"));
  const pairs = new Map(loaded.map((x) => [x.pair.pairId, x]));
  const mining = JSON.parse(readFileSync(join(ROOT, "mining", `${DATASET}.pairs.json`), "utf8")) as { pairs: Array<{ pairId: string; snapshotRole: string; oldRef: { id: string; memoryId: string | null } }> };
  const mined = new Map(mining.pairs.map((x) => [x.pairId, x]));
  const pairIds = rawRows.map((row) => { const p = mined.get(row.pairId); const match = SHADOW_IDS.exec(p?.oldRef.id ?? ""); if (!match) throw new Error("unjoinable shadow pair"); const oldId = id(p?.oldRef.memoryId); if (oldId && !UUID.test(oldId)) throw new Error("invalid OLD record id"); if (p?.snapshotRole !== "matched_candidate" && p?.snapshotRole !== "blocked_nomination") throw new Error("invalid snapshot role"); return { pairId: row.pairId, shadowId: match[1]!, oldId, snapshotRole: p.snapshotRole }; });
  if (new Set(pairIds.map((x) => x.pairId)).size !== 510) throw new Error("unexpected population");
  if (process.argv.includes("--refresh-snapshot") || !existsSync(SNAPSHOT)) { const fetched = await fetchSnapshot(pairIds); validatePrivateArtifact(fetched, "snapshot"); writeFileSync(SNAPSHOT, JSON.stringify(fetched, null, 2) + "\n"); }
  const snapshotText = readFileSync(SNAPSHOT, "utf8"), snapshot = JSON.parse(snapshotText) as Snapshot;
  validatePrivateArtifact(snapshot, "snapshot");
  const db = new Map(snapshot.rows.map((x) => [x.pairId, x]));
  const signals = rawRows.map((row) => { const pair = pairs.get(row.pairId), minedPair = mined.get(row.pairId), dbRow = db.get(row.pairId); if (!pair || !minedPair || !dbRow || pair.oldText === null || pair.newText === null || !["matched_candidate", "blocked_nomination"].includes(minedPair.snapshotRole)) throw new Error("incomplete pair join"); return makeSignalRow(row, pair.oldText, pair.newText, dbRow, minedPair.snapshotRole); }).sort((a, b) => a.pairId.localeCompare(b.pairId));
  for (const row of signals) validatePrivateArtifact(row, "signal");
  const signalText = signals.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(SIGNALS, signalText);
  writeFileSync(REPORT, renderReport(signals, snapshot, hash(snapshotText)));
  console.log(JSON.stringify({ rows: signals.length, harmful: signals.filter((x) => x.group === "harmful").length, baseline: signals.filter((x) => x.group === "baseline").length, indistinguishable: signals.filter((x) => x.indistinguishable).length, namespaceVerified: snapshot.namespaceVerified }));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "failure signal run failed"); process.exitCode = 1; });
