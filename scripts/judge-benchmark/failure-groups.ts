#!/usr/bin/env npx tsx
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadDataset, parseLabelsJson } from "../../src/testing/judge-benchmark/dataset.js";
import { labelsPathFor, textsPathFor } from "../../src/testing/judge-benchmark/paths.js";
import { BINS, BOOTSTRAP_SEED, cellKey, claudeProxyCompletion, failureRecord, jointBootstrap, kappa, LABELS, majority, pairPayload, parseResponses, promptFor, quotas, requestCap, roleOnlyControls, runWithinRequestCap, sampleControls, SEED, shares, validateReportData, type Control, type FinalRow, type Labeler, type LabelResponse, type Mistake, type Payload, type SignalRow } from "../../src/testing/judge-benchmark/failure-groups.js";
import { rng, shuffle } from "./shared.js";
import { quantile } from "../../src/testing/judge-benchmark/failure-signals.js";

const ROOT = ".styrir/analysis/judge-benchmark";
const DIR = join(ROOT, "failure-groups", "step3");
const DATASET = "supersession-shadow-v1";
const RUN = join(ROOT, "runs", `${DATASET}-judge-v3-heldout.jsonl`);
const SIGNALS = join(ROOT, "failure-groups", "signals.jsonl");
const readJsonl = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
const writeJsonl = (path: string, rows: readonly unknown[]) => writeFileSync(path, rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : ""));
const option = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1]; };
type RunRow = { pairId: string; outcome: string };
type LabelRecord = LabelResponse & { labeler: "gpt" | "grok" | "claude" };
type Failure = { pairId: string; code: string };
type Runner = (labeler: Labeler, prompt: string, outDir: string) => string | Promise<string>;
type RequestUsage = { requests: number; promptCharacters: number };
const BATCH_SIZE = 12;

function population(): { signals: SignalRow[]; mistakes: SignalRow[] } {
  const signals = readJsonl<SignalRow>(SIGNALS);
  const outcome = new Map(readJsonl<RunRow>(RUN).map((x) => [x.pairId, x.outcome]));
  const mistakes = signals.filter((x) => outcome.get(x.pairId) === "wrong_retirement" || outcome.get(x.pairId) === "wrong_skip");
  if (signals.length !== 510 || mistakes.length !== 90 || mistakes.filter((x) => x.outcome === "wrong_retirement").length !== 47 || mistakes.filter((x) => x.outcome === "wrong_skip").length !== 43) throw new Error("population_mismatch");
  return { signals, mistakes };
}
function controlFile(outDir: string): { seed: number; controls: Control[] } {
  return JSON.parse(readFileSync(join(outDir, "controls.json"), "utf8")) as { seed: number; controls: Control[] };
}
function sample(outDir: string): void {
  const { signals } = population();
  const controls = sampleControls(signals, rng(SEED));
  if (controls.length !== 89) throw new Error("control_count_mismatch");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "controls.json"), JSON.stringify({ seed: SEED, controls }, null, 2) + "\n");
  const counts = Object.fromEntries((["wrong_retirement", "wrong_skip"] as const).map((type) => [type, { quota: Object.fromEntries(quotas(signals, type)), drawn: Object.fromEntries([...new Set(controls.filter((x) => x.forType === type).map((x) => cellKey(x.cell)))].map((key) => [key, controls.filter((x) => x.forType === type && cellKey(x.cell) === key).length])) }]));
  console.log(JSON.stringify({ controls: controls.length, cells: counts }));
}
function items(outDir: string) {
  const { signals, mistakes } = population();
  const controls = controlFile(outDir).controls;
  const byId = new Map(signals.map((x) => [x.pairId, x]));
  const list = [...mistakes.map((x) => ({ signal: x, forType: x.outcome as Mistake })), ...controls.map((x) => ({ signal: byId.get(x.pairId)!, forType: x.forType }))];
  if (list.some((x) => !x.signal) || new Set(list.map((x) => x.signal.pairId)).size !== 179) throw new Error("control_join_error");
  return list;
}
function payloads(ids: readonly string[], dry: boolean): Map<string, Payload> {
  if (dry) return new Map(ids.map((id) => [id, { pairId: id, oldText: "Synthetic old claim.", newText: "Synthetic new claim." }]));
  const loaded = loadDataset(parseLabelsJson(readFileSync(labelsPathFor(DATASET), "utf8")), readFileSync(textsPathFor(DATASET), "utf8"));
  const wanted = new Set(ids), out = new Map<string, Payload>();
  for (const x of loaded) if (wanted.has(x.pair.pairId)) {
    if (x.oldText === null || x.newText === null) throw new Error("missing_text");
    out.set(x.pair.pairId, pairPayload(x.pair.pairId, x.oldText, x.newText));
  }
  if (out.size !== wanted.size) throw new Error("missing_pair");
  return out;
}
function command(labeler: "gpt" | "grok", dir: string, promptPath: string, outPath: string, outDir: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (labeler === "gpt") return { file: "codex", args: ["exec", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=\"medium\"", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--ephemeral", "-C", dir, "--output-last-message", outPath, "-"], env: process.env };
  return { file: "grok", args: ["-m", "grok-4.7", "--reasoning-effort", "high", "--prompt-file", promptPath, "--cwd", dir, "--tools", "", "--disallowed-tools", "run_terminal_cmd,read_file,grep,list_dir,search_replace,memory_search,web_search,web_fetch,Agent,spawn_subagent,get_command_or_subagent_output,kill_command_or_subagent,search_tool,use_tool", "--disable-web-search", "--no-subagents", "--verbatim", "--output-format", "plain"], env: { ...process.env, GROK_HOME: join(outDir, "grok-home"), GROK_MEMORY: "0" } };
}
export function realRunner(labeler: Labeler, prompt: string, outDir: string, exec: typeof execFileSync = execFileSync): string | Promise<string> {
  if (labeler === "claude") return claudeProxyCompletion(prompt);
  const step3Dir = resolve(outDir);
  const dir = mkdtempSync(join(tmpdir(), `runir-${labeler}-cwd-`));
  for (let parent = dir; parent !== dirname(parent); parent = dirname(parent)) if (existsSync(join(parent, ".git"))) { rmSync(dir, { recursive: true, force: true }); throw new Error("unsafe_labeler_cwd"); }
  const suffix = dir.slice(dir.lastIndexOf("/") + 1);
  const promptPath = join(step3Dir, `${suffix}.prompt.md`), outPath = join(step3Dir, `${suffix}.last.txt`);
  const authPath = join(step3Dir, "grok-home", "auth.json");
  try {
    writeFileSync(promptPath, prompt, { mode: 0o600 });
    if (labeler === "grok") {
      mkdirSync(dirname(authPath), { recursive: true });
      copyFileSync(join(process.env.HOME ?? "", ".grok", "auth.json"), authPath);
      chmodSync(authPath, 0o600);
    }
    const spec = command(labeler, dir, promptPath, outPath, step3Dir);
    const stdout = exec(spec.file, spec.args, { cwd: dir, env: spec.env, input: labeler === "grok" ? undefined : prompt, stdio: [labeler === "grok" ? "ignore" : "pipe", "pipe", "pipe"], timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }).toString("utf8");
    return labeler === "gpt" ? readFileSync(outPath, "utf8") : stdout;
  } finally {
    if (labeler === "grok") rmSync(authPath, { force: true });
    rmSync(promptPath, { force: true });
    rmSync(outPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
const fakeRunner: Runner = (labeler, prompt) => {
  const ids = [...prompt.matchAll(/"pairId":"(ss-[a-f0-9]{12})"/gu)].map((m) => m[1]!);
  return ids.map((pairId) => JSON.stringify({ pairId, label: labeler === "grok" && Number.parseInt(pairId.slice(-2), 16) % 3 === 0 ? "true_update" : "continuation", confidence: "medium", note: "same work later step" })).join("\n");
};
function existing(path: string): Map<string, LabelRecord> { return new Map((existsSync(path) ? readJsonl<LabelRecord>(path) : []).map((x) => [x.pairId, x])); }
function usage(outDir: string, labeler: Labeler): RequestUsage {
  const path = join(outDir, `requests.${labeler}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as RequestUsage : { requests: 0, promptCharacters: 0 };
}
function cappedRun(outDir: string, labeler: Labeler, prompt: string, cap: number, runner: Runner): string | Promise<string> {
  const current = usage(outDir, labeler);
  return runWithinRequestCap(current.requests, cap, (next) => {
    writeFileSync(join(outDir, `requests.${labeler}.json`), JSON.stringify({ requests: next, promptCharacters: current.promptCharacters + prompt.length }) + "\n");
    return runner(labeler, prompt, outDir);
  });
}
export async function labelBatch(ids: ReadonlySet<string>, texts: ReadonlyMap<string, Payload>, run: (prompt: string) => string | Promise<string>, save: (row: LabelResponse) => void, fail: (id: string, code: string) => void): Promise<void> {
  let parsed: LabelResponse[] = [];
  try {
    parsed = parseResponses(await run(promptFor([...ids].map((id) => texts.get(id)!))), ids);
  } catch (error) {
    const code = failureRecord([...ids][0]!, error).code;
    if (code === "request_cap") {
      for (const id of ids) fail(id, code);
      throw new Error("request_cap");
    }
  }
  for (const row of parsed) save(row);
  const valid = new Set(parsed.map((row) => row.pairId));
  for (const id of ids) if (!valid.has(id)) {
    try {
      const answer = parseResponses(await run(promptFor([texts.get(id)!])), new Set([id]))[0];
      if (answer) save(answer);
      else fail(id, "missing_response");
    } catch (error) {
      const code = failureRecord(id, error).code;
      fail(id, code);
      if (code === "request_cap") throw new Error("request_cap");
    }
  }
}
async function label(outDir: string, labeler: Labeler, limit: number, dry: boolean, runner: Runner): Promise<void> {
  const list = items(outDir), path = join(outDir, `labels.${labeler}.jsonl`), done = existing(path);
  const first = labeler === "claude" ? list.filter((x) => { const a = existing(join(outDir, "labels.gpt.jsonl")).get(x.signal.pairId), b = existing(join(outDir, "labels.grok.jsonl")).get(x.signal.pairId); return a && b && a.label !== b.label; }) : list;
  const order = shuffle(first.sort((a, b) => a.signal.pairId.localeCompare(b.signal.pairId)), rng(SEED + (labeler === "gpt" ? 1 : labeler === "grok" ? 2 : 3))).filter((x) => !done.has(x.signal.pairId)).slice(0, limit);
  const cap = requestCap(first.length, BATCH_SIZE);
  const texts = payloads(order.map((x) => x.signal.pairId), dry);
  let written = 0, failed = 0;
  const failurePath = join(outDir, `failures.${labeler}.jsonl`);
  const save = (row: LabelResponse) => { appendFileSync(path, JSON.stringify({ ...row, labeler }) + "\n"); written++; };
  const fail = (id: string, code: Failure["code"]) => { appendFileSync(failurePath, JSON.stringify({ pairId: id, code } satisfies Failure) + "\n"); failed++; };
  for (let i = 0; i < order.length; i += BATCH_SIZE) {
    const batch = order.slice(i, i + BATCH_SIZE), ids = new Set(batch.map((x) => x.signal.pairId));
    await labelBatch(ids, texts, (prompt) => cappedRun(outDir, labeler, prompt, cap, runner), save, fail);
  }
  console.log(JSON.stringify({ labeler, written, failed, ...usage(outDir, labeler), requestCap: cap }));
}
function finalRows(outDir: string): FinalRow[] {
  const a = existing(join(outDir, "labels.gpt.jsonl")), b = existing(join(outDir, "labels.grok.jsonl")), c = existing(join(outDir, "labels.claude.jsonl"));
  return items(outDir).map(({ signal, forType }) => {
    const left = a.get(signal.pairId), right = b.get(signal.pairId), third = c.get(signal.pairId);
    const result = left && right ? majority(left.label, right.label, third?.label) : null;
    return { pairId: signal.pairId, population: signal.outcome as FinalRow["population"], mistakeType: signal.outcome === "correct_keep" ? null : forType, forType, cluster: signal.cluster, snapshotRole: signal.snapshotRole, sameSession: signal.sameSession.value, label: result?.label ?? null, status: result?.status ?? "failed", confidence: result?.label ? (third?.label === result.label ? third.confidence : left?.label === result.label ? left.confidence : right?.confidence ?? null) : null };
  });
}
function report(outDir: string): void {
  const rows = finalRows(outDir); writeJsonl(join(outDir, "final.jsonl"), rows);
  const a = existing(join(outDir, "labels.gpt.jsonl")), b = existing(join(outDir, "labels.grok.jsonl")), c = existing(join(outDir, "labels.claude.jsonl"));
  const cells = [...new Set(rows.map((x) => `${x.population}:${x.snapshotRole}:${String(x.sameSession)}`))];
  const coverage = Object.fromEntries((["gpt", "grok", "claude"] as const).map((labeler) => {
    const labels = labeler === "gpt" ? a : labeler === "grok" ? b : c;
    const failures = new Set(readJsonl<Failure>(join(outDir, `failures.${labeler}.jsonl`)).map((x) => x.pairId).filter((id) => !labels.has(id)));
    return [labeler, { ...usage(outDir, labeler), cells: cells.map((cell) => { const group = rows.filter((x) => `${x.population}:${x.snapshotRole}:${String(x.sameSession)}` === cell); return { population: group[0]!.population, snapshotRole: group[0]!.snapshotRole, sameSession: group[0]!.sameSession, n: group.length, labeled: group.filter((x) => labels.has(x.pairId)).length, failed: group.filter((x) => failures.has(x.pairId)).length, unresolved: group.filter((x) => x.status === "unresolved").length, unmatched: group.filter((x) => x.sameSession === null).length }; }) }];
  }));
  const complete = rows.every((x) => a.has(x.pairId) && b.has(x.pairId)) && rows.filter((x) => a.get(x.pairId)?.label !== b.get(x.pairId)?.label).every((x) => c.has(x.pairId));
  const agreement = Object.fromEntries((["wrong_retirement", "wrong_skip", "correct_keep"] as const).map((type) => [type, kappa(rows.filter((x) => x.population === type && a.has(x.pairId) && b.has(x.pairId)).map((x) => [a.get(x.pairId)!.label, b.get(x.pairId)!.label]))]));
  const data: Record<string, unknown> = { coverage, agreement, tiebreaks: c.size, complete };
  if (complete) data.pooled = { n: rows.filter((x) => x.population !== "correct_keep").length, shares: shares(rows.filter((x) => x.population !== "correct_keep")) };
  if (complete) for (const type of ["wrong_retirement", "wrong_skip"] as const) {
    const mistakes = rows.filter((x) => x.population === type), matched = mistakes.filter((x) => x.sameSession !== null), controls = rows.filter((x) => x.population === "correct_keep" && x.forType === type);
    const joint = jointBootstrap(mistakes, controls, rng(BOOTSTRAP_SEED));
    const roles = [...new Set(mistakes.map((x) => x.snapshotRole))];
    const roleOnly = Object.fromEntries(roles.map((role) => [role, { mistake: shares(mistakes.filter((x) => x.snapshotRole === role)), control: shares(roleOnlyControls(rows, type, role)) }]));
    const roleOnlyControlShares = Object.fromEntries(BINS.map((bin) => [bin, roles.reduce((sum, role) => sum + mistakes.filter((x) => x.snapshotRole === role).length / mistakes.length * shares(roleOnlyControls(rows, type, role))[bin], 0)]));
    const signalRows = readJsonl<SignalRow>(SIGNALS), signalMap = new Map(signalRows.map((x) => [x.pairId, x]));
    const quartileCuts = Object.fromEntries((["newInOld", "jaccard"] as const).map((metric) => {
      const values = signalRows.map((x) => x[metric].value).filter((x): x is number => x !== null);
      return [metric, [0.25, 0.5, 0.75].map((p) => quantile(values, p)!)];
    })) as Record<"newInOld" | "jaccard", number[]>;
    const max = Math.max(...LABELS.map((label) => shares(mistakes)[label]));
    const top = LABELS.filter((label) => shares(mistakes)[label] === max);
    const cells = [...new Set(matched.map((x) => cellKey({ snapshotRole: x.snapshotRole, sameSession: x.sameSession! })))].map((key) => {
      const mistakeCell = matched.filter((x) => cellKey({ snapshotRole: x.snapshotRole, sameSession: x.sameSession! }) === key);
      const controlCell = controls.filter((x) => cellKey({ snapshotRole: x.snapshotRole, sameSession: x.sameSession! }) === key);
      return { snapshotRole: mistakeCell[0]!.snapshotRole, sameSession: mistakeCell[0]!.sameSession, mistakeN: mistakeCell.length, controlN: controlCell.length, mistakeShares: shares(mistakeCell), controlShares: shares(controlCell) };
    });
    const crossTab = top.map((label) => ({ label, metrics: (["newInOld", "jaccard"] as const).map((metric) => {
      const cut = quartileCuts[metric];
      const counts = [0, 0, 0, 0], nullCount = { n: 0 };
      for (const x of mistakes.filter((r) => r.label === label)) { const v = signalMap.get(x.pairId)?.[metric].value; if (v === null || v === undefined) nullCount.n++; else counts[v <= cut[0]! ? 0 : v <= cut[1]! ? 1 : v <= cut[2]! ? 2 : 3]++; }
      return { metric, cuts: cut, counts, nullCount: nullCount.n };
    }) }));
    const differenceFlags = Object.fromEntries(LABELS.map((label) => { const interval = joint.difference[label].interval; return [label, interval !== null && (interval[0] > 0 || interval[1] < 0)]; }));
    data[type] = { n: mistakes.length, matchedN: matched.length, controlN: controls.length, cells, shares: joint.mistake, controlShares: joint.control, difference: joint.difference, differenceFlags, disagreement: joint.disagreement, mode: joint.mode, roleOnly, roleOnlyControlShares, crossTab };
  }
  validateReportData(data);
  const lines = ["# Step 3 blind grouping", "", `Coverage: ${JSON.stringify(coverage)}. Complete: ${complete}.`, `A/B agreement: ${JSON.stringify(agreement)}. Tiebreaks: ${c.size}.`, ""];
  if (complete) for (const type of ["wrong_retirement", "wrong_skip"] as const) {
    lines.push(`## ${type}`, "", `Numbers: ${JSON.stringify(data[type])}`, "");
  }
  lines.push("The control contrast is conditional on snapshotRole and the WEAK current-state session proxy. Labels are a second model reading of the text the judge saw; they do not establish capture as the cause. Labelers and tiebreaker are models, not humans; gold was also model-made. Intervals and difference flags are unadjusted descriptive results for seven labels across two mistake types. noVariance=true means no variance. The pooled 90 is descriptive only. Grok session state is redirected into the Step 3 directory because its CLI has no no-persistence option.", "");
  writeFileSync(join(outDir, "step3-report.md"), lines.join("\n"));
  console.log(JSON.stringify({ complete, rows: rows.length, tiebreaks: c.size }));
}
async function main(): Promise<void> {
  const commandName = process.argv[2], dry = process.argv.includes("--dry-run"), limit = option("limit") === undefined ? Infinity : Number(option("limit"));
  if (!Number.isInteger(limit) && limit !== Infinity || limit < 0) throw new Error("invalid_limit");
  const outDir = dry ? mkdtempSync(join(tmpdir(), "runir-step3-dry-")) : DIR;
  if (dry) sample(outDir);
  if (commandName === "sample") sample(outDir);
  else if (commandName === "label") { const labeler = option("labeler"); if (labeler !== "gpt" && labeler !== "grok") throw new Error("invalid_labeler"); await label(outDir, labeler, limit, dry, dry ? fakeRunner : realRunner); }
  else if (commandName === "tiebreak") await label(outDir, "claude", limit, dry, dry ? fakeRunner : realRunner);
  else if (commandName === "report") report(outDir);
  else if (commandName === "pipeline" && dry) { await label(outDir, "gpt", limit, true, fakeRunner); await label(outDir, "grok", limit, true, fakeRunner); await label(outDir, "claude", limit, true, fakeRunner); report(outDir); }
  else throw new Error("usage: sample | label --labeler gpt|grok | tiebreak | report | pipeline --dry-run [--limit N]");
}
if (process.argv[1]?.endsWith("scripts/judge-benchmark/failure-groups.ts")) main().catch((error: unknown) => { console.error(error instanceof Error && (error.message.startsWith("control_shortfall:") || error.message === "request_cap") ? error.message : "step3_error"); process.exitCode = 1; });
