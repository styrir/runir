import { sha256Text } from "../model-benchmark/provenance.js";
import {
  JUDGE_BENCHMARK_SCHEMA_VERSION,
  JUDGE_TASK_ID,
  type GoldLabel,
  type JudgeLabelsFile,
  type JudgePair,
  type SnapshotLine,
} from "./types.js";

const PROTO: Record<string, "over_supersede_fp" | "correct_would_supersede"> = {
  over_supersede: "over_supersede_fp",
  over_supersede_fp: "over_supersede_fp",
  correct_supersede: "correct_would_supersede",
  correct_would_supersede: "correct_would_supersede",
};

function displayLabel(raw: string): GoldLabel {
  if (raw === "over_supersede" || raw === "over_supersede_fp" || raw === "correct_keep_both") return "independent";
  if (raw === "correct_supersede" || raw === "correct_would_supersede") return "supersede";
  throw new Error(`unmapped legacy label ${raw}`);
}

function snapshotAdd(lines: Map<string, SnapshotLine>, id: string, text: string): string {
  const sha256 = sha256Text(text);
  const previous = lines.get(id);
  if (previous && previous.text !== text) throw new Error(`snapshot id ${id} resolved to two texts`);
  lines.set(id, { id, sha256, text });
  return sha256;
}

export type Q4ArchiveRow = {
  shadow_row_id: string;
  frame: "diverged" | "control";
  occurred_at: string;
  view: {
    incoming_text_full: string;
    would: {
      matched_candidate: {
        id: string;
        hydration?: { created_at?: string; text_trunc?: string } | null;
      };
    };
  };
};

export type Q4TextFailure = {
  pairId: string;
  refId: string;
  reason: string;
};

export function resolveOldText(
  db: { l2?: string; l0?: string } | undefined,
): { ok: true; text: string; source: "db_l2" | "db_l0" } | { ok: false; reason: string } {
  if (db?.l2) return { ok: true, text: db.l2, source: "db_l2" };
  if (db?.l0) return { ok: true, text: db.l0, source: "db_l0" };
  return { ok: false, reason: "full OLD text unavailable from pn1l_eval/seed_q4corpus" };
}

export function buildQ4Dataset(args: {
  rows: readonly Q4ArchiveRow[];
  labelA: ReadonlyMap<string, string>;
  labelB: ReadonlyMap<string, string>;
  oldById: ReadonlyMap<string, { l2?: string; l0?: string }>;
}): { dataset: JudgeLabelsFile; snapshot: SnapshotLine[]; counts: Record<string, unknown>; failures: Q4TextFailure[] } {
  const lines = new Map<string, SnapshotLine>();
  const pairs: JudgePair[] = [];
  const failures: Q4TextFailure[] = [];
  const sources: Record<string, number> = {};
  for (const row of args.rows) {
    const a = args.labelA.get(row.shadow_row_id);
    const b = args.labelB.get(row.shadow_row_id);
    if (!a || !b) throw new Error(`missing label for ${row.shadow_row_id}`);
    const refId = row.view.would.matched_candidate.id;
    const resolved = resolveOldText(args.oldById.get(refId));
    if (!resolved.ok) {
      failures.push({ pairId: row.shadow_row_id, refId, reason: resolved.reason });
      continue;
    }
    sources[resolved.source] = (sources[resolved.source] ?? 0) + 1;
    const oldSha = snapshotAdd(lines, refId, resolved.text);
    const newId = `q4-incoming:${row.shadow_row_id}`;
    const newSha = snapshotAdd(lines, newId, row.view.incoming_text_full);
    const agreed = a === b;
    const headline = agreed ? displayLabel(a) : "independent";
    const strict = agreed ? displayLabel(a) : null;
    const createdAt = row.view.would.matched_candidate.hydration?.created_at ?? row.occurred_at;
    pairs.push({
      pairId: row.shadow_row_id,
      oldRef: {
        source: "eval:pn1l_eval/seed_q4corpus:semiote",
        id: refId,
        sha256: oldSha,
        createdAt,
      },
      newRef: {
        source: "archive:q4-labeler-input",
        id: newId,
        sha256: newSha,
        createdAt: row.occurred_at,
      },
      stratum: row.frame === "control" ? "legacy-control" : "legacy-diverged",
      split: "insample",
      origin: "pn1l-u5-q4",
      population: "legacy",
      cosine: null,
      frame: row.frame,
      legacyBinaryGold: true,
      goldHeadline: headline,
      goldStrict: strict,
      gold: {
        label: headline,
        labelA: displayLabel(a),
        labelB: displayLabel(b),
        resolution: agreed ? "agreed" : "disagreement_defaulted_over",
        spotChecked: false,
        spotCheckVerdict: null,
      },
    });
  }
  const dataset: JudgeLabelsFile = {
    schemaVersion: JUDGE_BENCHMARK_SCHEMA_VERSION,
    taskId: JUDGE_TASK_ID,
    datasetId: "supersession-q4-insample",
    legacyBinaryGold: true,
    pairs,
  };
  const diverged = pairs.filter((pair) => pair.frame === "diverged");
  return {
    dataset,
    snapshot: [...lines.values()],
    counts: {
      pairs: pairs.length,
      diverged: diverged.length,
      control: pairs.length - diverged.length,
      full_text: pairs.length,
      failed_full_text: failures.length,
      headline_n: diverged.length,
      strict_n: diverged.filter((pair) => pair.goldStrict !== null).length,
      old_text_source: sources,
    },
    failures,
  };
}

export type HeldoutPacket = {
  shadow_row_id: string;
  occurred_at: string;
  applied?: { result?: { id?: string | null; hydration?: { created_at?: string } | null } | null } | null;
  would?: {
    outcome?: string;
    cosine?: number;
    matched_candidate?: { id?: string; hydration?: { created_at?: string } | null } | null;
  } | null;
};

export type HeldoutFinal = {
  shadow_row_id: string;
  label?: string | null;
  label_A?: string | null;
  label_B?: string | null;
};

export function buildHeldoutDataset(args: {
  packets: readonly HeldoutPacket[];
  finals: ReadonlyMap<string, HeldoutFinal>;
  evidence: ReadonlyMap<string, { target_id?: string; target_sha256?: string }>;
  textById: ReadonlyMap<string, string | null>;
}): { dataset: JudgeLabelsFile; snapshot: SnapshotLine[]; counts: Record<string, unknown> } {
  const lines = new Map<string, SnapshotLine>();
  const pairs: JudgePair[] = [];
  let dropped = 0;
  let shaChecked = 0;
  let shaDrift = 0;
  let considered = 0;
  for (const packet of args.packets) {
    const final = args.finals.get(packet.shadow_row_id);
    if (!final || packet.would?.outcome !== "supersede") continue;
    considered += 1;
    const goldBinary = PROTO[final.label ?? ""];
    if (!goldBinary) {
      dropped += 1;
      continue;
    }
    const newId = packet.applied?.result?.id ?? null;
    const oldId = packet.would.matched_candidate?.id ?? null;
    if (!newId || !oldId) {
      dropped += 1;
      continue;
    }
    const newText = args.textById.get(newId) ?? null;
    const oldText = args.textById.get(oldId) ?? null;
    if (!newText || !oldText) {
      dropped += 1;
      continue;
    }
    const recorded = args.evidence.get(packet.shadow_row_id);
    if (recorded?.target_sha256 && recorded.target_id === oldId) {
      shaChecked += 1;
      if (sha256Text(oldText) !== recorded.target_sha256) shaDrift += 1;
    }
    const labelA = final.label_A ?? "";
    const labelB = final.label_B ?? "";
    const agreed = PROTO[labelA] === goldBinary && PROTO[labelB] === goldBinary;
    const headline = displayLabel(goldBinary);
    const oldSha = snapshotAdd(lines, oldId, oldText);
    const newSha = snapshotAdd(lines, newId, newText);
    const cosine = typeof packet.would.cosine === "number" && Number.isFinite(packet.would.cosine)
      ? packet.would.cosine
      : null;
    pairs.push({
      pairId: packet.shadow_row_id,
      oldRef: {
        source: "prod:main/main:semiote",
        id: oldId,
        sha256: oldSha,
        createdAt: packet.would.matched_candidate?.hydration?.created_at ?? packet.occurred_at,
      },
      newRef: {
        source: "prod:main/main:semiote",
        id: newId,
        sha256: newSha,
        createdAt: packet.applied?.result?.hydration?.created_at ?? packet.occurred_at,
      },
      stratum: "legacy-heldout",
      split: "heldout",
      origin: "shadow-0705",
      population: "legacy",
      cosine,
      frame: "heldout",
      legacyBinaryGold: true,
      goldHeadline: headline,
      goldStrict: agreed ? headline : null,
      gold: {
        label: headline,
        labelA: displayLabel(labelA),
        labelB: displayLabel(labelB),
        resolution: agreed ? "agreed" : "reconciled_content_verified",
        spotChecked: false,
        spotCheckVerdict: null,
      },
    });
  }
  const dataset: JudgeLabelsFile = {
    schemaVersion: JUDGE_BENCHMARK_SCHEMA_VERSION,
    taskId: JUDGE_TASK_ID,
    datasetId: "supersession-0705-heldout",
    legacyBinaryGold: true,
    pairs,
  };
  return {
    dataset,
    snapshot: [...lines.values()],
    counts: {
      would_supersede_rows: considered,
      pairs: pairs.length,
      dropped_missing_text_or_label: dropped,
      headline_n: pairs.length,
      strict_n: pairs.filter((pair) => pair.goldStrict !== null).length,
      gold_independent: pairs.filter((pair) => pair.goldHeadline === "independent").length,
      gold_supersede: pairs.filter((pair) => pair.goldHeadline === "supersede").length,
      referent_sha_checked: shaChecked,
      referent_sha_drift: shaDrift,
    },
  };
}
