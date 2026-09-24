#!/usr/bin/env npx tsx
/**
 * Judge benchmark — reconciliation worklists (Rúnir-lso.3).
 *
 *   worklist   agreement stats + a disagreement worklist + the seeded spot-check sample (agreed pairs),
 *              each with texts, for orchestrator content verification. Local only (text-bearing).
 *
 * Spot-check sample (brief §2, frozen): 36 agreed pairs; ≥ 8 per agreed gold class (where available),
 * ≥ 12 per part, ≥ 2 per declared stratum; filled at random (seeded) to 36.
 * Adjudication happens BEFORE any candidate lane runs on this dataset.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rng, shuffle } from "./shared.js";

const DATASET_ID = process.env.JUDGE_DATASET_ID ?? "supersession-fresh-v1";
const ROOT = ".styrir/analysis/judge-benchmark";
const SPOT_N = 36;
const SEED = 36036;

type Pair = { pairId: string; part: string; stratum: string; cosine: number; oldRef: { id: string; createdAt: string }; newRef: { id: string; createdAt: string } };
type Lab = { pairId: string; label: string; reason: string };

const jl = <T>(p: string): T[] => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

function main(): void {
  const { pairs } = JSON.parse(readFileSync(join(ROOT, "mining", `${DATASET_ID}.pairs.json`), "utf8")) as { pairs: Pair[] };
  const A = new Map(jl<Lab>(join(ROOT, "labels", `${DATASET_ID}.gpt.jsonl`)).map((r) => [r.pairId, r]));
  const B = new Map(jl<Lab>(join(ROOT, "labels", `${DATASET_ID}.grok.jsonl`)).map((r) => [r.pairId, r]));
  const texts = new Map(jl<{ id: string; text: string }>(join(ROOT, "texts", `${DATASET_ID}.jsonl`)).map((r) => [r.id, r.text]));

  const missing = pairs.filter((p) => !A.has(p.pairId) || !B.has(p.pairId)).map((p) => p.pairId);
  if (missing.length) throw new Error(`${missing.length} pairs lack a label from one labeler: ${missing.slice(0, 5).join(",")}…`);

  const confusion: Record<string, number> = {};
  const byStratum: Record<string, { n: number; agree: number }> = {};
  const agreed: Array<Pair & { label: string }> = [];
  const disagreements: unknown[] = [];
  const view = (p: Pair) => ({ oldCreatedAt: p.oldRef.createdAt, old: texts.get(p.oldRef.id), newCreatedAt: p.newRef.createdAt, new: texts.get(p.newRef.id) });
  for (const p of pairs) {
    const a = A.get(p.pairId)!;
    const b = B.get(p.pairId)!;
    confusion[`${a.label}|${b.label}`] = (confusion[`${a.label}|${b.label}`] ?? 0) + 1;
    const key = `${p.part}:${p.stratum}`;
    byStratum[key] ??= { n: 0, agree: 0 };
    byStratum[key].n++;
    if (a.label === b.label) {
      byStratum[key].agree++;
      agreed.push({ ...p, label: a.label });
    } else {
      disagreements.push({ pairId: p.pairId, part: p.part, stratum: p.stratum, gpt: a.label, gptReason: a.reason, grok: b.label, grokReason: b.reason, ...view(p) });
    }
  }

  // Seeded spot-check sample honouring the frozen minima.
  const rand = rng(SEED);
  const shuffled = shuffle([...agreed].sort((x, y) => x.pairId.localeCompare(y.pairId)), rand);
  const chosen = new Map<string, Pair & { label: string }>();
  const take = (pred: (p: Pair & { label: string }) => boolean, min: number) => {
    let have = [...chosen.values()].filter(pred).length;
    for (const p of shuffled) {
      if (have >= min) break;
      if (!chosen.has(p.pairId) && pred(p)) { chosen.set(p.pairId, p); have++; }
    }
  };
  for (const cls of ["supersede", "duplicate", "independent"]) take((p) => p.label === cls, 8);
  for (const part of ["probability", "challenge"]) take((p) => p.part === part, 12);
  for (const s of [...new Set(pairs.map((p) => `${p.part}:${p.stratum}`))]) take((p) => `${p.part}:${p.stratum}` === s, 2);
  take(() => true, SPOT_N);
  const spot = [...chosen.values()].map((p) => ({ pairId: p.pairId, part: p.part, stratum: p.stratum, agreedLabel: p.label, gptReason: A.get(p.pairId)!.reason, grokReason: B.get(p.pairId)!.reason, ...view(p) }));

  const outDir = join(ROOT, "reconcile");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${DATASET_ID}.disagreements.jsonl`), disagreements.map((d) => JSON.stringify(d)).join("\n") + "\n");
  writeFileSync(join(outDir, `${DATASET_ID}.spotcheck.jsonl`), spot.map((d) => JSON.stringify(d)).join("\n") + "\n");
  const agreedByClass = agreed.reduce<Record<string, number>>((m, p) => ((m[p.label] = (m[p.label] ?? 0) + 1), m), {});
  const stats = {
    pairs: pairs.length,
    agreed: agreed.length,
    agreementRate: +(agreed.length / pairs.length).toFixed(3),
    agreedByClass,
    disagreements: disagreements.length,
    confusion_gpt_by_grok: confusion,
    agreementByStratum: byStratum,
    spotCheck: { n: spot.length, byClass: spot.reduce<Record<string, number>>((m, s) => ((m[s.agreedLabel] = (m[s.agreedLabel] ?? 0) + 1), m), {}) },
  };
  writeFileSync(join(outDir, `${DATASET_ID}.agreement.json`), JSON.stringify(stats, null, 2) + "\n");
  console.log(JSON.stringify(stats, null, 2));
}

main();
