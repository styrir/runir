import { judgeInputTexts } from "../../storage/writes/supersession-judge.js";
import { quantile } from "./failure-signals.js";

export const LABELS = ["true_duplicate", "true_update", "summary_detail", "overlap_restatement", "continuation", "surface_lookalike", "other"] as const;
export type GroupLabel = typeof LABELS[number];
export type Mistake = "wrong_retirement" | "wrong_skip";
export type Population = Mistake | "correct_keep";
export type Bin = GroupLabel | "failed" | "unresolved" | "unmatched";
export const BINS = [...LABELS, "failed", "unresolved", "unmatched"] as const;
export const SEED = 0x7a032025;
export const BOOTSTRAP_SEED = 0x51a7e;
export const PROTOCOL = `Apply these ordered rules. The FIRST rule that applies wins.
1. true_duplicate: same claim, same value, no claim added or dropped; a paraphrase counts.
2. true_update: same subject and the same exclusive attribute (one value at a time), and NEW is a different current value. A fix, result, review, status narration, or later step in the same work is continuation unless this exclusive-attribute test is met.
3. summary_detail: every claim in one text is contained in the other, and the longer text has at least one further claim.
4. overlap_restatement: at least one shared claim, and each text has a claim the other lacks.
5. continuation: NEW is a later step in the same work and OLD remains valid history.
6. surface_lookalike: no shared claim; only shared words, a project, a file, or a tool name.
7. other: none of the above (3–8 word note).
Each label carries confidence low/medium/high.
Do not use any tools. Answer only from the supplied pair payloads.
Return one JSON object per pair with exactly {pairId, label, confidence, note}. Note must be at most 12 words. No commentary.`;

export type SignalRow = { pairId: string; cluster: number; outcome: string; snapshotRole: string; sameSession: { value: boolean | null }; newInOld: { value: number | null }; jaccard: { value: number | null } };
export type Cell = { snapshotRole: string; sameSession: boolean };
export type Control = { pairId: string; forType: Mistake; cell: Cell; cluster: number };
export function cellKey(cell: Cell): string { return `${cell.snapshotRole}:${cell.sameSession}`; }
export function quotas(rows: readonly SignalRow[], type: Mistake): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) if (row.outcome === type && row.sameSession.value !== null) {
    const key = cellKey({ snapshotRole: row.snapshotRole, sameSession: row.sameSession.value });
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}
export function sampleControls(rows: readonly SignalRow[], random: () => number): Control[] {
  const controls: Control[] = [], used = new Map<number, number>();
  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [items[i], items[j]] = [items[j]!, items[i]!]; }
    return items;
  };
  for (const type of ["wrong_retirement", "wrong_skip"] as const) {
    for (const [key, needed] of [...quotas(rows, type)].sort(([a], [b]) => a.localeCompare(b))) {
      const candidates = shuffle(rows.filter((r) => r.outcome === "correct_keep" && r.sameSession.value !== null && cellKey({ snapshotRole: r.snapshotRole, sameSession: r.sameSession.value }) === key).sort((a, b) => a.pairId.localeCompare(b.pairId)));
      let taken = 0;
      for (const candidate of candidates) {
        if (taken === needed) break;
        if ((used.get(candidate.cluster) ?? 0) >= 2 || controls.some((x) => x.pairId === candidate.pairId)) continue;
        controls.push({ pairId: candidate.pairId, forType: type, cell: { snapshotRole: candidate.snapshotRole, sameSession: candidate.sameSession.value! }, cluster: candidate.cluster });
        used.set(candidate.cluster, (used.get(candidate.cluster) ?? 0) + 1);
        taken++;
      }
      if (taken !== needed) throw new Error(`control_shortfall:${type}:${key}:${taken}/${needed}`);
    }
  }
  return controls;
}

export type Payload = { pairId: string; oldText: string; newText: string };
export function pairPayload(pairId: string, oldRaw: string, newRaw: string): Payload {
  const { oldText, newText } = judgeInputTexts(oldRaw, newRaw, "strip-provenance");
  return { pairId, oldText, newText };
}
export function promptFor(payloads: readonly Payload[]): string { return `${PROTOCOL}\n${payloads.map((p) => JSON.stringify(p)).join("\n")}`; }
export type LabelResponse = { pairId: string; label: GroupLabel; confidence: "low" | "medium" | "high"; note: string };
const PAIR = /^ss-[a-f0-9]{12}$/u;
export function parseResponses(raw: string, expected: ReadonlySet<string>): LabelResponse[] {
  const found = new Set<string>();
  const valid: LabelResponse[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: unknown;
    try { value = JSON.parse(trimmed) as unknown; } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const x = value as Record<string, unknown>;
    if (Object.keys(x).sort().join() !== "confidence,label,note,pairId" || typeof x.pairId !== "string" || !PAIR.test(x.pairId) || !expected.has(x.pairId) || found.has(x.pairId) || !LABELS.includes(x.label as GroupLabel) || !["low", "medium", "high"].includes(String(x.confidence)) || typeof x.note !== "string" || x.note.trim().split(/\s+/u).length > 12 || x.note.length > 160 || x.label === "other" && (x.note.trim().split(/\s+/u).length < 3 || x.note.trim().split(/\s+/u).length > 8)) continue;
    found.add(x.pairId);
    valid.push(x as LabelResponse);
  }
  return valid;
}

export type Labeler = "gpt" | "grok" | "claude";
// Subscription labelers have no metered spend; allow one request per batch and one individual retry per pair.
export function requestCap(pairs: number, batchSize: number): number { return Math.ceil(pairs / batchSize) + pairs; }
export function runWithinRequestCap<T>(requests: number, cap: number, run: (next: number) => T): T {
  if (requests >= cap) throw new Error("request_cap");
  return run(requests + 1);
}
export async function claudeProxyCompletion(prompt: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl("http://127.0.0.1:8318/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5-1", messages: [{ role: "user", content: prompt }], temperature: 0 }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch { throw new Error("network_error"); }
  if (!response.ok) throw new Error(`http_${response.status}`);
  let value: unknown;
  try { value = await response.json() as unknown; } catch { throw new Error("invalid_response"); }
  const content = (value as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("invalid_response");
  return content;
}
export function failureRecord(pairId: string, error: unknown): { pairId: string; code: string } {
  const message = error instanceof Error ? error.message : "";
  const code = message === "request_cap" || message === "network_error" || message === "invalid_response" || /^http_[1-5][0-9]{2}$/u.test(message) ? message : "runner_error";
  return { pairId, code };
}
export function majority(a: GroupLabel, b: GroupLabel, c?: GroupLabel): { label: GroupLabel | null; status: "agreed" | "tiebroken" | "unresolved" } {
  if (a === b) return { label: a, status: "agreed" };
  if (c === a || c === b) return { label: c, status: "tiebroken" };
  return { label: null, status: "unresolved" };
}
export function kappa(pairs: readonly [GroupLabel, GroupLabel][]): { agreement: number | null; kappa: number | null } {
  if (!pairs.length) return { agreement: null, kappa: null };
  const n = pairs.length, observed = pairs.filter(([a, b]) => a === b).length / n;
  const expected = LABELS.reduce((sum, label) => sum + pairs.filter(([a]) => a === label).length * pairs.filter(([, b]) => b === label).length / (n * n), 0);
  return { agreement: observed, kappa: expected === 1 ? null : (observed - expected) / (1 - expected) };
}
export type FinalRow = { pairId: string; population: Population; mistakeType: Mistake | null; forType: Mistake; cluster: number; snapshotRole: string; sameSession: boolean | null; label: GroupLabel | null; status: "agreed" | "tiebroken" | "unresolved" | "failed"; confidence: "low" | "medium" | "high" | null };
export function binOf(row: FinalRow): Bin { return row.population !== "correct_keep" && row.sameSession === null ? "unmatched" : row.status === "failed" ? "failed" : row.status === "unresolved" || row.label === null ? "unresolved" : row.label; }
export function shares(rows: readonly FinalRow[]): Record<Bin, number> {
  return Object.fromEntries(BINS.map((bin) => [bin, rows.length ? rows.filter((row) => binOf(row) === bin).length / rows.length : 0])) as Record<Bin, number>;
}
export function roleOnlyControls(rows: readonly FinalRow[], type: Mistake, role: string): FinalRow[] {
  return rows.filter((row) => row.population === "correct_keep" && row.forType === type && row.snapshotRole === role);
}
export type Mapping = "judge_disagrees" | "gold_disagrees" | "unmapped";
export function disagreement(type: Mistake, label: GroupLabel | null): Mapping {
  if (label === null || label === "true_duplicate" && type === "wrong_retirement" || label === "true_update" && type === "wrong_skip") return "unmapped";
  if (label === "true_duplicate" || label === "true_update") return "gold_disagrees";
  return "judge_disagrees";
}
export function disagreementShares(rows: readonly FinalRow[]): Record<Mapping, number> {
  const modes: Mapping[] = ["judge_disagrees", "gold_disagrees", "unmapped"];
  return Object.fromEntries(modes.map((mode) => [mode, rows.length ? rows.filter((row) => (row.sameSession === null || row.status === "failed" || row.status === "unresolved" ? "unmapped" : disagreement(row.forType, row.label)) === mode).length / rows.length : 0])) as Record<Mapping, number>;
}
export function uniqueMode(draws: readonly Record<Bin, number>[]): { label: GroupLabel | null; modes: GroupLabel[]; frequency: number } {
  const counts = new Map<GroupLabel, number>();
  for (const draw of draws) {
    const max = Math.max(...LABELS.map((label) => draw[label]));
    const modes = LABELS.filter((label) => draw[label] === max);
    if (max > 0 && modes.length === 1) counts.set(modes[0]!, (counts.get(modes[0]!) ?? 0) + 1);
  }
  const frequency = draws.length ? Math.max(0, ...counts.values()) / draws.length : 0;
  const label = frequency >= 0.95 ? [...counts].find(([, n]) => n / draws.length >= 0.95)?.[0] ?? null : null;
  const point = draws.length ? Object.fromEntries(LABELS.map((x) => [x, draws.reduce((n, row) => n + row[x], 0) / draws.length])) as Record<GroupLabel, number> : null;
  const max = point ? Math.max(...LABELS.map((x) => point[x])) : 0;
  return { label, modes: label ? [label] : point ? LABELS.filter((x) => point[x] === max) : [], frequency };
}
export type Interval = { point: number; interval: [number, number] | null; noVariance: boolean; nullCount: number };
function interval(point: number, values: readonly number[], nullCount = 0): Interval {
  const lo = quantile(values, 0.025), hi = quantile(values, 0.975);
  return { point, interval: lo === null || hi === null ? null : [lo, hi], noVariance: lo !== null && lo === hi, nullCount };
}
export function jointBootstrap(mistakes: readonly FinalRow[], controls: readonly FinalRow[], random: () => number, iterations = 2000) {
  const all = [...mistakes, ...controls], groups = new Map<number, FinalRow[]>();
  for (const row of all) groups.set(row.cluster, [...(groups.get(row.cluster) ?? []), row]);
  const clusters = [...groups.values()];
  const draws: { mistake: Record<Bin, number>; control: Record<Bin, number>; difference: Record<GroupLabel, number> | null; disagreement: Record<Mapping, number> }[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: FinalRow[] = [];
    for (let j = 0; j < clusters.length; j++) sample.push(...clusters[Math.floor(random() * clusters.length)]!);
    const m = sample.filter((x) => x.population !== "correct_keep"), c = sample.filter((x) => x.population === "correct_keep");
    const ms = shares(m), cs = shares(c), matched = m.filter((x) => x.sameSession !== null);
    const matchedShares = shares(matched);
    draws.push({ mistake: ms, control: cs, difference: matched.length && c.length ? Object.fromEntries(LABELS.map((label) => [label, matchedShares[label] - cs[label]])) as Record<GroupLabel, number> : null, disagreement: disagreementShares(m) });
  }
  const m = shares(mistakes), c = shares(controls), matched = shares(mistakes.filter((x) => x.sameSession !== null)), d = disagreementShares(mistakes);
  const series = (point: number, values: (number | null)[]) => interval(point, values.filter((x): x is number => x !== null), values.filter((x) => x === null).length);
  return { mistake: Object.fromEntries(BINS.map((bin) => [bin, series(m[bin], draws.map((x) => x.mistake[bin]))])) as Record<Bin, Interval>, control: Object.fromEntries(BINS.map((bin) => [bin, series(c[bin], draws.map((x) => x.control[bin]))])) as Record<Bin, Interval>, difference: Object.fromEntries(LABELS.map((label) => [label, series(matched[label] - c[label], draws.map((x) => x.difference?.[label] ?? null))])) as Record<GroupLabel, Interval>, disagreement: Object.fromEntries((["judge_disagrees", "gold_disagrees", "unmapped"] as const).map((mode) => [mode, series(d[mode], draws.map((x) => x.disagreement[mode]))])) as Record<Mapping, Interval>, mode: uniqueMode(draws.map((x) => x.mistake)) };
}

const REPORT_ENUMS = new Set<string>([...BINS, "wrong_retirement", "wrong_skip", "correct_keep", "matched_candidate", "blocked_nomination", "true", "false", "gpt", "grok", "claude", "agreed", "tiebroken", "unresolved", "failed", "judge_disagrees", "gold_disagrees", "unmapped", "no_variance", "conditional", "role_only", "newInOld", "jaccard"]);
export function validateReportData(value: unknown): void {
  const walk = (x: unknown, key: string): void => {
    if (x === null || typeof x === "boolean" || typeof x === "number" && Number.isFinite(x)) return;
    if (typeof x === "string") { if (key === "pairId" ? PAIR.test(x) : REPORT_ENUMS.has(x)) return; throw new Error("report_free_text"); }
    if (Array.isArray(x)) { x.forEach((v) => walk(v, key)); return; }
    if (x && typeof x === "object") { Object.entries(x).forEach(([k, v]) => { if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(k) && !REPORT_ENUMS.has(k)) throw new Error("report_key"); walk(v, k); }); return; }
    throw new Error("report_value");
  };
  walk(value, "root");
}
