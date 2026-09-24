#!/usr/bin/env npx tsx
/**
 * Import the preserved Q4 and July-5 supersession adjudications into text-free
 * labels files plus gitignored text snapshots.
 *
 * Texts are read with the bake-off's read-only Surreal queries. Q4 incoming
 * text comes from the archive labeler view (`incoming_text_full`) and is stored
 * under the synthetic ref id `q4-incoming:<shadow_row_id>`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSurrealTextClient, serializeSnapshot } from "../../src/testing/judge-benchmark/dataset.js";
import { buildHeldoutDataset, buildQ4Dataset, type HeldoutFinal, type HeldoutPacket, type Q4ArchiveRow } from "../../src/testing/judge-benchmark/legacy.js";
import { validateLabels } from "../../src/testing/judge-benchmark/schema.js";
import type { SnapshotLine } from "../../src/testing/judge-benchmark/types.js";

const ROOT = process.cwd();
const U5_DIR =
  process.env.BAKEOFF_U5_DIR ??
  join(process.env.HOME ?? "", "Code/runir-archive/.pipeline/pn1l-q4-readjudication-architect-handoff-2026-07-07/build/u5");
const HELD_DIR =
  process.env.BAKEOFF_0705_DIR ??
  join(process.env.HOME ?? "", "Code/runir-archive/.pipeline/shadow-adjudication-2026-07-05");

function jsonl(path: string): unknown[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

function scan(path: string): void {
  try {
    execFileSync("gitleaks", ["detect", "--no-git", "--no-banner", "--redact", "--exit-code", "1", "--source", path], {
      stdio: "pipe",
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    throw new Error(status === 1 ? `gitleaks found secret-like content in ${path}` : `gitleaks failed to run (status ${status})`);
  }
}

function writeDataset(dataset: unknown, snapshot: readonly SnapshotLine[], labelsName: string): void {
  const validated = validateLabels(dataset);
  const labelsPath = join(ROOT, "fixtures/judge-benchmark", labelsName);
  const textsPath = join(ROOT, ".styrir/analysis/judge-benchmark/texts", `${validated.datasetId}.jsonl`);
  mkdirSync(dirname(labelsPath), { recursive: true });
  mkdirSync(dirname(textsPath), { recursive: true });
  writeFileSync(labelsPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  writeFileSync(textsPath, serializeSnapshot(snapshot), "utf8");
  scan(textsPath);
}

async function textsFor(client: ReturnType<typeof createSurrealTextClient>, source: string, ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  let done = 0;
  for (const id of ids) {
    out.set(id, await client.read(source, id));
    done += 1;
    if (done % 25 === 0) console.log(`read ${done}/${ids.length} from ${source}`);
  }
  return out;
}

async function main(): Promise<void> {
  const client = createSurrealTextClient();
  const q4Rows = [
    ...(jsonl(join(U5_DIR, "labeler-input-diverged.jsonl")) as Q4ArchiveRow[]).map((row) => ({ ...row, frame: "diverged" as const })),
    ...(jsonl(join(U5_DIR, "labeler-input-control.jsonl")) as Q4ArchiveRow[]).map((row) => ({ ...row, frame: "control" as const })),
  ];
  const labelA = new Map((jsonl(join(U5_DIR, "labels.A.jsonl")) as Array<{ shadow_row_id: string; reviewer_label: string }>).map((row) => [row.shadow_row_id, row.reviewer_label]));
  const labelB = new Map((jsonl(join(U5_DIR, "labels.B.jsonl")) as Array<{ shadow_row_id: string; reviewer_label: string }>).map((row) => [row.shadow_row_id, row.reviewer_label]));
  const oldIds = [...new Set(q4Rows.map((row) => row.view.would.matched_candidate.id))];
  const oldById = new Map<string, { l2?: string; l0?: string }>();
  let readCount = 0;
  for (const id of oldIds) {
    const layers = await client.readLayers("eval:pn1l_eval/seed_q4corpus:semiote", id);
    if (layers) oldById.set(id, layers);
    readCount += 1;
    if (readCount % 25 === 0) console.log(`read ${readCount}/${oldIds.length} from eval:pn1l_eval/seed_q4corpus:semiote`);
  }
  const q4 = buildQ4Dataset({ rows: q4Rows, labelA, labelB, oldById });
  if (q4.failures.length > 0) {
    console.error(JSON.stringify({
      dataset: "supersession-q4-insample",
      full_text: q4.counts.full_text,
      failed_full_text: q4.failures.length,
      failures: q4.failures,
    }, null, 2));
    process.exitCode = 1;
  } else {
    writeDataset(q4.dataset, q4.snapshot, "supersession-q4-insample.labels.json");
    console.log(JSON.stringify({
      dataset: "supersession-q4-insample",
      ...q4.counts,
      failed_full_text: 0,
      gitleaks: "clean",
    }, null, 2));
  }

  const finals = jsonl(join(HELD_DIR, "labels.final.jsonl")) as HeldoutFinal[];
  const finalMap = new Map(finals.map((row) => [row.shadow_row_id, row]));
  const packets = (jsonl(join(HELD_DIR, "packets.jsonl")) as HeldoutPacket[]).filter((packet) =>
    finalMap.has(packet.shadow_row_id) && packet.would?.outcome === "supersede",
  );
  const evidenceRows = jsonl(join(HELD_DIR, "reconciliation-evidence.jsonl")) as Array<{
    shadow_row_id?: string;
    packet_id?: string;
    target_id?: string;
    target_sha256?: string;
  }>;
  const evidence = new Map(evidenceRows.map((row) => [
    row.shadow_row_id ?? String(row.packet_id ?? "").replace(/^shadow_packet:/u, ""),
    row,
  ]));
  const heldIds = [...new Set(packets.flatMap((packet) => [packet.applied?.result?.id, packet.would?.matched_candidate?.id]).filter((id): id is string => Boolean(id)))];
  const heldTexts = await textsFor(client, "prod:main/main:semiote", heldIds);
  const held = buildHeldoutDataset({ packets, finals: finalMap, evidence, textById: heldTexts });
  writeDataset(held.dataset, held.snapshot, "supersession-0705-heldout.labels.json");
  console.log(JSON.stringify({ dataset: "supersession-0705-heldout", ...held.counts, gitleaks: "clean" }, null, 2));
}

void main();
