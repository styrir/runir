#!/usr/bin/env npx tsx
/**
 * Judge benchmark — mine the fresh supersession pair set (Rúnir-lso.2).
 *
 * Read-only against prod SurrealDB (main/main). Builds a sampled PAIR-CLASSIFICATION set from the
 * CURRENT stored state (not a historical reconstruction of what the matcher saw at write time).
 * Retrieval contract, exclusions, inclusion rates and clustering are written to the mining manifest.
 *
 *   NEW  = semiote rows for the tenant with an embedding, created in [WINDOW_START, WINDOW_END).
 *   OLD  = same tenant, embedding present, created in [NEW − 72h, NEW), scope rule as findSimilarMemories;
 *          active AND inactive rows eligible (retired rows are where many true positives live).
 *   cosine is computed in-process over one windowed read (same math as vector::similarity::cosine;
 *   no composite vector+time index exists, so the DB would scan too).
 *   Exclusions: either side merge-polluted (payload.arbitrationOutcome = 'merge-update'), either text
 *   < 20 chars, verbatim containment (shorter side ≥ 80 normalized chars fully inside the longer, or
 *   the first 80 normalized chars of either side inside the other).
 *   One pair per NEW: its top-1 eligible OLD.
 *   Part 1 (probability sample, the only gated population): uniform sample of NEWs whose top-1 cosine
 *   ≥ 0.85 (production supersede-candidacy floor = merge threshold).
 *   Part 2 (challenge set, descriptive): disjoint by NEW; per cosine band {0.70–0.85, 0.85–0.95, ≥0.95},
 *   cue pairs first (production signal predicates, imported), filled from non-cue pairs in-band.
 *
 * Outputs (gitignored .styrir/analysis/judge-benchmark/):
 *   texts/<datasetId>.jsonl           {id, sha256, text}          — text-bearing, local only
 *   mining/<datasetId>.pairs.json     text-free pair list + manifest
 * then a gitleaks raw-file gate (positive probe first) over the text snapshot.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitleaksGate, rng, sha256, shuffle, surrealQuery } from "./shared.js";
import {
  hasCorrectionMarker,
  hasCurrentnessCue,
  sharesSlotTags,
} from "../../src/storage/writes/write-signals.js";
import { anchorRelation, extractReferentAnchors } from "../../src/storage/writes/referent-identity.js";

const DATASET_ID = process.env.JUDGE_DATASET_ID ?? "supersession-fresh-v1";
const TENANT = process.env.JUDGE_MINE_TENANT ?? "brooks";
const WINDOW_START = "2026-07-15T00:00:00Z";
const WINDOW_END = "2026-09-21T00:00:00Z";
const LOOKBACK_HOURS = 72;
const COSINE_FLOOR = 0.7;
const GATED_FLOOR = 0.85;
const PROB_TARGET = 200;
const CHALLENGE_PER_BAND = 50;
const BANDS: Array<{ id: string; lo: number; hi: number }> = [
  { id: "c070-085", lo: 0.7, hi: 0.85 },
  { id: "c085-095", lo: 0.85, hi: 0.95 },
  { id: "c095-100", lo: 0.95, hi: 1.0001 },
];
const SEED = 20260924;
const OUT_ROOT = ".styrir/analysis/judge-benchmark";
const SOURCE = "prod:main/main:semiote";
const SURREAL_URL = process.env.JUDGE_SURREAL_URL ?? "http://127.0.0.1:8000/sql";

type Row = {
  id: string;
  createdAt: string;
  createdMs: number;
  scope: string | null;
  sessionId: string | null;
  text: string;
  tags: string[];
  active: boolean;
  inactiveReason: string | null;
  arbitrationOutcome: string | null;
  embedding: number[];
  norm: number;
};

export type MinedPair = {
  pairId: string;
  part: "probability" | "challenge";
  stratum: string;
  cosine: number;
  cue: boolean;
  cueSignals: string[];
  oldRef: { source: string; id: string; sha256: string; createdAt: string; active: boolean; inactiveReason: string | null };
  newRef: { source: string; id: string; sha256: string; createdAt: string };
};

const normalize = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

function verbatimContained(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= 80 && long.includes(short)) return true;
  return (na.length >= 80 && nb.includes(na.slice(0, 80))) || (nb.length >= 80 && na.includes(nb.slice(0, 80)));
}

function cosine(a: Row, b: Row): number {
  let dot = 0;
  for (let i = 0; i < a.embedding.length; i++) dot += a.embedding[i]! * b.embedding[i]!;
  return a.norm && b.norm ? dot / (a.norm * b.norm) : 0;
}

/** Same scope rule as findSimilarMemories for the incoming row's scope. */
function scopeEligible(neu: Row, old: Row): boolean {
  if (neu.scope === "session") return old.scope === "session" && old.sessionId === neu.sessionId;
  if (neu.scope === "global") return old.scope === "global";
  return old.scope === null || old.scope === "user";
}

function cueSignals(neu: Row, old: Row): string[] {
  const s: string[] = [];
  if (hasCurrentnessCue(neu.text)) s.push("currentness_cue");
  if (hasCorrectionMarker(neu.tags)) s.push("correction_marker");
  if (sharesSlotTags(old.tags, neu.tags)) s.push("shared_slot_tags");
  if (anchorRelation(extractReferentAnchors(old.text), extractReferentAnchors(neu.text)) === "shared") s.push("shared_anchor");
  return s;
}

const PROBE_FAILURE = "gitleaks positive probe NOT detected — detector unusable, refusing to proceed";

async function main(): Promise<void> {
  const lookbackStart = new Date(Date.parse(WINDOW_START) - LOOKBACK_HOURS * 3600_000).toISOString();
  const raw = await surrealQuery<any>(
    `SELECT meta::id(id) AS id, created_at, scope, session_id, payload.l2 AS l2, payload.data AS data, payload.tags AS tags,
            active, inactive_reason, payload.arbitrationOutcome AS ao, embedding
     FROM semiote
     WHERE payload.userId = $tenant AND embedding != NONE
       AND created_at >= <datetime>$from AND created_at < <datetime>$to;`,
    { ns: "main", db: "main", url: SURREAL_URL, vars: { tenant: TENANT, from: lookbackStart, to: WINDOW_END } },
  );
  const rows: Row[] = raw.map((r) => {
    const text = String(r.l2 ?? r.data ?? "");
    const emb = r.embedding as number[];
    return {
      id: String(r.id),
      createdAt: String(r.created_at),
      createdMs: Date.parse(String(r.created_at)),
      scope: r.scope ?? null,
      sessionId: r.session_id ?? null,
      text,
      tags: Array.isArray(r.tags) ? r.tags.filter((t: unknown): t is string => typeof t === "string") : [],
      active: r.active !== false,
      inactiveReason: r.inactive_reason ?? null,
      arbitrationOutcome: r.ao ?? null,
      embedding: emb,
      norm: Math.sqrt(emb.reduce((s, x) => s + x * x, 0)),
    };
  });
  rows.sort((a, b) => a.createdMs - b.createdMs);
  const dims = new Set(rows.map((r) => r.embedding.length));
  if (dims.size !== 1) throw new Error(`mixed embedding dims ${[...dims]}`);

  const startMs = Date.parse(WINDOW_START);
  const news = rows.filter((r) => r.createdMs >= startMs);
  const counts = { newRows: news.length, lookbackRows: rows.length - news.length, newMergePolluted: 0, newShort: 0, mergePollutedRowsInWindow: rows.filter((r) => r.arbitrationOutcome === "merge-update").length, shortRowsInWindow: rows.filter((r) => r.text.length < 20).length, excludedContainment: 0, newWithoutCandidate: 0, newTop1BelowFloor: 0 };

  type Top = { neu: Row; old: Row; cos: number };
  const tops: Top[] = [];
  let windowStart = 0;
  for (const neu of news) {
    if (neu.arbitrationOutcome === "merge-update") { counts.newMergePolluted++; continue; }
    if (neu.text.length < 20) { counts.newShort++; continue; }
    const lo = neu.createdMs - LOOKBACK_HOURS * 3600_000;
    while (windowStart < rows.length && rows[windowStart]!.createdMs < lo) windowStart += 1;
    let best: Top | null = null;
    for (let index = windowStart; index < rows.length; index += 1) {
      const old = rows[index]!;
      if (old.createdMs >= neu.createdMs) break;
      if (old.id === neu.id || !scopeEligible(neu, old)) continue;
      if (old.arbitrationOutcome === "merge-update" || old.text.length < 20) continue;
      const c = cosine(neu, old);
      if (c < COSINE_FLOOR || (best && c <= best.cos)) continue;
      if (verbatimContained(neu.text, old.text)) { counts.excludedContainment++; continue; }
      best = { neu, old, cos: c };
    }
    if (!best) { counts.newWithoutCandidate++; continue; }
    tops.push(best);
  }

  const rand = rng(SEED);
  const hashById = new Map<string, string>();
  const textSha = (row: Row): string => {
    const cached = hashById.get(row.id);
    if (cached !== undefined) return cached;
    const hash = sha256(row.text);
    hashById.set(row.id, hash);
    return hash;
  };
  const toPair = (t: Top, part: MinedPair["part"], stratum: string, sig = cueSignals(t.neu, t.old)): MinedPair => {
    return {
      pairId: `sp-${sha256(`${t.old.id}|${t.neu.id}`).slice(0, 12)}`,
      part,
      stratum,
      cosine: +t.cos.toFixed(4),
      cue: sig.length > 0,
      cueSignals: sig,
      oldRef: { source: SOURCE, id: t.old.id, sha256: textSha(t.old), createdAt: t.old.createdAt, active: t.old.active, inactiveReason: t.old.inactiveReason },
      newRef: { source: SOURCE, id: t.neu.id, sha256: textSha(t.neu), createdAt: t.neu.createdAt },
    };
  };
  const band = (c: number) => BANDS.find((b) => c >= b.lo && c < b.hi)!.id;

  // Part 1 — probability sample over NEWs whose top-1 ≥ gated floor.
  const gatedEligible = tops.filter((t) => t.cos >= GATED_FLOOR);
  const prob = shuffle(gatedEligible, rand).slice(0, PROB_TARGET).map((t) => toPair(t, "probability", band(t.cos)));
  const usedNew = new Set(prob.map((p) => p.newRef.id));

  // Part 2 — challenge set: per band, cue pairs first, then non-cue in-band.
  const challenge: MinedPair[] = [];
  const inclusion: Record<string, { eligibleCue: number; eligibleNonCue: number; takenCue: number; takenNonCue: number }> = {};
  for (const b of BANDS) {
    const pool = tops.filter((t) => !usedNew.has(t.neu.id) && t.cos >= b.lo && t.cos < b.hi).map((t) => ({ t, sig: cueSignals(t.neu, t.old) }));
    const cue = shuffle(pool.filter((x) => x.sig.length > 0), rand);
    const non = shuffle(pool.filter((x) => x.sig.length === 0), rand);
    const takeCue = cue.slice(0, CHALLENGE_PER_BAND);
    const takeNon = non.slice(0, CHALLENGE_PER_BAND - takeCue.length);
    for (const x of takeCue) challenge.push(toPair(x.t, "challenge", `${b.id}:cue`, x.sig));
    for (const x of takeNon) challenge.push(toPair(x.t, "challenge", `${b.id}:none`, x.sig));
    inclusion[b.id] = { eligibleCue: cue.length, eligibleNonCue: non.length, takenCue: takeCue.length, takenNonCue: takeNon.length };
  }

  const pairs = [...prob, ...challenge];
  const oldUse = new Map<string, number>();
  for (const p of pairs) oldUse.set(p.oldRef.id, (oldUse.get(p.oldRef.id) ?? 0) + 1);
  const magnets = [...oldUse.values()].filter((n) => n > 1);
  counts.newTop1BelowFloor = tops.filter((t) => t.cos < GATED_FLOOR).length;

  // Text snapshot (local only) for exactly the ids in the set.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = [...new Set(pairs.flatMap((p) => [p.oldRef.id, p.newRef.id]))];
  const textsPath = join(OUT_ROOT, "texts", `${DATASET_ID}.jsonl`);
  mkdirSync(dirname(textsPath), { recursive: true });
  writeFileSync(textsPath, ids.map((id) => {
    const row = byId.get(id)!;
    return JSON.stringify({ id, sha256: textSha(row), text: row.text });
  }).join("\n") + "\n", "utf8");
  gitleaksGate(textsPath, PROBE_FAILURE);

  const manifest = {
    datasetId: DATASET_ID,
    generatedAt: new Date().toISOString(),
    seed: SEED,
    tenant: TENANT,
    retrievalContract: {
      kind: "sampled pair-classification from CURRENT stored state (not a historical reconstruction)",
      source: SOURCE,
      newWindow: [WINDOW_START, WINDOW_END],
      oldLookbackHours: LOOKBACK_HOURS,
      scopeRule: "findSimilarMemories: user → scope NONE|user; session → same session_id; global → global",
      activeFilter: "none (active and inactive OLD rows eligible)",
      cosine: "in-process dot/(|a||b|) over stored embeddings (== vector::similarity::cosine)",
      cosineFloor: COSINE_FLOOR,
      onePairPerNew: "top-1 eligible OLD",
      exclusions: ["payload.arbitrationOutcome = 'merge-update' on either side", "text < 20 chars", "verbatim containment (≥80 normalized chars)"],
      gatedPopulation: `probability part: top-1 prior candidate with cosine ≥ ${GATED_FLOOR}, current stored state`,
    },
    counts: {
      ...counts,
      newWithTop1: tops.length,
      gatedEligibleNew: gatedEligible.length,
      probabilitySampled: prob.length,
      probabilityInclusionRate: gatedEligible.length ? +(prob.length / gatedEligible.length).toFixed(4) : 0,
      challengeSampled: challenge.length,
      challengeInclusion: inclusion,
      oldIdsInMoreThanOnePair: magnets.length,
      maxPairsSharingOneOld: magnets.length ? Math.max(...magnets) : 1,
      oldInactive: pairs.filter((p) => !p.oldRef.active).length,
    },
    textSnapshot: { path: textsPath, sha256: sha256(ids.map((id) => byId.get(id)!.text).join("\u0000")), gitleaks: "clean (positive probe verified)" },
  };
  const outPath = join(OUT_ROOT, "mining", `${DATASET_ID}.pairs.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ manifest, pairs }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ out: outPath, ...manifest.counts }, null, 2));
}

await main();
