import { mkdir, writeFile, rm, rmdir, readFile, readdir, access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { SurrealClient, extractId } from "../../storage/surreal/surreal-store.js";
import type {
  MemoryCategory, MemoryTier, MemoryScope,
  MemoryWriteSource, EntityRecord,
} from "../../domain/memory/types.js";
import { enrichEntityAliases } from "../../entities/entity-alias-enricher.js";
import { redactWithMarkers, SECRET_MARKER_KINDS } from "../../testing/marker-redaction.js";
import { assertWithinRoot } from "./path-safety.js";

/*
Archeion v2 exporter (Rúnir-78sy.2). Reads the live memory architecture —
semiote (PRIMARY_MEMORY_TABLE) + noema + project_state + entities +
synthesis_notes — scoped to ONE tenant. The legacy `memories` table is
retired as an export source per the supersede-with-cutover decision in
docs/analysis/2026-07-03-zed01-admin-export-audit-and-prod-table-measurement.md §3.3;
it is only touched by the one-time read-only legacy snapshot below.

Output-only projection: this module writes vault files and NEVER writes back
to memory tables. Sole exception: the budget-capped alias-enrichment persist
in writeEntityFiles (see RUNIR_EXPORT_ENRICH_BUDGET).
*/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_VAULT_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_VAULT_ENTITY_MIN_CONFIDENCE = 0.7;
const DEFAULT_VAULT_ENTITY_MIN_MENTIONS = 1;
const DEFAULT_EXPORT_ENRICH_BUDGET = 25;

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getVaultConfidenceThreshold(): number {
  return readNumberEnv("VAULT_CONFIDENCE_THRESHOLD", DEFAULT_VAULT_CONFIDENCE_THRESHOLD);
}

function getVaultEntityMinConfidence(): number {
  return readNumberEnv("VAULT_ENTITY_MIN_CONFIDENCE", DEFAULT_VAULT_ENTITY_MIN_CONFIDENCE);
}

function getVaultEntityMinMentions(): number {
  return readNumberEnv("VAULT_ENTITY_MIN_MENTIONS", DEFAULT_VAULT_ENTITY_MIN_MENTIONS);
}

/** Per-run cap on paid alias-enrichment LLM calls during export.
 *  0 disables enrichment entirely; negatives clamp to 0. */
function getExportEnrichBudget(): number {
  const raw = readNumberEnv("RUNIR_EXPORT_ENRICH_BUDGET", DEFAULT_EXPORT_ENRICH_BUDGET);
  return Math.max(0, Math.floor(raw));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SurrealDB 3.x returns datetime fields as objects with a toString() method.
 *  Coerce any datetime-or-string value to a YYYY-MM-DD string safely. */
function toDateStr(value: unknown): string {
  if (!value) return "";
  return String(value).slice(0, 10);
}

export function slugify(text: string): string {
  const slug = text.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= 60) return slug;
  const cut = slug.lastIndexOf("-", 60);
  return cut > 20 ? slug.slice(0, cut) : slug.slice(0, 60);
}

function slugifyEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Bare record id: strip the table prefix AND SurrealDB's ⟨⟩ id brackets
 *  (String(RecordId) === "table:⟨uuid⟩" — brackets included). */
function bareRecordId(rawId: unknown): string {
  return extractId(rawId).replace(/^⟨|⟩$/g, "");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportedMemory = {
  id: string;
  l2: string;
  l0: string;
  l1: string;
  category: MemoryCategory;
  tier: MemoryTier;
  factKey?: string;
  tags: string[];
  scope: MemoryScope;
  sessionId?: string;
  userId: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  active?: boolean;
  inactiveAt?: string;
  inactiveReason?: string;
  supersededById?: string;
  supersedesId?: string;
  lineageRootId?: string;
  supersedeProvenance?: string;
  memoryRole?: string;
  path?: string;
  projectKey?: string;
  sourceClient?: string;
  validAt?: string;
  invalidAt?: string;
  source: string;
  writeSource: MemoryWriteSource;
  accessCount?: number;
  lastAccessedAt?: string;
};

export type ExportOptions = {
  /** Tenant every table read is scoped to. Resolved by the caller
   *  (query param userId, else the configured default tenant). */
  userId: string;
};

export type SourceCounts = {
  semiote_active: number;
  semiote_archived: number;
  entities: number;
  synthesis_notes: number;
  noema: number;
  project_state: number;
};

export type ExportResult = {
  ok: boolean;
  exportedAt: string;
  userId: string;
  memoriesExported: number;
  entitiesExported: number;
  continuityStatesExported: number;
  noemasExported: number;
  foldersWritten: number;
  vaultPath: string;
  runDurationMs: number;
  validationWarnings: string[];
  validationWarningsCount: number;
  synthesisNotesExported?: number;
  /** Rows read per source table this run (Rúnir-archeion-v2.3 manifest gap). */
  sourceCounts: SourceCounts;
  /** Max semiote created_at/updated_at ISO timestamp seen this run. */
  cursor: string | null;
  legacySnapshotWritten: boolean;
  staleFilesRemoved: number;
};

export type ProjectStateExport = {
  id: string;
  projectKey?: string;
  path?: string;
  currentFocus?: string;
  latestProgress?: string;
  blockers: string[];
  nextSteps: string[];
  activeTicketIds: string[];
  sourceSessionId?: string;
  updatedAt?: string;
  version?: number;
  confidence?: number;
};

export type NoemaExport = {
  id: string;
  canonicalText: string;
  factKey?: string;
  claimKey?: string;
  status?: string;
  stability?: number;
  authority?: number;
  evidenceCount?: number;
  supportSemioteIds: string[];
  createdAt?: string;
  updatedAt?: string;
};

// ---------------------------------------------------------------------------
// Synthesis note type (local, matches synthesis_notes table)
// ---------------------------------------------------------------------------

export type SynthesisNoteExport = {
  id: string;
  l0: string;
  l1: string;
  l2: string;
  clusterId: string;
  memoryIds: string[];
  entityIds: string[];
  entityNames?: string[];
  tags: string[];
  para_placement: string;
  lastMemoryCount: number;
  updateCount: number;
  createdAt?: string;
  updatedAt?: string;
};

// ---------------------------------------------------------------------------
// Redaction-before-disk (§9.2) + recording writer + stage logging
// ---------------------------------------------------------------------------

/** §9.2 privacy gate: strip secret-shaped strings (bearer tokens, API keys,
 *  password assignments) before any exported content reaches disk. Reuses the
 *  repo's marker-redaction machinery restricted to secret kinds — a personal
 *  vault legitimately contains paths/URLs/emails, so PII kinds stay untouched. */
export function redactExportText(text: string): string {
  return redactWithMarkers(text, { kinds: SECRET_MARKER_KINDS }).text;
}

/** Deterministic bad-data rejection (path traversal in DB-controlled path
 *  segments). Distinguished from transient IO failures so callers can skip
 *  the offending row without disabling the end-of-run stale sweep. */
export class VaultPathEscapeError extends Error {}

/**
 * Single choke point for every file the export produces.
 * - Applies redactExportText to all content (no per-callsite bypass possible).
 * - Records produced relative paths so stale managed files can be removed at
 *   the END of the run (diff-based, interrupt-safe: no blind pre-clean).
 */
export class VaultWriter {
  readonly produced = new Set<string>();

  constructor(private readonly vaultPath: string) {}

  async write(relPath: string, content: string): Promise<void> {
    // Containment gate (Codex CONFIRMED finding): DB-controlled path segments
    // (e.g. synthesis para_placement) must never escape the vault. Shared,
    // tested guard (path-safety.ts) — same logic the report writer uses.
    const fullPath = assertWithinRoot(
      this.vaultPath,
      relPath,
      () => new VaultPathEscapeError(`[vault-exporter] refusing write outside vault root: ${relPath}`),
    );
    const rel = relative(resolve(this.vaultPath), resolve(fullPath));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, redactExportText(content), "utf-8");
    this.produced.add(rel);
  }
}

/** One progress line per stage to stderr with per-stage timing (mandated
 *  after a live export stall left no signal about which stage was stuck). */
function logStage(stage: string, stageStartMs: number, extra?: Record<string, unknown>): void {
  const kv = extra
    ? " " + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")
    : "";
  process.stderr.write(`[vault-exporter] stage=${stage} ms=${Date.now() - stageStartMs}${kv}\n`);
}

/** Fixed cadence (no env knob — Rúnir-78sy.6 C2): at prod scale yields ~22
 *  lines for the notes stage and ~18 for the entities stage, comfortably
 *  under a ~40-line/stage sanity ceiling (F20). */
const EXPORT_PROGRESS_EVERY = 250;

/** Per-N progress line for the two loops that matter at prod scale (notes,
 *  entities — F7/F20). Emits on every Nth item AND on the final item so a
 *  stage always ends with a line showing done === total. */
function logProgress(stage: string, done: number, total: number): void {
  if (done % EXPORT_PROGRESS_EVERY === 0 || done === total) {
    process.stderr.write(`[vault-exporter] stage=${stage} progress=${done}/${total}\n`);
  }
}

// ---------------------------------------------------------------------------
// Project folder discriminator — project_key / path (the old `project-` tag
// heuristic matched 21/4,854 prod rows and is retired; audit §1.4 item 5)
// ---------------------------------------------------------------------------

function getProjectFolderSlug(m: ExportedMemory): string | null {
  if (m.projectKey?.trim()) {
    const slug = slugify(m.projectKey);
    if (slug) return slug;
  }
  if (m.path?.trim()) {
    const base = basename(m.path.replace(/\/+$/, ""));
    const slug = slugify(base);
    if (slug) return slug;
  }
  return null;
}

export function deriveTitle(m: ExportedMemory): string {
  if (m.l0?.trim()) return m.l0.trim();
  if (m.l2?.trim()) {
    const first = m.l2.split(/[.\n]/)[0].trim();
    if (first.length > 4) {
      if (first.length <= 120) return first;
      const truncated = first.slice(0, 120);
      const lastSpace = truncated.lastIndexOf(' ');
      return lastSpace > 60 ? truncated.slice(0, lastSpace) + '...' : truncated + '...';
    }
  }
  return m.id.slice(0, 8);
}

export function deriveFilename(m: ExportedMemory): string {
  const title = deriveTitle(m);
  const slug = slugify(title);
  return slug ? `${slug}-${m.id.slice(0, 8)}.md` : `${m.id}.md`;
}

// ---------------------------------------------------------------------------
// PARA mapper — 12-rule decision tree
// ---------------------------------------------------------------------------

function mapMemoryToFolder(m: ExportedMemory): string | null {
  // Rule 1
  if (m.active === false || m.supersededById !== undefined) return "04 Archives/superseded/";
  // Rule 2
  if (m.scope === "session" && m.tier === "ephemeral") return "04 Archives/snapshots/";
  // Rule 3
  if (m.scope === "session" && (m.active === true || m.active === undefined)) return null;
  // Rule 4
  if (m.tier === "durable" && (m.category === "profile" || m.category === "preferences")) return "02 Areas/profile/";
  // Rule 5
  if (m.tier === "durable" && m.category === "patterns") return "03 Resources/patterns/";
  // Rules 6+7: project routing keyed on project_key/path (semiote's live
  // project discriminators), replacing the dead `project-` tag heuristic.
  {
    const projectSlug = getProjectFolderSlug(m);
    if (projectSlug) return `01 Projects/${projectSlug}/`;
  }
  // Rule 8
  if (m.tier === "working" && m.category === "cases") return "02 Areas/cases/";
  // Rule 9
  if (m.tier === "working" && m.category === "events") return "02 Areas/events/";
  // Rule 10
  if (m.tier === "working" && m.category === "entities") return "02 Areas/entity-notes/";
  // Rule 11
  if (m.tier === "ephemeral") return "04 Archives/snapshots/";
  // Rule 12
  return "02 Areas/patterns/";
}

function mapInboxFolder(m: ExportedMemory): string {
  return `00 Inbox/${String(m.category ?? "uncategorized")}/`;
}

function mapExportFolder(
  m: ExportedMemory,
  confidenceThreshold: number,
): string | null {
  const folder = mapMemoryToFolder(m);
  if (folder === null) return null;
  if (
    confidenceThreshold > 0 &&
    folder.startsWith("02 Areas/") &&
    m.confidence < confidenceThreshold
  ) {
    return mapInboxFolder(m);
  }
  return folder;
}

// ---------------------------------------------------------------------------
// Partition
// ---------------------------------------------------------------------------

function partitionMemories(
  memories: ExportedMemory[],
  confidenceThreshold: number,
): {
  sessionMemories: ExportedMemory[];
  folderMemories: ExportedMemory[];
} {
  const sessionMemories: ExportedMemory[] = [];
  const folderMemories: ExportedMemory[] = [];
  for (const m of memories) {
    const folder = mapExportFolder(m, confidenceThreshold);
    if (folder === null) {
      sessionMemories.push(m);
    } else {
      folderMemories.push(m);
    }
  }
  return { sessionMemories, folderMemories };
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

export function mapRow(row: any): ExportedMemory | null {
  const rawId = row?.id;
  const rawIdText = typeof rawId === "object" && rawId !== null && "id" in rawId
    ? String((rawId as { id: unknown }).id)
    : String(rawId ?? "");
  const id = extractId(rawId);
  if (rawIdText.includes(":") || !UUID_RE.test(id)) {
    console.warn(`[vault-exporter] skipping record with non-UUID id: ${rawIdText || id}`);
    return null;
  }

  // Semiote rows are top-level snake_case (verified against the store write
  // path in surreal-store.ts / phase2-store.ts schema: created_at, updated_at,
  // user_id, session_id, superseded_by, supersedes, lineage_root_id, …).
  // Content fields (l0/l1/l2, category, tier, tags, …) live in the camelCase
  // `payload` mirror. Prefer the top-level snake fields; fall back to payload
  // for legacy-shaped rows. `payload.raw_source_text` is deliberately NEVER
  // mapped (§9.2 — verbatim session text must not reach the vault).
  const payload = row.payload ?? {};
  return {
    id,
    l2: payload.l2 ?? row.l2 ?? "",
    l0: payload.l0 ?? row.l0 ?? "",
    l1: payload.l1 ?? row.l1 ?? "",
    category: payload.category ?? row.category ?? "cases",
    tier: payload.tier ?? row.tier ?? "working",
    factKey: payload.factKey ?? row.factKey,
    tags: payload.tags ?? row.tags ?? [],
    scope: row.scope ?? payload.scope ?? "user",
    sessionId: row.session_id ?? payload.sessionId,
    userId: row.user_id ?? payload.userId ?? "default",
    confidence: row.confidence ?? payload.confidence ?? 0,
    createdAt: toDateStr(row.created_at ?? payload.createdAt),
    updatedAt: String(row.updated_at ?? payload.updatedAt ?? ""),
    active: row.active ?? payload.active,
    inactiveAt: row.inactive_at ? String(row.inactive_at) : payload.inactiveAt,
    inactiveReason: row.inactive_reason ?? payload.inactiveReason,
    supersededById: row.superseded_by ? bareRecordId(row.superseded_by) : payload.supersededById,
    supersedesId: row.supersedes ? bareRecordId(row.supersedes) : payload.supersedesId,
    lineageRootId: row.lineage_root_id ? bareRecordId(row.lineage_root_id) : payload.lineageRootId,
    supersedeProvenance: row.supersede_provenance ?? payload.supersedeProvenance ?? payload.supersede_provenance,
    memoryRole: row.memory_role ?? payload.memoryRole,
    path: row.path ?? payload.path,
    projectKey: row.project_key ?? payload.projectKey,
    sourceClient: row.source_client ?? payload.client,
    validAt: row.valid_at ? String(row.valid_at) : payload.validAt,
    invalidAt: row.invalid_at ? String(row.invalid_at) : payload.invalidAt,
    source: payload.source ?? row.source ?? "memory-hybrid",
    writeSource: payload.writeSource ?? row.writeSource ?? "capture",
    accessCount: payload.accessCount ?? row.accessCount,
    lastAccessedAt: payload.lastAccessedAt ?? row.lastAccessedAt,
  };
}

/** Raw semiote rows for one tenant. `created_at` is the real top-level sort
 *  key (the legacy `ORDER BY createdAt` resolved to NONE on every live row). */
async function fetchSemioteRows(
  db: SurrealClient,
  userId: string,
  activeClause: "(active = NONE OR active = true)" | "active = false",
): Promise<any[]> {
  const results = await db.query<any>(
    `SELECT * FROM semiote WHERE user_id = $userId AND ${activeClause} ORDER BY created_at DESC`,
    { userId },
  );
  return results[0] ?? [];
}

/** Max created_at/updated_at ISO timestamp across raw semiote rows (manifest cursor). */
function computeCursor(rawRows: any[]): string | null {
  let cursor: string | null = null;
  for (const row of rawRows) {
    for (const value of [row?.updated_at, row?.created_at]) {
      if (!value) continue;
      const iso = String(value);
      if (cursor === null || iso > cursor) cursor = iso;
    }
  }
  return cursor;
}

function mapRows(rows: any[]): ExportedMemory[] {
  return rows.map(mapRow).filter((row): row is ExportedMemory => row !== null);
}

async function fetchAllEntities(db: SurrealClient, userId: string): Promise<EntityRecord[]> {
  // entities is camelCase top-level (userId), unlike semiote/project_state.
  const results = await db.query<EntityRecord>(
    `SELECT * FROM entities WHERE userId = $userId ORDER BY kind, canonicalName`,
    { userId },
  );
  return results[0] ?? [];
}

export async function fetchProjectStates(db: SurrealClient, userId: string): Promise<ProjectStateExport[]> {
  const results = await db.query<any>(
    `SELECT * FROM project_state WHERE user_id = $userId ORDER BY updated_at DESC`,
    { userId },
  );
  return (results[0] ?? []).map((row: any): ProjectStateExport => ({
    id: extractId(row?.id),
    projectKey: row?.project_key ?? undefined,
    path: row?.path ?? undefined,
    currentFocus: row?.current_focus ?? undefined,
    latestProgress: row?.latest_progress ?? undefined,
    blockers: Array.isArray(row?.blockers) ? row.blockers.map(String) : [],
    nextSteps: Array.isArray(row?.next_steps) ? row.next_steps.map(String) : [],
    activeTicketIds: Array.isArray(row?.active_ticket_ids) ? row.active_ticket_ids.map(String) : [],
    sourceSessionId: row?.source_session_id ?? undefined,
    updatedAt: row?.updated_at ? String(row.updated_at) : undefined,
    version: typeof row?.version === "number" ? row.version : undefined,
    confidence: typeof row?.confidence === "number" ? row.confidence : undefined,
  }));
}

export async function fetchNoemas(db: SurrealClient, userId: string): Promise<NoemaExport[]> {
  const results = await db.query<any>(
    `SELECT * FROM noema WHERE user_id = $userId AND active = true ORDER BY updated_at DESC`,
    { userId },
  );
  return (results[0] ?? []).map((row: any): NoemaExport => ({
    id: extractId(row?.id),
    canonicalText: row?.canonical_text ?? "",
    factKey: row?.fact_key ?? undefined,
    claimKey: row?.claim_key ?? undefined,
    status: row?.status ?? undefined,
    stability: typeof row?.stability === "number" ? row.stability : undefined,
    authority: typeof row?.authority === "number" ? row.authority : undefined,
    evidenceCount: typeof row?.evidence_count === "number" ? row.evidence_count : undefined,
    supportSemioteIds: Array.isArray(row?.support_semiote_ids) ? row.support_semiote_ids.map(String) : [],
    createdAt: row?.created_at ? String(row.created_at) : undefined,
    updatedAt: row?.updated_at ? String(row.updated_at) : undefined,
  }));
}

/** One aggregation query for the whole export, replacing 4,347 sequential
 *  per-entity point-miss queries (entity_edges has no index on `in` alone —
 *  F2). Global (no tenant column on entity_edges — F1); safe because only
 *  tenant entity ids are ever looked up in the returned map. Keys are
 *  extractId-normalized so both plain-string and RecordId-shaped `in` values
 *  (CBOR/WebSocket driver vs. HTTP/JSON — F9) resolve to the same bare id.
 *  Exported for the live-DB repro test (vault-exporter-mention-counts-repro.test.ts). */
export async function fetchMentionCounts(db: SurrealClient): Promise<Map<string, number>> {
  const results = await db.query<{ in: unknown; count: number }>(
    `SELECT in, count() AS count FROM entity_edges WHERE kind = "mentioned_in" GROUP BY in`,
  );
  const counts = new Map<string, number>();
  for (const row of results[0] ?? []) {
    counts.set(extractId(row.in), row.count);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupByFolder(
  memories: ExportedMemory[],
  confidenceThreshold: number,
): Map<string, ExportedMemory[]> {
  const byFolder = new Map<string, ExportedMemory[]>();
  for (const m of memories) {
    const folder = mapExportFolder(m, confidenceThreshold);
    if (folder === null) continue;
    const existing = byFolder.get(folder) ?? [];
    existing.push(m);
    byFolder.set(folder, existing);
  }
  return byFolder;
}

function groupByDate(memories: ExportedMemory[]): Map<string, ExportedMemory[]> {
  const byDate = new Map<string, ExportedMemory[]>();
  for (const m of memories) {
    // toDateStr() in mapRow already coerces to YYYY-MM-DD; guard against empty strings
    const date = toDateStr(m.createdAt);
    if (!date || date.length < 10 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const existing = byDate.get(date) ?? [];
    existing.push(m);
    byDate.set(date, existing);
  }
  return byDate;
}

// ---------------------------------------------------------------------------
// File writing — folder pipeline
// ---------------------------------------------------------------------------

/** Mutable cross-folder counter (Rúnir-78sy.6 C2): the progress denominator is
 *  ALL folderMemories for the run, not just the current folder's slice, so
 *  `progress` is shared by reference across every writeFolderContents call. */
type NotesProgress = { done: number; total: number };

async function writeFolderContents(
  writer: VaultWriter,
  folder: string,
  memories: ExportedMemory[],
  progress: NotesProgress,
): Promise<void> {
  await writer.write(join("99 Meta", folder, "items.json"), JSON.stringify(memories, null, 2));

  for (const m of memories) {
    const frontmatter = [
      "---",
      `id: ${m.id}`,
      `category: ${m.category}`,
      `tier: ${m.tier}`,
      `tags: [${m.tags.join(", ")}]`,
      `confidence: ${m.confidence}`,
      `scope: ${m.scope}`,
      `createdAt: ${m.createdAt}`,
      `updatedAt: ${m.updatedAt}`,
      `active: ${m.active ?? true}`,
      `writeSource: ${m.writeSource}`,
      ...(m.memoryRole ? [`memoryRole: ${m.memoryRole}`] : []),
      ...(m.projectKey ? [`projectKey: ${m.projectKey}`] : []),
      ...(m.path ? [`path: ${m.path}`] : []),
      ...(m.sourceClient ? [`sourceClient: ${m.sourceClient}`] : []),
      ...(m.validAt ? [`validAt: ${m.validAt}`] : []),
      ...(m.invalidAt ? [`invalidAt: ${m.invalidAt}`] : []),
      ...(m.inactiveReason ? [`inactiveReason: ${m.inactiveReason}`] : []),
      ...(m.supersededById ? [`supersededById: ${m.supersededById}`] : []),
      ...(m.supersedesId ? [`supersedesId: ${m.supersedesId}`] : []),
      ...(m.supersedeProvenance ? [`supersedeProvenance: ${m.supersedeProvenance}`] : []),
      "---",
    ].join("\n");

    const body = [
      `# ${deriveTitle(m)}`,
      "",
      ...(m.l1?.trim() ? ["## Overview", m.l1, ""] : []),
      "## Detail",
      m.l2,
    ].join("\n");

    const content = frontmatter + "\n" + body + "\n";
    await writer.write(join(folder, deriveFilename(m)), content);
    progress.done += 1;
    logProgress("notes", progress.done, progress.total);
  }
}

// ---------------------------------------------------------------------------
// summary.md
// ---------------------------------------------------------------------------

async function writeSummary(
  writer: VaultWriter,
  folder: string,
  folderName: string,
  memories: ExportedMemory[],
  exportedAt: string,
): Promise<void> {
  const totalCount = memories.length;
  const uniqueCategories = [...new Set(memories.map(m => m.category))].join(", ");

  const tagCounts = new Map<string, number>();
  for (const m of memories) {
    for (const t of m.tags) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  const top10Tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t]) => t)
    .join(", ");

  const sorted = [...memories].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last5 = sorted.slice(0, 5).map(m =>
    `- ${deriveTitle(m)} (tier: ${m.tier}, confidence: ${m.confidence}, date: ${m.createdAt})`
  ).join("\n");

  const catCounts = new Map<string, number>();
  for (const m of memories) {
    catCounts.set(m.category, (catCounts.get(m.category) ?? 0) + 1);
  }
  const categoryBreakdown = [...catCounts.entries()]
    .map(([cat, count]) => `- ${cat}: ${count} memories`)
    .join("\n");

  const content = `# ${folderName}

**Last exported:** ${exportedAt}
**Total memories:** ${totalCount}
**Categories:** ${uniqueCategories}
**Top tags:** ${top10Tags}

## Recent Memories

${last5}

## Coverage

${categoryBreakdown}
`;

  await writer.write(join(folder, "summary.md"), content);
}

// ---------------------------------------------------------------------------
// Daily notes pipeline
// ---------------------------------------------------------------------------

async function writeDailyNotes(
  writer: VaultWriter,
  allMemories: ExportedMemory[],
): Promise<number> {
  const byDate = groupByDate(allMemories);
  for (const [date, mems] of byDate) {
    const year = date.slice(0, 4);
    await writeDailyNote(writer, join("05 Daily Notes", year, `${date}.md`), date, mems);
  }
  return byDate.size;
}

async function writeDailyNote(
  writer: VaultWriter,
  relPath: string,
  date: string,
  memories: ExportedMemory[],
): Promise<void> {
  const lines: string[] = [
    `# ${date}`,
    "",
    `**Memories captured:** ${memories.length}`,
    "",
    "## Session Notes",
    "",
  ];

  const withSession: ExportedMemory[] = [];
  const withoutSession: ExportedMemory[] = [];
  for (const m of memories) {
    if (m.sessionId) {
      withSession.push(m);
    } else {
      withoutSession.push(m);
    }
  }

  // Standalone captures (no sessionId)
  if (withoutSession.length > 0) {
    lines.push("### Standalone Captures");
    lines.push("");
  }
  const sortedNoSession = [...withoutSession].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const m of sortedNoSession) {
    lines.push(`- **${deriveTitle(m)}** — \`${m.category}\` / \`${m.tier}\` / confidence ${m.confidence}`);
    if (m.tags.length > 0) {
      lines.push(`  Tags: ${m.tags.join(", ")}`);
    }
    if (m.l2.trim()) {
      lines.push(`  ${m.l2.trim()}`);
    }
    lines.push("");
  }

  // Session-grouped memories — use sliced sessionId (8 chars) as heading
  const sessionGroups = new Map<string, ExportedMemory[]>();
  for (const m of withSession) {
    const existing = sessionGroups.get(m.sessionId!) ?? [];
    existing.push(m);
    sessionGroups.set(m.sessionId!, existing);
  }

  for (const [sessionId, mems] of sessionGroups) {
    lines.push(`### Session: ${sessionId.slice(0, 8)}`);
    lines.push("");
    const sortedMems = [...mems].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const m of sortedMems) {
      lines.push(`- **${deriveTitle(m)}** — \`${m.category}\` / \`${m.tier}\` / confidence ${m.confidence}`);
      if (m.tags.length > 0) {
        lines.push(`  Tags: ${m.tags.join(", ")}`);
      }
      if (m.l2.trim()) {
        lines.push(`  ${m.l2.trim()}`);
      }
      lines.push("");
    }
  }

  await writer.write(relPath, lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Entity files
// ---------------------------------------------------------------------------

async function writeEntityFiles(
  writer: VaultWriter,
  entities: EntityRecord[],
  db: SurrealClient,
  mentionCounts: Map<string, number>,
): Promise<number> {
  const minConfidence = getVaultEntityMinConfidence();
  const minMentions = getVaultEntityMinMentions();
  const openRouterApiKey = process.env.OPENROUTER_API_KEY ?? "";
  // Per-run paid-call budget (RUNIR_EXPORT_ENRICH_BUDGET, 0 = enrichment off):
  // before the aliases_enriched_at schema fix, NOTHING persisted and every
  // export re-attempted every alias-less entity (~4,380 in prod) — this cap
  // bounds the paid damage of any future persist regression.
  const enrichBudget = getExportEnrichBudget();
  let enrichAttempted = 0;
  let enrichSucceeded = 0;
  let enrichSkipped = 0;
  // Per-run attempted marker: an entity whose enrichment already failed this
  // run is never retried within the run (failures count against the budget).
  const enrichTried = new Set<string>();
  let written = 0;

  for (const [index, entity] of entities.entries()) {
    const entityId = entity.id ?? "";
    // Normalized once per entity: must match fetchMentionCounts' extractId map keys.
    const bareEntityId = extractId(entityId);
    const mentionCount = mentionCounts.get(bareEntityId) ?? 0;

    // Enrich aliases via LLM if not already populated, never attempted before
    // (aliases_enriched_at unset), API key available, and budget allows.
    const needsEnrichment =
      (!entity.aliases || entity.aliases.length === 0) && !entity.aliases_enriched_at;
    if (openRouterApiKey && enrichBudget > 0 && needsEnrichment) {
      if (enrichAttempted >= enrichBudget || enrichTried.has(String(entityId))) {
        enrichSkipped++;
      } else {
        enrichTried.add(String(entityId));
        enrichAttempted++;
        try {
          await enrichEntityAliases(db, entity, openRouterApiKey);
          enrichSucceeded++;
          // Reload aliases from DB after enrichment
          const refreshed = await db.query<any>(
            `SELECT aliases FROM type::record($id)`,
            { id: entityId },
          );
          const row = (refreshed[0] ?? [])[0];
          if (row && Array.isArray(row.aliases)) {
            entity.aliases = row.aliases as string[];
          }
        } catch (err) {
          process.stderr.write(`[vault-exporter] alias enrichment failed for ${entity.canonicalName}: ${err}\n`);
        }
      }
    }
    // Tick per whole-entity iteration (before the filter-gate's `continue`) so
    // budget-capped enrichment round-trips still show in wall-clock progress
    // even for entities that end up filtered out below (F17).
    logProgress("entities", index + 1, entities.length);
    if (
      entity.confidence < minConfidence &&
      entity.scope === "session" &&
      mentionCount <= minMentions
    ) {
      continue;
    }

    const slug = slugifyEntityName(entity.canonicalName);
    const relPath = join("06 Entities", entity.kind, slug + ".md");

    const fm: string[] = ["---"];
    const bareId = bareEntityId.replace(/^⟨|⟩$/g, "");
    fm.push(`id: ${bareId}`);
    fm.push(`kind: ${entity.kind}`);
    fm.push(`canonicalName: ${entity.canonicalName}`);
    fm.push(`aliases: [${(entity.aliases ?? []).join(", ")}]`);
    fm.push(`confidence: ${entity.confidence}`);
    fm.push(`scope: ${entity.scope}`);
    fm.push(`firstSeenAt: ${toDateStr(entity.firstSeenAt)}`);
    fm.push(`lastSeenAt: ${toDateStr(entity.lastSeenAt)}`);
    fm.push(`createdAt: ${toDateStr(entity.createdAt)}`);
    fm.push(`updatedAt: ${entity.updatedAt}`);
    if (entity.handles) fm.push(`handles: [${entity.handles.join(", ")}]`);
    if (entity.titles) fm.push(`titles: [${entity.titles.join(", ")}]`);
    if (entity.subtype) fm.push(`subtype: ${entity.subtype}`);
    if (entity.orgType) fm.push(`orgType: ${entity.orgType}`);
    if (entity.locationType) fm.push(`locationType: ${entity.locationType}`);
    if (entity.eventType) fm.push(`eventType: ${entity.eventType}`);
    if (entity.startAt) fm.push(`startAt: ${entity.startAt}`);
    if (entity.endAt) fm.push(`endAt: ${entity.endAt}`);
    fm.push("---");

    const body: string[] = [
      `# ${entity.canonicalName}`,
      "",
      `**Kind:** ${entity.kind}`,
      `**Aliases:** ${(entity.aliases ?? []).join(", ")}`,
      `**Confidence:** ${entity.confidence}`,
      "",
    ];

    if (entity.description) {
      body.push(entity.description);
      body.push("");
    }

    body.push("---");
    body.push("");
    body.push(`*Mentioned in ${mentionCount === 1 ? "1 memory" : `${mentionCount} memories`}.*`);
    body.push(`*First seen: ${toDateStr(entity.firstSeenAt)} | Last seen: ${toDateStr(entity.lastSeenAt)}*`);

    const content = fm.join("\n") + "\n" + body.join("\n") + "\n";
    await writer.write(relPath, content);
    written += 1;
  }

  if (openRouterApiKey && enrichBudget > 0 && enrichAttempted + enrichSkipped > 0) {
    process.stderr.write(
      `[vault-exporter] alias enrichment: attempted=${enrichAttempted} succeeded=${enrichSucceeded} skipped=${enrichSkipped} (budget=${enrichBudget})\n`,
    );
  }

  return written;
}

// ---------------------------------------------------------------------------
// Synthesis notes — fetch and write
// ---------------------------------------------------------------------------

export async function fetchSynthesisNotes(db: SurrealClient): Promise<SynthesisNoteExport[]> {
  const results = await db.query<any>(
    `SELECT * FROM synthesis_notes ORDER BY para_placement, l0`,
  );
  const rows = results[0] ?? [];
  return rows.map((row: any) => ({
    id: typeof row.id === "object" && row.id !== null
      ? String((row.id as any).id ?? row.id)
      : String(row.id ?? ""),
    l0: row.l0 ?? "",
    l1: row.l1 ?? "",
    l2: row.l2 ?? "",
    clusterId: typeof row.clusterId === "object" && row.clusterId !== null
      ? String((row.clusterId as any).id ?? row.clusterId)
      : String(row.clusterId ?? ""),
    memoryIds: (row.memoryIds ?? []).map((id: any) =>
      typeof id === "object" && id !== null ? String((id as any).id ?? id) : String(id)
    ),
    entityIds: (row.entityIds ?? []).map((id: any) =>
      typeof id === "object" && id !== null ? String((id as any).id ?? id) : String(id)
    ),
    entityNames: row.entityNames ?? [],
    tags: row.tags ?? [],
    para_placement: row.para_placement ?? "02 Areas",
    lastMemoryCount: row.lastMemoryCount ?? 0,
    updateCount: row.updateCount ?? 0,
    createdAt: row.createdAt ? String(row.createdAt) : undefined,
    updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
  }));
}

/**
 * Strip ## heading lines from l1 text, keeping body content.
 * The LLM generates l1 with ## Context / ## Key Points / ## Status headings;
 * these must be removed before wrapping under ## Summary to avoid duplicates.
 */
export function stripL1Headings(l1: string): string {
  return l1
    .replace(/^##\s+\w[^\n]*\n?/gm, "")  // remove any ## heading lines
    .replace(/\n{3,}/g, "\n\n")           // collapse 3+ newlines to 2
    .trim();
}

export async function writeSynthesisFile(
  writer: VaultWriter,
  synthesis: SynthesisNoteExport,
): Promise<void> {
  // para_placement like "01 Projects" -> subfolder "synthesis"
  const synthId = synthesis.id ?? "";
  const datePart = synthesis.createdAt ? String(synthesis.createdAt).slice(0, 10) : synthId.slice(0, 8);
  const filename = `${slugify(synthesis.l0)}-${datePart}.md`;

  const frontmatter = [
    "---",
    `type: synthesis`,
    `clusterId: ${synthesis.clusterId}`,
    `memoryCount: ${synthesis.memoryIds.length}`,
    `tags: [${synthesis.tags.join(", ")}]`,
    `para_placement: ${synthesis.para_placement}`,
    `updateCount: ${synthesis.updateCount}`,
    `createdAt: ${synthesis.createdAt ?? ""}`,
    `updatedAt: ${synthesis.updatedAt ?? ""}`,
    "---",
  ].join("\n");

  // Code-pfa7/Code-mlij: Strip l1 headings before wrapping under ## Summary
  const l1Block = synthesis.l1?.trim()
    ? `## Summary\n\n${stripL1Headings(synthesis.l1)}`
    : "";

  // Code-b2b2: Use stored entityNames (canonical names) for wikilink matching
  const entityNames = synthesis.entityNames ?? [];
  let l2Body = synthesis.l2 ?? "";
  if (entityNames.length > 0) {
    const relatedMatch = l2Body.match(/^(## Related\s*\n)([\s\S]*)$/m);
    if (relatedMatch) {
      let relatedSection = relatedMatch[2];
      for (const name of entityNames) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        relatedSection = relatedSection.replace(
          new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?!\\]\\])`, "g"),
          `[[${name}]]`,
        );
      }
      l2Body = l2Body.slice(0, relatedMatch.index) + relatedMatch[1] + relatedSection;
    }
  }

  const body = [
    `# ${synthesis.l0}`,
    "",
    l1Block,
    "",
    "---",
    "",
    l2Body,
    "",
    "---",
    `*Synthesized from ${synthesis.memoryIds.length} memories. Last updated: ${synthesis.updatedAt ?? ""}*`,
  ].join("\n");

  const content = frontmatter + "\n" + body + "\n";
  await writer.write(join(synthesis.para_placement, "synthesis", filename), content);
}

// ---------------------------------------------------------------------------
// Continuity (project_state → 07 Continuity/projects/)
// ---------------------------------------------------------------------------

function projectStateSlug(state: ProjectStateExport, used: Set<string>): string {
  const base =
    (state.projectKey?.trim() && slugify(state.projectKey)) ||
    (state.path?.trim() && slugify(basename(state.path.replace(/\/+$/, "")))) ||
    slugify(state.id).slice(0, 16) ||
    "project";
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

async function writeContinuityFiles(
  writer: VaultWriter,
  states: ProjectStateExport[],
): Promise<number> {
  const usedSlugs = new Set<string>();
  let written = 0;
  for (const state of states) {
    const slug = projectStateSlug(state, usedSlugs);
    const fm = [
      "---",
      "type: project-continuity",
      `id: ${state.id}`,
      ...(state.projectKey ? [`projectKey: ${state.projectKey}`] : []),
      ...(state.path ? [`path: ${state.path}`] : []),
      ...(state.sourceSessionId ? [`sourceSessionId: ${state.sourceSessionId}`] : []),
      ...(state.version !== undefined ? [`version: ${state.version}`] : []),
      ...(state.confidence !== undefined ? [`confidence: ${state.confidence}`] : []),
      `updatedAt: ${state.updatedAt ?? ""}`,
      "---",
    ];
    const body: string[] = [`# ${state.projectKey ?? slug}`, ""];
    if (state.currentFocus?.trim()) {
      body.push("## Current Focus", "", state.currentFocus.trim(), "");
    }
    if (state.latestProgress?.trim()) {
      body.push("## Latest Progress", "", state.latestProgress.trim(), "");
    }
    if (state.blockers.length > 0) {
      body.push("## Blockers", "", ...state.blockers.map((b) => `- ${b}`), "");
    }
    if (state.nextSteps.length > 0) {
      body.push("## Next Steps", "", ...state.nextSteps.map((s) => `- ${s}`), "");
    }
    if (state.activeTicketIds.length > 0) {
      body.push("## Active Tickets", "", ...state.activeTicketIds.map((t) => `- ${t}`), "");
    }
    await writer.write(
      join("07 Continuity", "projects", `${slug}.md`),
      fm.join("\n") + "\n" + body.join("\n") + "\n",
    );
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Noema (canonical claims → 03 Resources/claims/)
// ---------------------------------------------------------------------------

async function writeNoemaFiles(writer: VaultWriter, noemas: NoemaExport[]): Promise<number> {
  let written = 0;
  for (const noema of noemas) {
    const idPart = noema.id.replace(/[⟨⟩]/g, "").slice(0, 8) || String(written);
    const slug = slugify(noema.canonicalText.slice(0, 80)) || "claim";
    const fm = [
      "---",
      "type: noema",
      `id: ${noema.id}`,
      ...(noema.factKey ? [`factKey: ${noema.factKey}`] : []),
      ...(noema.claimKey ? [`claimKey: ${noema.claimKey}`] : []),
      ...(noema.status ? [`status: ${noema.status}`] : []),
      ...(noema.stability !== undefined ? [`stability: ${noema.stability}`] : []),
      ...(noema.authority !== undefined ? [`authority: ${noema.authority}`] : []),
      ...(noema.evidenceCount !== undefined ? [`evidenceCount: ${noema.evidenceCount}`] : []),
      `supportSemioteCount: ${noema.supportSemioteIds.length}`,
      `createdAt: ${noema.createdAt ?? ""}`,
      `updatedAt: ${noema.updatedAt ?? ""}`,
      "---",
    ];
    const body = [`# ${noema.canonicalText.split(/[.\n]/)[0].trim() || "Claim"}`, "", noema.canonicalText];
    await writer.write(
      join("03 Resources", "claims", `${slug}-${idPart}.md`),
      fm.join("\n") + "\n" + body.join("\n") + "\n",
    );
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Legacy `memories` snapshot (one-time, guarded on file absence)
// ---------------------------------------------------------------------------

const LEGACY_SNAPSHOT_RELPATH = join("99 Meta", "legacy-memories-snapshot.json");

/**
 * Supersede-with-cutover garnish (audit §3.3): preserve the retired legacy
 * `memories` rows in the vault exactly once. The table itself stays untouched
 * in the DB; this is the ONLY remaining read of `memories` and it never runs
 * again once the snapshot file exists.
 */
async function writeLegacySnapshotIfAbsent(
  db: SurrealClient,
  vaultPath: string,
  writer: VaultWriter,
): Promise<boolean> {
  try {
    await access(join(vaultPath, LEGACY_SNAPSHOT_RELPATH));
    return false; // snapshot already taken — never overwrite
  } catch {
    // absent — take the one-time snapshot below
  }
  const results = await db.query<any>(`SELECT * FROM memories ORDER BY created_at ASC`);
  const rows = results[0] ?? [];
  if (rows.length === 0) return false; // nothing to preserve (fresh/test vaults)
  const snapshot = {
    snapshotAt: new Date().toISOString(),
    reason:
      "supersede-with-cutover: legacy `memories` table retired as an export source "
      + "(docs/analysis/2026-07-03-zed01-admin-export-audit-and-prod-table-measurement.md §3.3). "
      + "Rows preserved once here; the DB table itself is left untouched.",
    rowCount: rows.length,
    rows,
  };
  await writer.write(LEGACY_SNAPSHOT_RELPATH, JSON.stringify(snapshot, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

async function writeManifest(
  writer: VaultWriter,
  result: ExportResult,
  folderCounts: Record<string, number>,
): Promise<void> {
  const manifest = {
    ...result,
    folderCounts,
  };
  await writer.write(join("99 Meta", "export-manifest.json"), JSON.stringify(manifest, null, 2));
}

// ---------------------------------------------------------------------------
// Diff-based stale-file sweep (replaces the old destructive pre-clean)
// ---------------------------------------------------------------------------

const MANAGED_FOLDERS = [
  "00 Inbox/",
  "01 Projects/",
  "02 Areas/",
  "03 Resources/",
  "04 Archives/",
  "05 Daily Notes/",
  "06 Entities/",
  "07 Continuity/",
  "08 Maps/",
];

async function collectFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(fullPath);
      }
      return entry.isFile() ? [fullPath] : [];
    }));
    return files.flat();
  } catch {
    return [];
  }
}

async function pruneEmptyDirs(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await pruneEmptyDirs(join(root, entry.name));
    }
  }
  try {
    const remaining = await readdir(root);
    if (remaining.length === 0) await rmdir(root);
  } catch {
    // best-effort — a non-empty or already-removed dir is fine
  }
}

/**
 * Interrupt-safe cleanup: writes were idempotent overwrites; only AFTER every
 * write of the current run has landed do we remove managed files the run no
 * longer produces. A crash mid-export leaves a superset (old + new files),
 * never a gutted vault. Unmanaged folders and `99 Meta/` root files other
 * than the freshly produced ones are never touched.
 */
async function sweepStaleFiles(vaultPath: string, produced: Set<string>): Promise<number> {
  const roots = [
    ...MANAGED_FOLDERS,
    ...MANAGED_FOLDERS.map((folder) => join("99 Meta", folder)),
  ];
  let removed = 0;
  for (const root of roots) {
    const rootPath = join(vaultPath, root);
    const files = await collectFiles(rootPath);
    for (const filePath of files) {
      const rel = relative(vaultPath, filePath);
      if (!produced.has(rel)) {
        await rm(filePath, { force: true });
        removed += 1;
      }
    }
    await pruneEmptyDirs(rootPath);
  }
  return removed;
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectMarkdownFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : [];
    }));
    return files.flat();
  } catch {
    return [];
  }
}

export async function validateExport(vaultPath: string): Promise<string[]> {
  const warnings: string[] = [];

  for (const folder of MANAGED_FOLDERS) {
    const files = await collectMarkdownFiles(join(vaultPath, folder));
    for (const filePath of files) {
      const content = await readFile(filePath, "utf-8");
      const relPath = relative(vaultPath, filePath);
      const fileName = basename(filePath);

      if (/^#\s*$/m.test(content)) {
        const warning = `[vault-exporter] blank H1 detected in ${relPath}`;
        warnings.push(warning);
        console.warn(warning);
      }
      if (UUID_RE.test(fileName.replace(/\.md$/i, ""))) {
        const warning = `[vault-exporter] UUID-only filename detected in ${relPath}`;
        warnings.push(warning);
        console.warn(warning);
      }
      if (fileName.startsWith("memories--")) {
        const warning = `[vault-exporter] malformed filename detected in ${relPath}`;
        warnings.push(warning);
        console.warn(warning);
      }
      const idMatch = content.match(/^id:\s*(.+)$/m);
      if (idMatch && /^(memories:|entities:)/.test(idMatch[1].trim())) {
        const warning = `[vault-exporter] table-prefixed id detected in ${relPath}: ${idMatch[1].trim()}`;
        warnings.push(warning);
        console.warn(warning);
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runVaultExport(
  db: SurrealClient,
  vaultPath: string,
  opts: ExportOptions,
): Promise<ExportResult> {
  const startMs = Date.now();
  const { userId } = opts;
  // Guard against empty/relative/root vault paths — the diff-based sweep
  // must never operate on an unintended tree (Codex SUSPECTED finding).
  const resolvedVaultPath = resolve(vaultPath ?? "");
  if (
    !vaultPath?.trim() ||
    !isAbsolute(vaultPath) ||
    resolvedVaultPath === parse(resolvedVaultPath).root
  ) {
    throw new Error(`[vault-exporter] invalid vault path: ${JSON.stringify(vaultPath)} (must be an absolute non-root directory)`);
  }
  const confidenceThreshold = getVaultConfidenceThreshold();
  const writer = new VaultWriter(vaultPath);

  // --- Fetch (semiote, tenant-scoped) — runs FIRST so the synthesis pass
  // can be tenant-validated against the owned memory-id set ---
  let stageStart = Date.now();
  const activeRows = await fetchSemioteRows(db, userId, "(active = NONE OR active = true)");
  const archivedRows = await fetchSemioteRows(db, userId, "active = false");
  const cursor = computeCursor([...activeRows, ...archivedRows]);
  const activeMemories = mapRows(activeRows);
  const archivedMemories = mapRows(archivedRows);
  const allMemories = [...activeMemories, ...archivedMemories];
  const ownedMemoryIds = new Set(allMemories.map((m) => m.id));
  logStage("fetch", stageStart, {
    semiote_active: activeRows.length,
    semiote_archived: archivedRows.length,
    user: userId,
  });

  // --- Synthesis pass (tenant-validated) ---
  // synthesis_notes has NO tenant column (schema gap; 0 prod rows), so a
  // note is exported only when it references at least one memory id and
  // every referenced id resolves to a memory owned by this tenant (Codex
  // round-2: empty memoryIds must NOT be vacuously tenant-owned). Notes
  // citing foreign or legacy `memories:` ids are skipped and never suppress
  // raw export. `sweepSafe` guards the end-of-run sweep: a transient
  // synthesis failure must not delete previously exported synthesis files.
  // Deterministic bad rows (path-escape data) are skipped per-note WITHOUT
  // poisoning the sweep, so one bad row cannot pile up stale files forever.
  stageStart = Date.now();
  let synthesisNotesExported = 0;
  let synthesisNotesCount = 0;
  let synthesisNotesSkippedForeign = 0;
  let synthesisNotesSkippedInvalid = 0;
  let sweepSafe = true;
  const synthesizedMemoryIds = new Set<string>();

  try {
    const synthNotes = await fetchSynthesisNotes(db);
    synthesisNotesCount = synthNotes.length;
    for (const synthesis of synthNotes) {
      const bareMemoryIds = synthesis.memoryIds.map((memId) => bareRecordId(memId));
      const tenantOwned =
        bareMemoryIds.length > 0 &&
        bareMemoryIds.every((memId) => ownedMemoryIds.has(memId));
      if (!tenantOwned) {
        synthesisNotesSkippedForeign++;
        continue;
      }
      try {
        await writeSynthesisFile(writer, synthesis);
      } catch (err) {
        if (err instanceof VaultPathEscapeError) {
          // Deterministic bad row — skip it, keep the sweep enabled.
          synthesisNotesSkippedInvalid++;
          console.warn(`[vault-exporter] skipping synthesis note with unsafe path (${synthesis.id}):`, err.message);
          continue;
        }
        throw err;
      }
      synthesisNotesExported++;
      for (const memId of bareMemoryIds) {
        synthesizedMemoryIds.add(memId);
      }
    }
  } catch (err) {
    // Synthesis is best-effort — log but don't abort export. The sweep is
    // disabled for this run so prior synthesis files are not removed.
    sweepSafe = false;
    console.warn("[vault-exporter] synthesis pass error:", err);
  }
  logStage("synthesis", stageStart, {
    notes: synthesisNotesExported,
    skipped_foreign: synthesisNotesSkippedForeign,
    skipped_invalid: synthesisNotesSkippedInvalid,
  });

  // Filter out memories covered by tenant-validated synthesis
  const rawMemories = allMemories.filter(m => !synthesizedMemoryIds.has(m.id));

  // --- Notes (PARA folders + summaries + daily notes) ---
  stageStart = Date.now();
  const { folderMemories } = partitionMemories(rawMemories, confidenceThreshold);
  const byFolder = groupByFolder(folderMemories, confidenceThreshold);
  const exportedAt = new Date().toISOString();

  const notesProgress: NotesProgress = { done: 0, total: folderMemories.length };
  for (const [folder, mems] of byFolder) {
    await writeFolderContents(writer, folder, mems, notesProgress);
    const folderName = folder.replace(/\/$/, "").split("/").pop() ?? folder;
    await writeSummary(writer, folder, folderName, mems, exportedAt);
  }

  // Daily notes still use ALL memories (including synthesized ones)
  const dailyNoteDays = await writeDailyNotes(writer, allMemories);
  logStage("notes", stageStart, {
    folders: byFolder.size,
    memories: folderMemories.length,
    daily_notes: dailyNoteDays,
  });

  // --- Entities ---
  stageStart = Date.now();
  const entities = await fetchAllEntities(db, userId);
  // ONE aggregation query for the whole export (Rúnir-78sy.6 C3), replacing
  // entities.length sequential per-entity point-miss queries.
  const mentionCounts = await fetchMentionCounts(db);
  const entitiesExported = await writeEntityFiles(writer, entities, db, mentionCounts);
  logStage("entities", stageStart, { fetched: entities.length, written: entitiesExported });

  // --- Continuity (project_state → 07 Continuity/projects/) ---
  stageStart = Date.now();
  const projectStates = await fetchProjectStates(db, userId);
  const continuityStatesExported = await writeContinuityFiles(writer, projectStates);
  logStage("continuity", stageStart, { states: continuityStatesExported });

  // --- Noema (canonical claims → 03 Resources/claims/) ---
  stageStart = Date.now();
  const noemas = await fetchNoemas(db, userId);
  const noemasExported = await writeNoemaFiles(writer, noemas);
  logStage("noema", stageStart, { claims: noemasExported });

  // --- Legacy `memories` snapshot (one-time, guarded on file absence) ---
  stageStart = Date.now();
  let legacySnapshotWritten = false;
  try {
    legacySnapshotWritten = await writeLegacySnapshotIfAbsent(db, vaultPath, writer);
  } catch (err) {
    // Best-effort garnish on the cutover decision — never abort the export
    console.warn("[vault-exporter] legacy snapshot error:", err);
  }
  logStage("legacy_snapshot", stageStart, { written: legacySnapshotWritten });

  // --- Clean (diff-based stale sweep — runs LAST, never a blind pre-clean).
  // Guarded (Codex CONFIRMED findings): skipped when a soft-failed stage left
  // gaps in the produced set, or when this run found NO tenant content at all
  // (a wrong tenant / empty DB must not gut a previously good vault). The
  // guard counts tenant-scoped rows — not produced files — because the
  // unscoped legacy snapshot alone must not license a sweep (Codex round-2).
  stageStart = Date.now();
  let staleFilesRemoved = 0;
  const tenantContentCount =
    allMemories.length + entitiesExported + continuityStatesExported
    + noemasExported + synthesisNotesExported;
  const sweepAllowed = sweepSafe && tenantContentCount > 0;
  if (sweepAllowed) {
    staleFilesRemoved = await sweepStaleFiles(vaultPath, writer.produced);
    logStage("clean", stageStart, { stale_removed: staleFilesRemoved });
  } else {
    logStage("clean", stageStart, {
      skipped: true,
      reason: sweepSafe ? "empty_output" : "stage_failure",
    });
  }

  const validationWarnings = await validateExport(vaultPath);

  const result: ExportResult = {
    ok: true,
    exportedAt,
    userId,
    memoriesExported: allMemories.length,
    entitiesExported,
    continuityStatesExported,
    noemasExported,
    foldersWritten: byFolder.size,
    vaultPath,
    runDurationMs: Date.now() - startMs,
    validationWarnings,
    validationWarningsCount: validationWarnings.length,
    synthesisNotesExported,
    sourceCounts: {
      semiote_active: activeRows.length,
      semiote_archived: archivedRows.length,
      entities: entities.length,
      synthesis_notes: synthesisNotesCount,
      noema: noemas.length,
      project_state: projectStates.length,
    },
    cursor,
    legacySnapshotWritten,
    staleFilesRemoved,
  };

  const folderCounts = Object.fromEntries(
    [...byFolder.entries()].map(([k, v]) => [k, v.length])
  );
  stageStart = Date.now();
  await writeManifest(writer, result, folderCounts);
  logStage("manifest", stageStart, { warnings: validationWarnings.length });

  return result;
}
