#!/usr/bin/env npx tsx
/**
 * Judge benchmark — finalize adjudicated gold into committed, text-free labels files (Rúnir-lso.3).
 *
 * Inputs (gitignored, local): mining/<ds>.pairs.json + reconcile/<ds>.adjudicated.jsonl.
 * Output: fixtures/judge-benchmark/<ds>.labels.json, validated by the suite schema.
 *
 * Splits (brief §2, frozen; seeded; committed BEFORE any candidate runs on these datasets):
 *   supersession-fresh-v1   probability + challenge parts, each split 50/50 calibration/test,
 *                           stratified by stratum.
 *   supersession-shadow-v1  descriptive update-recall set → split "heldout" (never calibrated on,
 *                           never gated).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateLabels } from "../../src/testing/judge-benchmark/schema.js";
import { JUDGE_BENCHMARK_SCHEMA_VERSION, JUDGE_TASK_ID, type JudgePair } from "../../src/testing/judge-benchmark/types.js";
import { rng, shuffle } from "./shared.js";

const ROOT = ".styrir/analysis/judge-benchmark";
const SPLIT_SEED = 50505;

type Mined = { pairId: string; part: string; stratum: string; cosine: number | null; oldRef: { source: string; id: string; sha256: string; createdAt: string }; newRef: { source: string; id: string; sha256: string; createdAt: string } };
type Adj = { pairId: string; gold: string; labelA: string; labelB: string; resolution: string; spotChecked: boolean; spotCheckVerdict: string | null; positiveReviewed: boolean };

function finalize(datasetId: string, origin: string): void {
  const { pairs } = JSON.parse(readFileSync(join(ROOT, "mining", `${datasetId}.pairs.json`), "utf8")) as { pairs: Mined[] };
  const adj = new Map(
    readFileSync(join(ROOT, "reconcile", `${datasetId}.adjudicated.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => {
      const r = JSON.parse(l) as Adj;
      return [r.pairId, r] as const;
    }),
  );
  if (adj.size !== pairs.length) throw new Error(`${datasetId}: ${pairs.length} pairs but ${adj.size} adjudicated rows`);

  // Stratified 50/50 split per (part, stratum) with a fixed seed; shadow is descriptive → heldout.
  const split = new Map<string, JudgePair["split"]>();
  const rand = rng(SPLIT_SEED);
  const groups = new Map<string, Mined[]>();
  for (const p of [...pairs].sort((a, b) => a.pairId.localeCompare(b.pairId))) {
    const key = `${p.part}:${p.stratum}`;
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  for (const [key, members] of groups) {
    if (key.startsWith("shadow:")) { for (const m of members) split.set(m.pairId, "heldout"); continue; }
    const shuffled = shuffle(members, rand);
    shuffled.forEach((m, i) => split.set(m.pairId, i % 2 === 0 ? "calibration" : "test"));
  }

  const out: JudgePair[] = pairs.map((p) => {
    const a = adj.get(p.pairId)!;
    return {
      pairId: p.pairId,
      oldRef: { source: p.oldRef.source, id: p.oldRef.id, sha256: p.oldRef.sha256, createdAt: p.oldRef.createdAt },
      newRef: { source: p.newRef.source, id: p.newRef.id, sha256: p.newRef.sha256, createdAt: p.newRef.createdAt },
      stratum: p.stratum,
      split: split.get(p.pairId)!,
      origin,
      population: p.part as JudgePair["population"],
      cosine: p.cosine,
      gold: {
        label: a.gold as JudgePair["gold"]["label"],
        labelA: a.labelA as JudgePair["gold"]["label"],
        labelB: a.labelB as JudgePair["gold"]["label"],
        resolution: a.resolution as JudgePair["gold"]["resolution"],
        spotChecked: a.spotChecked,
        spotCheckVerdict: a.spotCheckVerdict === null ? null : a.spotCheckVerdict === "error" ? "repaired" : "confirmed",
        positiveReviewed: a.positiveReviewed,
      },
    };
  });
  const file = { schemaVersion: JUDGE_BENCHMARK_SCHEMA_VERSION, taskId: JUDGE_TASK_ID, datasetId, legacyBinaryGold: false, pairs: out };
  validateLabels(file);
  const path = join("fixtures/judge-benchmark", `${datasetId}.labels.json`);
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", "utf8");
  const tally = out.reduce<Record<string, number>>((m, p) => ((m[`${p.population}/${p.split}/${p.gold.label}`] = (m[`${p.population}/${p.split}/${p.gold.label}`] ?? 0) + 1), m), {});
  console.log(JSON.stringify({ path, pairs: out.length, tally }, null, 2));
}

finalize("supersession-fresh-v1", "mined-current-state-2026-09-24");
finalize("supersession-shadow-v1", "supersede-shadow-snapshots-2026-09-24");
