import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertNoSecrets, redactFactText, redactSourceTurn, redactWithMarkers, SECRET_MARKER_KINDS, type MarkerKind } from "../../src/shared/source-redaction.js";
import type { SurrealClient } from "../../src/storage/surreal/surreal-store.js";

export const TABLES = ["semiote", "noema", "memories", "rejection_log", "retrieval_trace", "session_turn_chunk", "session_turn", "source_turn_evidence"] as const;
export type PrivacyTable = typeof TABLES[number];
export type PrivacyRow = Record<string, any>;
export type FieldCount = { present: number; withText: number; wouldChange: number; assertionFailures: number; byKind: Partial<Record<MarkerKind, number>> };
export type Inventory = { version: number; namespace: string; database: string; fields: Record<string, FieldCount>; rows: Record<string, number>; hash: string };
export const FIELDS: Record<PrivacyTable, readonly string[]> = {
  semiote: ["payload.raw_source_text", "payload.rawSpan", "payload.rawSpans", "payload.l0", "payload.l1", "payload.l2", "text_norm", "embedding"],
  noema: ["canonical_text", "canonical.text", "canonical.l0", "canonical.l1", "canonical.factKey", "canonical.stableClaim.subject", "canonical.stableClaim.predicate", "canonical.stableClaim.value", "stable_claim.subject", "stable_claim.predicate", "stable_claim.value", "fact_key", "fact_key_seed", "canonical_norm", "embedding", "payload.l0", "payload.l1", "payload.l2"],
  memories: ["payload", "payload.raw_source_text", "payload.rawSpan", "payload.rawSpans", "payload.l0", "payload.l1", "payload.l2", "text_norm", "embedding"],
  rejection_log: ["candidate_text"],
  retrieval_trace: ["prompt", "answer", "prepend_context", "capture_receipt", "synthesis"],
  session_turn: ["content"],
  session_turn_chunk: ["content", "text_norm"],
  source_turn_evidence: [],
};

export function fieldValue(row: PrivacyRow, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as PrivacyRow)[key] : undefined, row);
}

export async function readPage(db: Pick<SurrealClient, "query">, table: PrivacyTable, cursor: string, limit: number): Promise<PrivacyRow[]> {
  try {
    return (await db.query<PrivacyRow>(`SELECT * FROM ${table} WHERE record::id(id) > $cursor ORDER BY id LIMIT $limit;`, { cursor, limit }))[0] ?? [];
  } catch (error) {
    if (error instanceof Error && error.message.includes(`table '${table}' does not exist`)) return [];
    throw error;
  }
}

export function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const TRACE_META = new Set(["retrievalTraceId", "sessionId", "memoryIds", "traceId", "model", "questionLength", "answerLength", "redactionVersion", "receivedAt", "client"]);
export function scrubTraceValue(value: unknown): unknown {
  if (typeof value === "string") return redactFactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(scrubTraceValue);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => TRACE_META.has(key)).map(([key, part]) => [key, part]));
}

export function scrubFieldValue(table: PrivacyTable, field: string, value: unknown): unknown {
  const policy = policyFor(table, field);
  if (policy === "remove") return undefined;
  if (policy === "trace") {
    if (field === "prompt" || field === "answer") return "";
    if (field === "prepend_context") return undefined;
    return scrubTraceValue(value);
  }
  if (policy === "derived") return value;
  if (typeof value === "string") return policy === "source" ? redactSourceTurn(value) : redactFactText(value);
  if (Array.isArray(value)) return value.map((part) => scrubFieldValue(table, field, part));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "raw_source_text")
    .map(([key, part]) => [key, scrubFieldValue(table, field, part)]));
  return value;
}

export function policyFor(table: PrivacyTable, field: string): "fact" | "source" | "remove" | "derived" | "trace" {
  if (field === "embedding" || field.endsWith(".embedding") || field.endsWith("_norm")) return "derived";
  if (field === "payload.raw_source_text") return "remove";
  if (table === "session_turn" || table === "session_turn_chunk") return "source";
  if (table === "retrieval_trace") return "trace";
  return "fact";
}

function emptyCount(): FieldCount { return { present: 0, withText: 0, wouldChange: 0, assertionFailures: 0, byKind: {} }; }

export function inspectField(table: PrivacyTable, field: string, value: unknown): FieldCount {
  const count = emptyCount();
  if (value === undefined || value === null) return count;
  count.present = 1;
  const items = strings(value);
  if (items.some(Boolean)) count.withText = 1;
  const policy = policyFor(table, field);
  if (policy === "remove") count.wouldChange = 1;
  if (policy === "derived" && field === "embedding") return count;
  for (const item of items) {
    if (!item) continue;
    const kinds = policy === "source" || policy === "remove" || (policy === "derived" && table === "session_turn_chunk") ? [...SECRET_MARKER_KINDS, "EMAIL", "PHONE", "SSN", "IP"] as MarkerKind[] : SECRET_MARKER_KINDS;
    const result = redactWithMarkers(item, { kinds });
    for (const [kind, n] of Object.entries(result.markersAssigned) as Array<[MarkerKind, number]>) {
      if (n) count.byKind[kind] = 1;
    }
    if (policy === "source" || policy === "remove" || (policy === "derived" && table === "session_turn_chunk")) {
      const homeUsers = item.match(/\/(?:Users|home)\/[^\s/]+/g)?.length ?? 0;
      const urlsChanged = item.match(/https?:\/\/[^\s)<>"']*[?#][^\s)<>"']*/g)?.length ?? 0;
      if (homeUsers) count.byKind.USER = 1;
      if (urlsChanged) count.byKind.URL = 1;
    }
    try {
      const clean = policy === "source" || (policy === "derived" && table === "session_turn_chunk") ? redactSourceTurn(item) : redactFactText(item);
      if (clean !== item) count.wouldChange = 1;
      assertNoSecrets(clean);
    } catch { count.assertionFailures = 1; }
  }
  if (policy === "trace" && JSON.stringify(scrubFieldValue(table, field, value)) !== JSON.stringify(value)) count.wouldChange = 1;
  if (table === "memories" && field === "payload" && JSON.stringify(scrubFieldValue(table, field, value)) !== JSON.stringify(value)) count.wouldChange = 1;
  return count;
}

export async function* vaultFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* vaultFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) yield path;
  }
}

export async function inventory(db: Pick<SurrealClient, "query">, identity: { namespace: string; database: string }, vaultRoot?: string,
  embed?: (text: string) => Promise<number[]>): Promise<Inventory> {
  const fields: Record<string, FieldCount> = {};
  for (const table of TABLES) for (const field of FIELDS[table]) fields[`${table}.${field}`] = emptyCount();
  fields["vault.file"] = emptyCount();
  fields["vault.filename"] = emptyCount();
  const rows: Record<string, number> = { "memories.payload.parse_failures": 0, "vault.file.parse_failures": 0 };
  const hash = createHash("sha256").update(JSON.stringify([identity.namespace, identity.database, 1]));
  for (const table of TABLES) {
    let cursor = "";
    rows[table] = 0;
    while (true) {
      const page = await readPage(db, table, cursor, 100);
      if (!page.length) break;
      for (const row of page) {
        rows[table]++;
        if (table === "memories" && typeof row.payload === "string") {
          try { JSON.parse(row.payload); }
          catch { rows["memories.payload.parse_failures"] = (rows["memories.payload.parse_failures"] ?? 0) + 1; }
        }
        cursor = String((row.id as { id?: unknown })?.id ?? row.id).replace(new RegExp(`^${table}:`), "");
        hash.update(JSON.stringify(row));
        for (const field of FIELDS[table]) {
          const key = `${table}.${field}`;
          const next = inspectField(table, field, fieldValue(row, field));
          const prior = fields[key] ?? emptyCount();
          prior.present += next.present;
          prior.withText += next.withText;
          prior.wouldChange += next.wouldChange;
          prior.assertionFailures += next.assertionFailures;
          for (const [kind, n] of Object.entries(next.byKind) as Array<[MarkerKind, number]>) prior.byKind[kind] = (prior.byKind[kind] ?? 0) + n;
          fields[key] = prior;
        }
        if (embed && (table === "semiote" || table === "memories" || table === "noema")) {
          const source = table === "noema" ? String(row.canonical_text ?? "") : String(row.payload?.l2 ?? row.payload?.data ?? "");
          const clean = redactFactText(source);
          let expected: number[] | undefined;
          try { expected = clean ? await embed(clean) : undefined; } catch { expected = undefined; }
          if (!expected?.length) expected = undefined;
          const stored = Array.isArray(row.embedding) && row.embedding.length ? row.embedding : undefined;
          if (JSON.stringify(stored) !== JSON.stringify(expected)) fields[`${table}.embedding`].wouldChange++;
        }
        const affected = table === "noema"
          ? ["canonical_text", "canonical.text", "canonical.l0", "canonical.l1", "canonical.factKey", "canonical.stableClaim.subject", "canonical.stableClaim.predicate", "canonical.stableClaim.value", "stable_claim.subject", "stable_claim.predicate", "stable_claim.value", "fact_key", "fact_key_seed"]
            .some((field) => inspectField("noema", field, fieldValue(row, field)).wouldChange > 0)
          : (table === "semiote" || table === "memories")
            && (inspectField(table, "payload.l2", row.payload?.l2 ?? row.payload?.data).wouldChange > 0
              || Boolean(row.payload?.raw_source_text));
        if (affected) for (const derived of ["text_norm", "canonical_norm", ...(embed ? [] : ["embedding"])]) {
          const key = `${table}.${derived}`;
          if (fields[key] && fieldValue(row, derived) !== undefined) fields[key].wouldChange++;
        }
      }
      if (page.length < 100) break;
    }
  }
  rows.vault_files = 0;
  if (vaultRoot) for await (const file of vaultFiles(vaultRoot)) {
    rows.vault_files++;
    const bytes = await readFile(file);
    hash.update(bytes);
    hash.update(file);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { rows["vault.file.parse_failures"] = (rows["vault.file.parse_failures"] ?? 0) + 1; continue; }
    const key = "vault.file";
    const next = inspectField("semiote", "payload.l2", content);
    const prior = fields[key] ?? emptyCount();
    prior.present += 1;
    prior.withText += next.withText;
    prior.wouldChange += next.wouldChange;
    prior.assertionFailures += next.assertionFailures;
    for (const [kind, n] of Object.entries(next.byKind) as Array<[MarkerKind, number]>) prior.byKind[kind] = (prior.byKind[kind] ?? 0) + n;
    fields[key] = prior;
    const fileName = basename(file);
    const nameKey = "vault.filename";
    const nameCount = fields[nameKey] ?? emptyCount();
    const inspectedName = inspectField("semiote", "payload.l2", fileName);
    nameCount.present++;
    nameCount.withText++;
    nameCount.wouldChange += inspectedName.wouldChange;
    nameCount.assertionFailures += inspectedName.assertionFailures;
    for (const [kind, n] of Object.entries(inspectedName.byKind) as Array<[MarkerKind, number]>) nameCount.byKind[kind] = (nameCount.byKind[kind] ?? 0) + n;
    fields[nameKey] = nameCount;
  }
  return { version: 1, ...identity, fields, rows, hash: hash.digest("hex") };
}

export function verifyInventory(result: Inventory): boolean {
  return !Object.entries(result.rows).some(([key, count]) => key.endsWith("parse_failures") && count > 0)
    && Object.entries(result.fields).every(([key, field]) => {
    if (key === "semiote.payload.raw_source_text") return field.present === 0;
    if (key === "session_turn.content") return field.withText === 0;
    return field.wouldChange === 0 && field.assertionFailures === 0;
    });
}
