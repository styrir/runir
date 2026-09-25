#!/usr/bin/env npx tsx
/** W1: SELECT-only point-in-time replay. Never log text-bearing inputs or DB errors. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countBy, replayLiveRow, type LiveFlags, type ReplayInput, type ReplayRow } from "../../src/testing/judge-benchmark/live-replay.js";

const ROOT = ".styrir/analysis/judge-benchmark";
const OUT = join(ROOT, "failure-groups", "live-replay");
const overrides = new Set(process.argv.slice(2));
const allowedOverrides = new Set(["--f2-require-value-change", "--merge-keep-both-on-fusion"]);
if ([...overrides].some((arg) => !allowedOverrides.has(arg))) throw new Error("invalid_flag_override");
type Signal = { pairId: string; snapshotRole: string; gold: "independent" | "duplicate" | "supersede"; appliedOutcome: { value: string | null } };
type Pair = { pairId: string; cosine: number | null; oldRef: { id: string; memoryId: string | null }; newRef: { id: string } };
type Shadow = { id: string; live_flags?: string; would_cosine?: number; incoming_tags_json?: string; candidate_snapshot_json?: string; applied_outcome?: string; baseline_matched_id?: string; session_id?: string; occurred_at?: string };
type Old = { id: string; session_id?: string; created_at?: string };
const jsonl = <T>(path: string): T[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
const safeId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error("invalid_id");
  return id;
};
const tags = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const validFlags = (v: unknown): v is LiveFlags => v !== null && typeof v === "object" &&
  ["cueGate", "temporalGuard", "keepBothGuard", "addSkipGuard", "judgeGate", "f2JudgeConfirm", "atomicIdentityProof"]
    .every((key) => typeof (v as Record<string, unknown>)[key] === "boolean");
const parseJson = (v: unknown): unknown => typeof v === "string" ? JSON.parse(v) as unknown : v;

async function select(sql: string): Promise<unknown[]> {
  const auth = Buffer.from("root:root").toString("base64");
  const response = await fetch("http://127.0.0.1:8000/sql", {
    method: "POST", headers: { Accept: "application/json", Authorization: `Basic ${auth}`, "surreal-ns": "main", "surreal-db": "main" },
    body: sql, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error("db_http_error");
  const body = await response.json() as Array<{ status?: string; result?: unknown }>;
  if (body.length !== 1 || body[0]?.status !== "OK" || !Array.isArray(body[0].result)) throw new Error("db_select_error");
  return body[0].result;
}

function render(rows: readonly ReplayRow[]): string {
  const lines = ["# W1 live-path replay", "", "Matched candidate snapshot only; one candidate, decision-time cosine, default arbitration config, recorded live flags.",
    "Old-row timing uses created_at compared with shadow occurred_at; it is an earlier-write proxy, not a capture watermark.", "",
    `Rows: ${rows.length}; reproduced: ${rows.filter((r) => r.reproduced && !r.unreplayable).length}; unreplayable: ${rows.filter((r) => r.unreplayable).length}; mismatched: ${rows.filter((r) => !r.reproduced && !r.unreplayable).length}.`,
    "", "## Reproduction by applied outcome", "", "| Applied | Total | Reproduced | Unreplayable | Mismatch |", "|---|---:|---:|---:|---:|"];
  for (const outcome of Object.keys(countBy(rows, "appliedOutcome"))) {
    const s = rows.filter((r) => r.appliedOutcome === outcome);
    lines.push(`| ${outcome} | ${s.length} | ${s.filter((r) => r.reproduced && !r.unreplayable).length} | ${s.filter((r) => r.unreplayable).length} | ${s.filter((r) => !r.reproduced && !r.unreplayable).length} |`);
  }
  lines.push("", "Unreplayable reasons: " + JSON.stringify(countBy(rows.filter((r) => r.unreplayable), "unreplayable")), "", "## Attribution (reproduced only)", "", "| Gold | Applied | n | F1 | F2 | Other | Proven referent | No proven referent | Bands |", "|---|---|---:|---:|---:|---:|---:|---:|---|");
  for (const gold of ["independent", "duplicate", "supersede"] as const) for (const outcome of ["supersede", "merge-update"] as const) {
    const s = rows.filter((r) => r.gold === gold && r.appliedOutcome === outcome && r.reproduced && !r.unreplayable);
    lines.push(`| ${gold} | ${outcome} | ${s.length} | ${s.filter((r) => r.signal === "F1").length} | ${s.filter((r) => r.signal === "F2").length} | ${s.filter((r) => r.signal === "other").length} | ${s.filter((r) => r.referent === "proven").length} | ${s.filter((r) => r.referent !== "proven").length} | ${JSON.stringify(countBy(s, "band"))} |`);
  }
  lines.push("", "## Merge descriptive counts (recorded applied outcome; not replay-attributed)", "", "| Gold | Total | Snapshot matches applied target | Containment replacement | Sentence union | >1,200 longer text | Same session | Old row before decision | Both |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const gold of ["independent", "duplicate", "supersede"] as const) {
    const all = rows.filter((r) => r.gold === gold && r.appliedOutcome === "merge-update");
    const matched = all.filter((r) => r.targetMatches === true);
    lines.push(`| ${gold} | ${all.length} | ${matched.length} | ${matched.filter((r) => r.mergeKind === "containment_replacement").length} | ${matched.filter((r) => r.mergeKind === "sentence_union").length} | ${matched.filter((r) => r.mergeKind === "longer_text_1200").length} | ${all.filter((r) => r.sameSession === true).length} | ${matched.filter((r) => r.oldBeforeDecision === true).length} | ${matched.filter((r) => r.sameSession === true && r.oldBeforeDecision === true).length} |`);
  }
  lines.push("One independent merge has a different applied target, so its merge text and old-row timing cannot be classified from this snapshot.");
  lines.push("", "## W2/W3 flag overrides", "", `Overrides: ${[...overrides].join(", ") || "none"}.`,
    "| Gold | Reproduced supersedes | Before supersede | After create | After supersede | Other after |",
    "|---|---:|---:|---:|---:|---:|");
  for (const gold of ["independent", "duplicate", "supersede"] as const) {
    const s = rows.filter((r) => r.gold === gold && r.appliedOutcome === "supersede" && r.reproduced && !r.unreplayable);
    lines.push(`| ${gold} | ${s.length} | ${s.length} | ${s.filter((r) => r.afterOutcome === "create").length} | ${s.filter((r) => r.afterOutcome === "supersede").length} | ${s.filter((r) => r.afterOutcome !== "create" && r.afterOutcome !== "supersede").length} |`);
  }
  const merges = rows.filter((r) => r.gold === "independent" && r.appliedOutcome === "merge-update" && r.targetMatches === true);
  lines.push("", `W3 descriptive matched-target independent merges: ${merges.length}; before merge-update: ${merges.length}; neither side contains the other: ${merges.filter((r) => r.neitherContainsOther === true).length}; after create with W3: ${merges.filter((r) => r.neitherContainsOther === true).length}; after merge-update with W3: ${merges.filter((r) => r.neitherContainsOther === false).length}.`,
    "These merge outcomes cannot be replayed through arbitration without decision-time cosine.");
  lines.push("", "Signal details: " + JSON.stringify(countBy(rows.filter((r) => r.reproduced && !r.unreplayable && r.gold === "independent" && r.appliedOutcome === "supersede"), "signalDetail")), "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const signals = jsonl<Signal>(join(ROOT, "failure-groups", "signals.jsonl")).filter((x) => x.snapshotRole === "matched_candidate");
  if (signals.length !== 185) throw new Error("population_mismatch");
  const pairs = new Map((JSON.parse(readFileSync(join(ROOT, "mining", "supersession-shadow-v1.pairs.json"), "utf8")) as { pairs: Pair[] }).pairs.map((x) => [x.pairId, x]));
  const texts = new Map(jsonl<{ id: string; text: string }>(join(ROOT, "texts", "supersession-shadow-v1.jsonl")).map((x) => [x.id, x.text]));
  const shadowIds = signals.map((x) => safeId(pairs.get(x.pairId)?.oldRef.id.split(":")[1] ?? ""));
  const shadows = new Map((await select(`SELECT meta::id(id) AS id, live_flags, would_cosine, incoming_tags_json, candidate_snapshot_json, applied_outcome, baseline_matched_id, session_id, occurred_at FROM supersede_shadow WHERE meta::id(id) IN ${JSON.stringify(shadowIds)};`) as Shadow[]).map((x) => [String(x.id), x]));
  const oldIds = [...new Set(signals.map((x) => pairs.get(x.pairId)?.oldRef.memoryId).filter((x): x is string => typeof x === "string" && /^[a-zA-Z0-9_-]+$/u.test(x)))];
  const olds = new Map((await select(`SELECT meta::id(id) AS id, session_id, created_at FROM semiote WHERE meta::id(id) IN ${JSON.stringify(oldIds)};`) as Old[]).map((x) => [String(x.id), x]));
  const rows = signals.map((signal): ReplayRow => {
    const pair = pairs.get(signal.pairId);
    if (!pair) throw new Error("missing_pair");
    const shadow = shadows.get(pair.oldRef.id.split(":")[1] ?? "");
    const old = pair.oldRef.memoryId ? olds.get(pair.oldRef.memoryId) : undefined;
    const snapshot = shadow?.candidate_snapshot_json ? parseJson(shadow.candidate_snapshot_json) as Record<string, unknown> : null;
    let flags: unknown, incomingTags: unknown;
    try { flags = parseJson(shadow?.live_flags); incomingTags = parseJson(shadow?.incoming_tags_json); }
    catch { flags = null; incomingTags = null; }
    const reason = !shadow ? "missing_shadow" : !snapshot ? "missing_snapshot" : !validFlags(flags) ? "missing_live_flags" : !Array.isArray(incomingTags) ? "missing_incoming_tags" : !old ? "missing_old_row" : null;
    if (reason) return { pairId: signal.pairId, gold: signal.gold, appliedOutcome: signal.appliedOutcome.value ?? "none", replayOutcome: null, reproduced: false, unreplayable: reason, signal: null, signalDetail: null, band: null, referent: null, mergeKind: null, sameSession: null, oldBeforeDecision: null, targetMatches: null, neitherContainsOther: null };
    const input: ReplayInput = {
      pairId: signal.pairId, gold: signal.gold, appliedOutcome: String(shadow!.applied_outcome ?? "none"),
      oldText: String(snapshot!.l2 ?? ""), incomingText: texts.get(pair.newRef.id) ?? "",
      oldId: String(snapshot!.id ?? pair.oldRef.memoryId), oldCreatedAt: String(old!.created_at ?? ""), occurredAt: String(shadow!.occurred_at ?? ""),
      cosine: typeof shadow!.would_cosine === "number" ? shadow!.would_cosine : Number.NaN, oldTags: tags(snapshot!.tags), incomingTags: tags(incomingTags),
      factKey: typeof snapshot!.factKey === "string" ? snapshot!.factKey : undefined,
      atomicFact: snapshot!.atomicFact && typeof snapshot!.atomicFact === "object" ? snapshot!.atomicFact as ReplayInput["atomicFact"] : undefined,
      flags: flags as LiveFlags, sameSession: typeof shadow!.session_id === "string" && typeof old!.session_id === "string" ? shadow!.session_id === old!.session_id : null,
    };
    const replay = replayLiveRow(input);
    const afterOutcome = replayLiveRow({ ...input, flags: {
      ...input.flags,
      f2RequireValueChange: overrides.has("--f2-require-value-change"),
      mergeKeepBothOnFusion: overrides.has("--merge-keep-both-on-fusion"),
    } }).replayOutcome;
    const appliedTarget = typeof shadow!.baseline_matched_id === "string" ? shadow!.baseline_matched_id.split(":").at(-1) : null;
    const targetMatches = appliedTarget === input.oldId;
    if ((input.appliedOutcome === "merge-update" || input.appliedOutcome === "skip") && !targetMatches) {
      return { ...replay, afterOutcome, targetMatches: false, reproduced: false, unreplayable: "applied_target_differs_from_snapshot", signal: null, signalDetail: null, band: null, referent: null };
    }
    return { ...replay, afterOutcome, targetMatches };
  }).sort((a, b) => a.pairId.localeCompare(b.pairId));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "rows.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(OUT, "report.md"), render(rows));
  console.log(JSON.stringify({ rows: rows.length, reproduced: rows.filter((r) => r.reproduced && !r.unreplayable).length, unreplayable: countBy(rows.filter((r) => r.unreplayable), "unreplayable") }));
}

void main().catch(() => { console.error("live_replay_failed"); process.exitCode = 1; });
