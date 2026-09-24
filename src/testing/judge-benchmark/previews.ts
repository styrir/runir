import { sha256Text } from "../model-benchmark/provenance.js";
import { isRecord } from "./schema.js";
import { JUDGE_BENCHMARK_SCHEMA_VERSION } from "./types.js";

const PREVIEW_CHARS = 240;

export function parseVerifiedSnapshot(text: string): Map<string, { sha256: string; text: string }> {
  const lines = new Map<string, { sha256: string; text: string }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.text !== "string") continue;
    if (typeof parsed.sha256 !== "string" || sha256Text(parsed.text) !== parsed.sha256) continue;
    lines.set(parsed.id, { sha256: parsed.sha256, text: parsed.text });
  }
  return lines;
}

/**
 * Build pair previews only when both refs match a hash-verified snapshot line.
 * A missing snapshot yields undefined, and the adapter then keeps text off the case.
 */
export function judgeTextPreviewsForBundle(args: {
  manifest: unknown;
  rows: readonly unknown[];
  readText: (datasetId: string) => string | null;
}): Record<string, { oldPreview?: string; newPreview?: string }> | undefined {
  if (!isRecord(args.manifest) || args.manifest.schemaVersion !== JUDGE_BENCHMARK_SCHEMA_VERSION) return undefined;
  if (typeof args.manifest.datasetId !== "string") return undefined;
  const raw = args.readText(args.manifest.datasetId);
  if (raw === null) return undefined;
  let snapshot: Map<string, { sha256: string; text: string }>;
  try {
    snapshot = parseVerifiedSnapshot(raw);
  } catch {
    return undefined;
  }
  const previews: Record<string, { oldPreview?: string; newPreview?: string }> = {};
  for (const row of args.rows) {
    if (!isRecord(row) || typeof row.pairId !== "string") continue;
    const oldRef = isRecord(row.oldRef) ? row.oldRef : null;
    const newRef = isRecord(row.newRef) ? row.newRef : null;
    if (!oldRef || !newRef || typeof oldRef.id !== "string" || typeof newRef.id !== "string") continue;
    const oldLine = snapshot.get(oldRef.id);
    const newLine = snapshot.get(newRef.id);
    if (!oldLine || !newLine) continue;
    if (oldLine.sha256 !== oldRef.sha256 || newLine.sha256 !== newRef.sha256) continue;
    previews[row.pairId] = {
      oldPreview: oldLine.text.slice(0, PREVIEW_CHARS),
      newPreview: newLine.text.slice(0, PREVIEW_CHARS),
    };
  }
  return previews;
}
