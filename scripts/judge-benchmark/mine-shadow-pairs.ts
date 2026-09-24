#!/usr/bin/env npx tsx
/**
 * Judge benchmark — shadow "update-recall" set (Rúnir-lso.2, Part 3; user-approved 2026-09-24).
 *
 * Why: current-state mining is structurally blind to real updates. A correction arriving at high
 * cosine is merged into (or skipped against) its target, so it never exists as its own stored row,
 * and the merged target is excluded as polluted. The supersede_shadow log records the pair BEFORE
 * arbitration: incoming_text_full + candidate_snapshot_json (the referent's text AT DECISION TIME).
 *
 * Population: every supersede_shadow row with occurred_at ≥ 2026-07-10 (after the Q4 corpus) that
 * carries a candidate snapshot, for the tenant. Descriptive only — never the gated population.
 * Read-only against prod SurrealDB (main/main). Outputs mirror mine-supersession-pairs.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitleaksGate, sha256, surrealQuery } from "./shared.js";

const DATASET_ID = "supersession-shadow-v1";
const TENANT = "brooks";
const FROM = "2026-07-10T00:00:00Z";
const OUT_ROOT = ".styrir/analysis/judge-benchmark";
const SURREAL_URL = process.env.JUDGE_SURREAL_URL ?? "http://127.0.0.1:8000/sql";

const PROBE_FAILURE = "gitleaks positive probe NOT detected — refusing to proceed";

async function main(): Promise<void> {
  const rows = await surrealQuery<any>(
    `SELECT meta::id(id) AS id, occurred_at, would_outcome, would_band, would_cosine, would_signal,
            incoming_text_full, candidate_snapshot_json
     FROM supersede_shadow
     WHERE user_id = '${TENANT}' AND occurred_at >= d'${FROM}' AND candidate_snapshot_json != NONE
     ORDER BY occurred_at ASC;`,
    { ns: "main", db: "main", url: SURREAL_URL },
  );
  const texts = new Map<string, { sha256: string; text: string }>();
  const seen = new Set<string>();
  const pairs: unknown[] = [];
  let droppedNoText = 0, droppedDupPair = 0, droppedShort = 0;
  for (const r of rows) {
    const snap = JSON.parse(String(r.candidate_snapshot_json));
    const oldText = String(snap.l2 ?? "");
    const newText = String(r.incoming_text_full ?? "");
    if (!oldText || !newText) { droppedNoText++; continue; }
    if (oldText.length < 20 || newText.length < 20) { droppedShort++; continue; }
    const oldHash = sha256(oldText);
    const newHash = sha256(newText);
    const key = `${oldHash}|${newHash}`;
    if (seen.has(key)) { droppedDupPair++; continue; }
    seen.add(key);
    const oldId = `shadow-snapshot:${r.id}`;
    const newId = `shadow-incoming:${r.id}`;
    texts.set(oldId, { sha256: oldHash, text: oldText });
    texts.set(newId, { sha256: newHash, text: newText });
    pairs.push({
      pairId: `ss-${sha256(key).slice(0, 12)}`,
      part: "shadow",
      stratum: String(r.would_outcome),
      cosine: typeof r.would_cosine === "number" ? +r.would_cosine.toFixed(4) : null,
      band: r.would_band ?? null,
      signal: r.would_signal ?? null,
      snapshotRole: snap.snapshot_role ?? null,
      oldRef: { source: "archive:supersede-shadow-candidate-snapshot", id: oldId, sha256: oldHash, createdAt: String(r.occurred_at), memoryId: snap.id ?? null },
      newRef: { source: "archive:supersede-shadow-incoming", id: newId, sha256: newHash, createdAt: String(r.occurred_at) },
    });
  }
  const textsPath = join(OUT_ROOT, "texts", `${DATASET_ID}.jsonl`);
  mkdirSync(dirname(textsPath), { recursive: true });
  writeFileSync(textsPath, [...texts].map(([id, entry]) => JSON.stringify({ id, sha256: entry.sha256, text: entry.text })).join("\n") + "\n", "utf8");
  gitleaksGate(textsPath, PROBE_FAILURE);

  const byStratum = pairs.reduce<Record<string, number>>((m, p: any) => ((m[p.stratum] = (m[p.stratum] ?? 0) + 1), m), {});
  const manifest = {
    datasetId: DATASET_ID,
    generatedAt: new Date().toISOString(),
    population: `supersede_shadow rows, tenant ${TENANT}, occurred_at >= ${FROM}, with candidate_snapshot_json (decision-time referent text); descriptive update-recall set, NOT gated`,
    note: "OLD createdAt is the decision time (snapshot capture), not the referent's creation time; order is still OLD-before-NEW semantically.",
    counts: { shadowRowsWithSnapshot: rows.length, pairs: pairs.length, droppedNoText, droppedShort, droppedDupPair, byStratum },
    textSnapshot: { path: textsPath, gitleaks: "clean (positive probe verified)" },
  };
  const outPath = join(OUT_ROOT, "mining", `${DATASET_ID}.pairs.json`);
  writeFileSync(outPath, JSON.stringify({ manifest, pairs }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ out: outPath, ...manifest.counts }, null, 2));
}

await main();
