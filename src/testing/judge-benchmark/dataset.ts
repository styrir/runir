import { canonicalHash, sha256Text } from "../model-benchmark/provenance.js";
import { validateLabels } from "./schema.js";
import type { CaseErrorCode, JudgeLabelsFile, LoadedPair, SnapshotLine } from "./types.js";

const UUID = /^[0-9a-f-]{36}$/;

export function parseSnapshot(text: string): Map<string, SnapshotLine> {
  const lines = new Map<string, SnapshotLine>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as SnapshotLine;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.sha256 !== "string" || typeof parsed.text !== "string") {
      throw new Error("snapshot line must be {id, sha256, text}");
    }
    const previous = lines.get(parsed.id);
    if (previous && (previous.sha256 !== parsed.sha256 || previous.text !== parsed.text)) {
      throw new Error(`snapshot id ${parsed.id} has conflicting texts`);
    }
    if (sha256Text(parsed.text) !== parsed.sha256) {
      throw new Error(`snapshot id ${parsed.id} sha256 does not match its text`);
    }
    lines.set(parsed.id, parsed);
  }
  return lines;
}

export function serializeSnapshot(lines: readonly SnapshotLine[]): string {
  const sorted = [...lines].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length === 0) return "";
  return `${sorted.map((line) => JSON.stringify({ id: line.id, sha256: line.sha256, text: line.text })).join("\n")}\n`;
}

/** Hash of id+sha256 only, so the manifest stays free of memory text. */
export function textSnapshotHash(lines: readonly SnapshotLine[]): string {
  return canonicalHash(
    [...lines]
      .map((line) => ({ id: line.id, sha256: line.sha256 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function fixtureContentHash(dataset: JudgeLabelsFile): string {
  return canonicalHash(dataset);
}

function take(snapshot: ReadonlyMap<string, SnapshotLine>, id: string, expected: string): { text: string | null; error?: CaseErrorCode } {
  const line = snapshot.get(id);
  if (!line) return { text: null, error: "missing_text" };
  if (line.sha256 !== expected) return { text: null, error: "sha256_mismatch" };
  return { text: line.text };
}

export function loadDataset(
  dataset: JudgeLabelsFile,
  snapshotText: string | null | ReadonlyMap<string, SnapshotLine>,
): LoadedPair[] {
  const snapshot = snapshotText === null
    ? new Map<string, SnapshotLine>()
    : typeof snapshotText === "string"
      ? parseSnapshot(snapshotText)
      : snapshotText;
  return dataset.pairs.map((pair) => {
    const oldHit = take(snapshot, pair.oldRef.id, pair.oldRef.sha256);
    const newHit = take(snapshot, pair.newRef.id, pair.newRef.sha256);
    const caseError = oldHit.error ?? newHit.error;
    const caseErrorRef = oldHit.error ? "old" as const : newHit.error ? "new" as const : undefined;
    return {
      pair,
      oldText: oldHit.text,
      newText: newHit.text,
      ...(caseError ? { caseError, caseErrorRef } : {}),
    };
  });
}

export type DriftRow = { id: string; expected: string; actual: string | null };

export type HydrateResult = {
  lines: SnapshotLine[];
  drift: DriftRow[];
  missing: string[];
  unhydratable: string[];
};

export function parseDbSource(source: string): { ns: string; db: string } | null {
  const match = /^(?:prod|eval):([^/]+)\/([^:]+):semiote$/u.exec(source);
  if (!match) return null;
  return { ns: match[1]!, db: match[2]! };
}

export async function hydrateLabels(args: {
  dataset: JudgeLabelsFile;
  readText: (source: string, id: string) => Promise<string | null>;
  existing?: ReadonlyMap<string, SnapshotLine>;
}): Promise<HydrateResult> {
  const expected = new Map<string, { sha256: string; source: string }>();
  for (const pair of args.dataset.pairs) {
    for (const ref of [pair.oldRef, pair.newRef]) {
      const prior = expected.get(ref.id);
      if (prior && prior.sha256 !== ref.sha256) {
        throw new Error(`ref ${ref.id} is committed under two different sha256 values`);
      }
      expected.set(ref.id, { sha256: ref.sha256, source: ref.source });
    }
  }
  const lines: SnapshotLine[] = [];
  const drift: DriftRow[] = [];
  const missing: string[] = [];
  const unhydratable: string[] = [];
  for (const [id, ref] of expected) {
    const db = parseDbSource(ref.source);
    if (!db || !UUID.test(id)) {
      const preserved = args.existing?.get(id);
      if (preserved && preserved.sha256 === ref.sha256) lines.push(preserved);
      else unhydratable.push(id);
      continue;
    }
    const text = await args.readText(ref.source, id);
    if (text === null) {
      missing.push(id);
      continue;
    }
    const actual = sha256Text(text);
    if (actual !== ref.sha256) {
      drift.push({ id, expected: ref.sha256, actual });
      continue;
    }
    lines.push({ id, sha256: actual, text });
  }
  return { lines, drift, missing, unhydratable };
}

export type SurrealLayers = { l2?: string; l0?: string };

export type SurrealTextClient = {
  read(source: string, id: string): Promise<string | null>;
  readLayers(source: string, id: string): Promise<SurrealLayers | null>;
};

export function createSurrealTextClient(opts?: {
  url?: string;
  user?: string;
  password?: string;
  fetchImpl?: typeof fetch;
}): SurrealTextClient {
  const url = opts?.url ?? process.env.BAKEOFF_SURREAL_URL ?? "http://127.0.0.1:8000/sql";
  const user = opts?.user ?? process.env.SURREAL_USER ?? "root";
  const password = opts?.password ?? process.env.SURREAL_PASS ?? "root";
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  async function readLayers(source: string, id: string): Promise<SurrealLayers | null> {
    const db = parseDbSource(source);
    if (!db) return null;
    if (!UUID.test(id)) throw new Error(`refusing non-uuid surreal id ${id}`);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: auth,
        "surreal-ns": db.ns,
        "surreal-db": db.db,
        "Content-Type": "text/plain",
      },
      body: `SELECT payload.l2 AS l2, payload.l0 AS l0 FROM semiote:⟨${id}⟩;`,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`surreal ${response.status} for ${id}`);
    const body = (await response.json()) as Array<{ status?: string; result?: Array<{ l2?: unknown; l0?: unknown }> }>;
    if (body[0]?.status !== "OK") throw new Error(`surreal query failed for ${id}`);
    const row = body[0].result?.[0];
    if (!row) return null;
    const l2 = typeof row.l2 === "string" && row.l2 ? row.l2 : undefined;
    const l0 = typeof row.l0 === "string" && row.l0 ? row.l0 : undefined;
    if (!l2 && !l0) return null;
    return { ...(l2 ? { l2 } : {}), ...(l0 ? { l0 } : {}) };
  }
  return {
    readLayers,
    async read(source: string, id: string): Promise<string | null> {
      const layers = await readLayers(source, id);
      return layers?.l2 || layers?.l0 || null;
    },
  };
}

export function parseLabelsJson(text: string): JudgeLabelsFile {
  return validateLabels(JSON.parse(text) as unknown);
}
