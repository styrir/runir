import { open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SurrealClient } from "../../src/storage/surreal/surreal-store.js";

type LookupTable = "semiote" | "entities" | "noema" | "project_state";
type Candidate = { file: string; id: string; table: LookupTable };
export type OwnedVault = { files: string[]; ownerFilesSkipped: number };
// Match mapExportFolder's fixed subfolders. Only projectKey/path yields a dynamic slug.
const EXPORT_SUBFOLDERS: Readonly<Record<string, ReadonlySet<string>>> = {
  "00 Inbox": new Set(["profile", "preferences", "entities", "events", "cases", "patterns", "uncategorized"]),
  "02 Areas": new Set(["profile", "cases", "events", "entity-notes", "patterns"]),
  "03 Resources": new Set(["patterns"]),
  "04 Archives": new Set(["superseded", "snapshots"]),
};

async function* regularFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) yield* regularFiles(file);
    else if (entry.isFile()) yield file;
  }
}

function exporterMeta(root: string, file: string): boolean {
  const parts = relative(root, file).split(sep);
  if (parts[0] !== "99 Meta") return false;
  if (parts.length === 2) return parts[1] === "export-manifest.json" || parts[1] === "legacy-memories-snapshot.json";
  if (parts.length !== 4 || parts[3] !== "items.json") return false;
  if (parts[1] === "01 Projects") return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parts[2]) && parts[2].length <= 60;
  return EXPORT_SUBFOLDERS[parts[1]]?.has(parts[2]) ?? false;
}

async function signature(file: string): Promise<{ id: string; table: LookupTable } | undefined> {
  if (!file.endsWith(".md")) return undefined;
  const handle = await open(file, "r");
  let prefix: string;
  try {
    const bytes = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    prefix = bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(prefix);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_]*): (.*)$/.exec(line);
    if (!pair || fields.has(pair[1])) return undefined;
    fields.set(pair[1], pair[2]);
  }
  const id = fields.get("id");
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  const has = (...keys: string[]) => keys.every((key) => fields.has(key));
  if (has("category", "tier", "tags", "confidence", "scope", "createdAt", "updatedAt", "active", "writeSource"))
    return { id, table: "semiote" };
  if (has("kind", "canonicalName", "aliases", "confidence", "scope", "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt"))
    return { id, table: "entities" };
  if (fields.get("type") === "noema" && has("supportSemioteCount", "createdAt", "updatedAt"))
    return { id, table: "noema" };
  if (fields.get("type") === "project-continuity" && has("updatedAt"))
    return { id, table: "project_state" };
  return undefined;
}

/** Classify from exporter-written paths or bounded frontmatter plus DB identity. */
export async function ownedVaultFiles(db: Pick<SurrealClient, "query">, root: string): Promise<OwnedVault> {
  const owned: string[] = [];
  const candidates: Candidate[] = [];
  let ownerFilesSkipped = 0;
  for await (const file of regularFiles(root)) {
    if (exporterMeta(root, file)) { owned.push(file); continue; }
    const found = await signature(file);
    if (found) candidates.push({ file, ...found });
    else ownerFilesSkipped++;
  }
  for (const table of ["semiote", "entities", "noema", "project_state"] as const) {
    const matches = candidates.filter((candidate) => candidate.table === table);
    for (let start = 0; start < matches.length; start += 500) {
      const batch = matches.slice(start, start + 500);
      const ids = [...new Set(batch.map(({ id }) => id))];
      const found = (await db.query<{ id: unknown }>(
        `SELECT id FROM ${table} WHERE record::id(id) IN $ids;`, { ids }))[0] ?? [];
      const existing = new Set(found.map((row) => {
        const value = row.id as { id?: unknown };
        return String(value?.id ?? row.id).replace(new RegExp(`^${table}:`), "");
      }));
      for (const candidate of batch) {
        if (existing.has(candidate.id)) owned.push(candidate.file);
        else ownerFilesSkipped++;
      }
    }
  }
  owned.sort();
  return { files: owned, ownerFilesSkipped };
}
