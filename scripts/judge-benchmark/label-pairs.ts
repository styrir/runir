#!/usr/bin/env npx tsx
/**
 * Judge benchmark — blind batch labeling (Rúnir-lso.3).
 *
 * Sends mined pairs to ONE external labeler in batches, with the frozen protocol
 * (`labeler-protocol.md`). Labelers run headless in an EMPTY temp directory, with no tools
 * and a read-only sandbox, so they cannot see the repo, the other labeler, cosine, stratum
 * or cue flags. Pair order is shuffled per labeler (seeded).
 *
 * Output: .styrir/analysis/judge-benchmark/labels/<datasetId>.<labeler>.jsonl (local only; reasons are
 * text-bearing). Resumable: pairs already labeled validly are skipped. Invalid or missing rows are
 * re-asked individually once.
 *
 * Usage: npx tsx scripts/judge-benchmark/label-pairs.ts --labeler gpt|grok [--effort low] [--batch 25] [--limit N]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rng, shuffle } from "./shared.js";

const DATASET_ID = process.env.JUDGE_DATASET_ID ?? "supersession-fresh-v1";
const ROOT = ".styrir/analysis/judge-benchmark";
const LABELS = new Set(["supersede", "duplicate", "independent"]);
const PROTOCOL = resolve("scripts/judge-benchmark/labeler-protocol.md");

type Pair = { pairId: string; oldRef: { id: string; createdAt: string; sha256: string }; newRef: { id: string; createdAt: string; sha256: string } };
type Label = { pairId: string; label: string; reason: string; labeler: string; model: string; effort: string; batch: number };

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function runLabeler(labeler: string, model: string, effort: string, prompt: string): string {
  const dir = mkdtempSync(join(tmpdir(), `judge-label-${labeler}-`));
  const promptPath = join(dir, "prompt.md");
  writeFileSync(promptPath, prompt, "utf8");
  if (labeler === "gpt") {
    const out = join(dir, "last.txt");
    execFileSync(
      "codex",
      ["exec", "-m", model, "-c", `model_reasoning_effort=${effort}`, "--sandbox", "read-only", "--skip-git-repo-check",
        "-C", dir, "--output-last-message", out, "-"],
      { input: prompt, stdio: ["pipe", "ignore", "pipe"], timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return readFileSync(out, "utf8");
  }
  return execFileSync(
    "grok",
    ["-m", model, "--reasoning-effort", effort, "--prompt-file", promptPath, "--cwd", dir, "--tools", "",
      "--disable-web-search", "--no-subagents", "--max-turns", "5", "--output-format", "plain"],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  ).toString("utf8");
}

function parse(raw: string, expected: Set<string>): Map<string, { label: string; reason: string }> {
  const out = new Map<string, { label: string; reason: string }>();
  for (const line of raw.split("\n")) {
    const m = line.trim().replace(/^```\w*|```$/g, "").trim();
    if (!m.startsWith("{")) continue;
    try {
      const o = JSON.parse(m);
      if (expected.has(o.pairId) && LABELS.has(o.label) && !out.has(o.pairId)) {
        out.set(o.pairId, { label: o.label, reason: String(o.reason ?? "").slice(0, 300) });
      }
    } catch {
      /* non-JSON line — ignored; missing pairs are re-asked */
    }
  }
  return out;
}

function main(): void {
  const labeler = arg("labeler");
  if (labeler !== "gpt" && labeler !== "grok") throw new Error("--labeler gpt|grok required");
  const model = labeler === "gpt" ? "gpt-6-sol" : "grok-4.7";
  const effort = arg("effort", "low")!;
  const batchSize = Number(arg("batch", "25"));
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;

  const { pairs } = JSON.parse(readFileSync(join(ROOT, "mining", `${DATASET_ID}.pairs.json`), "utf8")) as { pairs: Pair[] };
  const texts = new Map<string, { sha256: string; text: string }>();
  for (const l of readFileSync(join(ROOT, "texts", `${DATASET_ID}.jsonl`), "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    texts.set(r.id, r);
  }
  for (const p of pairs) {
    for (const ref of [p.oldRef, p.newRef]) {
      if (texts.get(ref.id)?.sha256 !== ref.sha256) throw new Error(`text snapshot mismatch for ${ref.id}`);
    }
  }

  const outPath = join(ROOT, "labels", `${DATASET_ID}.${labeler}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  const done = new Set(
    existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Label).pairId) : [],
  );
  const rand = rng(labeler === "gpt" ? 101 : 202);
  const order = shuffle([...pairs].sort((a, b) => a.pairId.localeCompare(b.pairId)), rand);
  const todo = order.filter((p) => !done.has(p.pairId)).slice(0, limit);
  const protocol = readFileSync(PROTOCOL, "utf8");
  const render = (batch: Pair[]) =>
    `${protocol}\n\n## Batch (${batch.length} pairs)\n\n` +
    batch
      .map((p) => JSON.stringify({ pairId: p.pairId, old: { createdAt: p.oldRef.createdAt, text: texts.get(p.oldRef.id)!.text }, new: { createdAt: p.newRef.createdAt, text: texts.get(p.newRef.id)!.text } }))
      .join("\n");

  let batchNo = 0;
  let written = 0;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    batchNo++;
    const expected = new Set(batch.map((p) => p.pairId));
    let got = new Map<string, { label: string; reason: string }>();
    try {
      got = parse(runLabeler(labeler, model, effort, render(batch)), expected);
    } catch (err) {
      console.error(`batch ${batchNo}: labeler call failed: ${String(err).slice(0, 200)}`);
    }
    // Re-ask missing/invalid pairs individually, once.
    for (const p of batch.filter((b) => !got.has(b.pairId))) {
      try {
        const one = parse(runLabeler(labeler, model, effort, render([p])), new Set([p.pairId]));
        const v = one.get(p.pairId);
        if (v) got.set(p.pairId, v);
      } catch (err) {
        console.error(`pair ${p.pairId}: single re-ask failed: ${String(err).slice(0, 200)}`);
      }
    }
    for (const p of batch) {
      const v = got.get(p.pairId);
      if (!v) continue;
      appendFileSync(outPath, JSON.stringify({ pairId: p.pairId, label: v.label, reason: v.reason, labeler, model, effort, batch: batchNo } satisfies Label) + "\n");
      written++;
    }
    console.log(`${labeler} batch ${batchNo}: ${got.size}/${batch.length} labeled (total written ${written}/${todo.length})`);
  }
  const missing = todo.length - written;
  console.log(JSON.stringify({ labeler, model, effort, attempted: todo.length, written, missing, out: outPath }));
  if (missing > 0) process.exitCode = 1;
}

main();
