import { judgeInputTexts } from "../../storage/writes/supersession-judge.js";

export const REASONS = ["missing_record", "missing_value", "invalid_time", "not_applicable", "no_incoming_embedding", "invalid_embedding", "namespace_unverified", "other_candidate"] as const;
export type Reason = typeof REASONS[number];
export type Signal<T> = { value: T; reason: null } | { value: null; reason: Reason };
export const present = <T>(value: T): Signal<T> => ({ value, reason: null });
export const absent = <T>(reason: Reason): Signal<T> => ({ value: null, reason });
export function contextSignal(value: string | null, role: string, allowed: ReadonlySet<string>): Signal<string> {
  return role === "matched_candidate" ? value !== null && allowed.has(value) ? present(value) : absent("missing_value") : absent("other_candidate");
}
export function contrastLevel(name: string, numeric: ReadonlySet<string>): string | boolean | null {
  if (numeric.has(name)) return null;
  if (name === "timeBucket") return "<2m";
  if (name === "blockRelation") return "one_sided";
  if (name === "snapshotRole") return "matched_candidate";
  return true;
}
export function categoryDifference<T>(positive: readonly T[], negative: readonly T[], level: T): number | null {
  if (!positive.length || !negative.length) return null;
  return positive.filter((x) => x === level).length / positive.length - negative.filter((x) => x === level).length / negative.length;
}

export function containment(oldText: string, newText: string): { oldInNew: number; newInOld: number; jaccard: number } {
  const tokens = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const old = tokens(oldText), newer = tokens(newText);
  const intersection = [...old].filter((x) => newer.has(x)).length;
  const union = new Set([...old, ...newer]).size;
  return { oldInNew: old.size ? intersection / old.size : 1, newInOld: newer.size ? intersection / newer.size : 1, jaccard: union ? intersection / union : 1 };
}

export function provenanceBlocks(oldText: string, newText: string): { oldSource: boolean; newSource: boolean; oldList: boolean; newList: boolean; relation: "none" | "identical" | "different" | "one_sided" } {
  const marker = /\n\n(?:Source:|Exact source list:)\n/u;
  const block = (s: string) => { const i = s.search(marker); return i < 0 ? "" : s.slice(i); };
  const old = block(oldText), newer = block(newText);
  return { oldSource: oldText.includes("\n\nSource:\n"), newSource: newText.includes("\n\nSource:\n"), oldList: oldText.includes("\n\nExact source list:\n"), newList: newText.includes("\n\nExact source list:\n"), relation: !old && !newer ? "none" : !old || !newer ? "one_sided" : old === newer ? "identical" : "different" };
}

export function timeGap(occurred: string | null, created: string | null): Signal<number> {
  if (!occurred || !created) return absent("missing_value");
  const gap = (Date.parse(occurred) - Date.parse(created)) / 1000;
  return Number.isFinite(gap) && gap >= 0 ? present(gap) : absent("invalid_time");
}
export function timeBucket(gap: number): "<2m" | "<1h" | "<1d" | "<7d" | ">=7d" {
  return gap < 120 ? "<2m" : gap < 3600 ? "<1h" : gap < 86400 ? "<1d" : gap < 604800 ? "<7d" : ">=7d";
}
export function shortBefore(gap: Signal<number>): Signal<boolean> {
  return gap.value === null ? absent(gap.reason!) : present(gap.value <= 120);
}
export function captureEqual(outcome: string, old: string | null, applied: string | null): Signal<boolean> {
  if (outcome !== "create" && outcome !== "supersede") return absent("not_applicable");
  return old && applied ? present(old === applied) : absent("missing_value");
}
export function storedCosine(old: number[] | null, newer: number[] | null, outcome: string): Signal<number> {
  if (outcome !== "create" && outcome !== "supersede") return absent("no_incoming_embedding");
  if (!old?.length || !newer?.length) return absent("missing_value");
  if (old.length !== newer.length || [...old, ...newer].some((n) => !Number.isFinite(n))) return absent("invalid_embedding");
  const dot = old.reduce((sum, x, i) => sum + x * newer[i]!, 0);
  const a = Math.hypot(...old), b = Math.hypot(...newer);
  return a && b ? present(Math.max(-1, Math.min(1, dot / a / b))) : absent("invalid_embedding");
}
export function textSignals(oldRaw: string, newRaw: string) {
  const visible = judgeInputTexts(oldRaw, newRaw, "strip-provenance");
  const shorter = Math.min(visible.oldText.length, visible.newText.length);
  const longer = Math.max(visible.oldText.length, visible.newText.length);
  return { indistinguishable: visible.indistinguishable, ...containment(visible.oldText, visible.newText), lengthRatio: longer ? shorter / longer : 1, ...provenanceBlocks(oldRaw, newRaw) };
}

export function auc(positive: readonly number[], negative: readonly number[]): number | null {
  if (!positive.length || !negative.length) return null;
  let wins = 0;
  for (const x of positive) for (const y of negative) wins += x > y ? 1 : x === y ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}
export function quantile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), at = (a.length - 1) * p, lo = Math.floor(at);
  return a[lo]! + (a[Math.ceil(at)]! - a[lo]!) * (at - lo);
}
export function clusterBootstrap<T extends { cluster: number }>(rows: readonly T[], statistic: (sample: readonly T[]) => number | null, iterations = 2000): { interval: [number, number] | null; nullCount: number } {
  const groups = new Map<number, T[]>();
  for (const row of rows) groups.set(row.cluster, [...(groups.get(row.cluster) ?? []), row]);
  const clusters = [...groups.values()];
  if (!clusters.length) return { interval: null, nullCount: iterations };
  let seed = 0x51a7e;
  const random = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const results: number[] = [];
  let nullCount = 0;
  for (let i = 0; i < iterations; i++) {
    const sample: T[] = [];
    for (let j = 0; j < clusters.length; j++) sample.push(...clusters[Math.floor(random() * clusters.length)]!);
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) results.push(value);
    else nullCount++;
  }
  const lo = quantile(results, 0.025), hi = quantile(results, 0.975);
  return { interval: lo === null || hi === null ? null : [lo, hi], nullCount };
}

const PAIR = /^ss-[a-f0-9]{12}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
export const ENUMS = new Set(["wrong_retirement", "wrong_skip", "correct_keep", "duplicate_as_duplicate", "duplicate_as_retire", "missed_update", "update_landed", "independent", "duplicate", "supersede", "harmful", "baseline", "other", "matched_candidate", "blocked_nomination", "create", "skip", "merge", "merge-update", "judge", "judge_pending", "exact-dup", "correction-supersede", "recent-near-dup-skip", "store-near-dup-skip", "merge-band", "none", "identical", "different", "one_sided", "<2m", "<1h", "<1d", "<7d", ">=7d", ...REASONS]);
const SNAPSHOT_KEYS = new Set(["fetchedAt", "namespaceVerified", "namespaceOverlapCount", "rows"]);
const SNAPSHOT_ROW_KEYS = new Set(["pairId", "cluster", "oldCreatedAt", "occurredAt", "sameSession", "capturedAtEqual", "sameProject", "storedCosine", "appliedOutcome", "wouldOutcome", "wouldBand"]);
const SIGNAL_KEYS = new Set(["pairId", "cluster", "outcome", "gold", "group", "snapshotRole", "indistinguishable", "sameSession", "capturedAtEqual", "oldCreatedShortlyBeforeLog", "timeGapSeconds", "timeBucket", "oldInNew", "newInOld", "jaccard", "lengthRatio", "oldSource", "newSource", "oldList", "newList", "blockRelation", "storedCosine", "sameProject", "appliedOutcome", "wouldOutcome", "wouldBand"]);
const SIGNAL_VALUE_KEYS = new Set(["value", "reason"]);
const SNAPSHOT_SIGNAL_KEYS = new Set(["sameSession", "capturedAtEqual", "sameProject", "storedCosine", "appliedOutcome", "wouldOutcome", "wouldBand"]);
const ROW_SIGNAL_KEYS = new Set([...SNAPSHOT_SIGNAL_KEYS, "oldCreatedShortlyBeforeLog", "timeGapSeconds", "timeBucket", "oldInNew", "newInOld", "jaccard", "lengthRatio", "oldSource", "newSource", "oldList", "newList", "blockRelation"]);
function exactKeys(value: unknown, allowed: Set<string>, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid private artifact object at ${path}`);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((k) => !allowed.has(k))) throw new Error(`invalid private artifact keys at ${path}`);
}
export function validatePrivateArtifact(value: unknown, kind: "snapshot" | "signal"): void {
  if (kind === "snapshot") {
    exactKeys(value, SNAPSHOT_KEYS, "snapshot");
    if (!Array.isArray((value as { rows: unknown }).rows)) throw new Error("invalid snapshot rows");
    for (const row of (value as { rows: unknown[] }).rows) {
      exactKeys(row, SNAPSHOT_ROW_KEYS, "snapshot row");
      for (const key of SNAPSHOT_SIGNAL_KEYS) exactKeys((row as Record<string, unknown>)[key], SIGNAL_VALUE_KEYS, key);
    }
  } else {
    exactKeys(value, SIGNAL_KEYS, "signal");
    for (const key of ROW_SIGNAL_KEYS) exactKeys((value as Record<string, unknown>)[key], SIGNAL_VALUE_KEYS, key);
  }
  const walk = (v: unknown, key: string): void => {
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v === "string") {
      if (key === "pairId" ? PAIR.test(v) : key === "fetchedAt" || key === "oldCreatedAt" || key === "occurredAt" ? ISO.test(v) : ENUMS.has(v)) return;
      throw new Error(`invalid private artifact string at ${key}`);
    }
    if (Array.isArray(v)) { for (const item of v) walk(item, key); return; }
    if (typeof v === "object" && v) {
      if ("value" in v || "reason" in v) {
        exactKeys(v, SIGNAL_VALUE_KEYS, key);
        const signal = v as { value: unknown; reason: unknown };
        if ((signal.value === null) === (signal.reason === null)) throw new Error(`invalid null signal at ${key}`);
      }
      for (const [k, item] of Object.entries(v)) walk(item, k);
      return;
    }
    throw new Error(`invalid private artifact value at ${key}`);
  };
  walk(value, "root");
}
