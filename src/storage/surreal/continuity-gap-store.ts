// Continuity-gap storage (Rúnir-78sy.4/78sy.5, Archeion v2 Phase 3/4).
//
// Three additive SCHEMAFULL tables, mirroring continuity-state-store.ts:
//   - continuity_gap: evidence-backed gap records (brief §8). Dedupe by the
//     UNIQUE (user_id, workspace_id, project_key, dedupe_key) index; re-detect of
//     the same dedupe_key UPDATES (last_seen_at/score/evidence) via a read-then-
//     branch upsert so first_seen_at is set ONCE. Status transitions are owned by
//     the store on update: new→active on re-sighting; dismissed/materialized/
//     superseded are sticky (never reverted by a same-key re-detect).
//   - continuity_gap_build_state: per-project gap-evaluation cursor
//     (evaluated_through = the continuity-state updated_at the detector last
//     evaluated). Lets the report distinguish "gaps current" from "pending".
//   - continuity_report_state: per-project report cursor keyed on a CONTENT HASH
//     (not a timestamp — immune to the builder's LLM-fallback re-stamp churn).
//
// Convention: camelCase domain types in src/domain/memory/continuity.ts;
// Persisted*Row + mapRow + ensure*/query fns here (runir-session-store pattern).

import { canonicalizeWorkspaceId, fingerprint } from "../../identity/canonical-context.js";
import type {
  ContinuityGapBuildStateRecord,
  ContinuityGapConfidence,
  ContinuityGapKind,
  ContinuityGapRecord,
  ContinuityGapStatus,
  ContinuityGapWrite,
  ContinuityReportStateRecord,
  EvidenceRef,
} from "../../domain/memory/continuity.js";
import { extractId, type SurrealClient } from "./surreal-store.js";

// ── Deterministic record ids ─────────────────────────────────────────────────
// The gap id folds dedupe_key so a re-detect of the same latent gap hits the
// SAME row (a project has many gaps — the triple alone is not unique per-gap).

function tripleFingerprint(userId: string, workspaceId: string, projectKey: string): string {
  return fingerprint(`${userId}::${workspaceId}::${projectKey}`);
}

export function buildContinuityGapRecordId(
  userId: string,
  workspaceId: string,
  projectKey: string,
  dedupeKey: string,
): string {
  return `continuity_gap_${fingerprint(`${userId}::${workspaceId}::${projectKey}::${dedupeKey}`)}`;
}

export function buildContinuityGapBuildStateRecordId(userId: string, workspaceId: string, projectKey: string): string {
  return `continuity_gap_build_state_${tripleFingerprint(userId, workspaceId, projectKey)}`;
}

export function buildContinuityReportStateRecordId(userId: string, workspaceId: string, projectKey: string): string {
  return `continuity_report_state_${tripleFingerprint(userId, workspaceId, projectKey)}`;
}

// ── Persisted row shapes (snake_case) ────────────────────────────────────────

type PersistedContinuityGapRow = {
  id: unknown;
  user_id: string;
  workspace_id: string;
  project_key: string;
  target_project_id: string | null;
  target_namespace_id: string | null;
  kind: string;
  title: string;
  summary: string;
  recommendation: string;
  related_work_items: string[] | null;
  candidate_task_preview: string | null; // JSON string of {title, description}
  evidence: string | null; // JSON string of EvidenceRef[] (SCHEMAFULL-safe; nested keys vary)
  score: number | null;
  confidence: string;
  status: string;
  dedupe_key: string;
  first_seen_at: unknown;
  last_seen_at: unknown;
  last_reported_at: unknown;
};

function strArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function parseCandidatePreview(raw: string | null): { title: string; description: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { title?: unknown; description?: unknown };
    if (typeof parsed?.title === "string" && typeof parsed?.description === "string") {
      return { title: parsed.title, description: parsed.description };
    }
  } catch {
    // Malformed preview → drop it rather than fail the read.
  }
  return undefined;
}

function parseEvidence(raw: string | null): EvidenceRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EvidenceRef[]) : [];
  } catch {
    return [];
  }
}

function mapGapRow(row: PersistedContinuityGapRow): ContinuityGapRecord {
  return {
    id: extractId(row.id),
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    targetProjectId: row.target_project_id ?? undefined,
    targetNamespaceId: row.target_namespace_id ?? undefined,
    kind: row.kind as ContinuityGapKind,
    title: row.title,
    summary: row.summary,
    recommendation: row.recommendation,
    relatedWorkItems: strArray(row.related_work_items),
    candidateTaskPreview: parseCandidatePreview(row.candidate_task_preview),
    evidence: parseEvidence(row.evidence),
    score: Number(row.score ?? 0),
    confidence: row.confidence as ContinuityGapConfidence,
    status: row.status as ContinuityGapStatus,
    dedupeKey: row.dedupe_key,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    lastReportedAt: row.last_reported_at != null ? String(row.last_reported_at) : undefined,
  };
}

// ── ensure* (additive, ensure-only — no versioned migration) ─────────────────

export async function ensureContinuityGapTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS continuity_gap SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS workspace_id ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS target_project_id ON TABLE continuity_gap TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS target_namespace_id ON TABLE continuity_gap TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS kind ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS title ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS summary ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS recommendation ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS related_work_items ON TABLE continuity_gap TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS candidate_task_preview ON TABLE continuity_gap TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS evidence ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS score ON TABLE continuity_gap TYPE float;
    DEFINE FIELD IF NOT EXISTS confidence ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS status ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS dedupe_key ON TABLE continuity_gap TYPE string;
    DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE continuity_gap TYPE datetime;
    DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE continuity_gap TYPE datetime;
    DEFINE FIELD IF NOT EXISTS last_reported_at ON TABLE continuity_gap TYPE option<datetime>;
    DEFINE INDEX IF NOT EXISTS idx_cg_dedupe ON TABLE continuity_gap COLUMNS user_id, workspace_id, project_key, dedupe_key UNIQUE;
    DEFINE INDEX IF NOT EXISTS idx_cg_report ON TABLE continuity_gap COLUMNS user_id, workspace_id, project_key, status, last_seen_at;
  `);
}

export async function ensureContinuityGapBuildStateTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS continuity_gap_build_state SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE continuity_gap_build_state TYPE string;
    DEFINE FIELD IF NOT EXISTS workspace_id ON TABLE continuity_gap_build_state TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE continuity_gap_build_state TYPE string;
    DEFINE FIELD IF NOT EXISTS evaluated_through ON TABLE continuity_gap_build_state TYPE string;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE continuity_gap_build_state TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_cgbs_user_workspace_project ON TABLE continuity_gap_build_state COLUMNS user_id, workspace_id, project_key UNIQUE;
  `);
}

export async function ensureContinuityReportStateTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS continuity_report_state SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE continuity_report_state TYPE string;
    DEFINE FIELD IF NOT EXISTS workspace_id ON TABLE continuity_report_state TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE continuity_report_state TYPE string;
    DEFINE FIELD IF NOT EXISTS reported_content_hash ON TABLE continuity_report_state TYPE string;
    DEFINE FIELD IF NOT EXISTS reported_through ON TABLE continuity_report_state TYPE string;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE continuity_report_state TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_crs_user_workspace_project ON TABLE continuity_report_state COLUMNS user_id, workspace_id, project_key UNIQUE;
  `);
}

// ── Gap upsert (read-then-branch; first_seen_at set ONCE) ─────────────────────

async function findExistingGap(
  db: SurrealClient,
  recordId: string,
): Promise<{ id: string; status: ContinuityGapStatus } | undefined> {
  const results = await db.query<{ id: unknown; status: string }>(
    `SELECT id, status FROM type::record('continuity_gap', $recordId);`,
    { recordId },
  );
  const row = (results[0] ?? [])[0];
  if (row?.id) return { id: extractId(row.id), status: (row.status as ContinuityGapStatus) ?? "new" };
  return undefined;
}

// Sticky statuses are never reverted by a same-dedupeKey re-detect (§R.4). A row
// still in new/active bumps to active on re-sighting.
const STICKY_STATUS = new Set<ContinuityGapStatus>(["dismissed", "materialized", "superseded"]);

export interface UpsertContinuityGapOptions {
  /**
   * Reopens a `superseded` row instead of leaving it sticky (Rúnir-78sy.7
   * Part B, Codex MAJOR-1 — reverses the scout-round SKIP ruling). The
   * `missing_handoff` signal is NOT monotonic: `sessionHasHandoff` reads
   * ACTIVE semiote rows, so a handoff memory can later be inactivated/
   * superseded, making a previously-superseded gap valid again. Scoped to
   * the caller (detector-fired upserts only) — never the default, and never
   * applied to `dismissed` (user intent stays terminal regardless of this
   * flag; only `superseded` is eligible for reopening).
   */
  reopenIfSuperseded?: boolean;
}

/**
 * Upserts a gap keyed by (userId, workspaceId, projectKey, dedupeKey). CREATE
 * stamps first_seen_at = last_seen_at = now with the caller's status (typically
 * "new"). UPDATE leaves first_seen_at untouched, refreshes last_seen_at + the
 * mutable fields, and applies the status transition (sticky preserved, else
 * new→active — or, with `opts.reopenIfSuperseded`, a `superseded` row reopens
 * to "new" while `dismissed`/`materialized` stay sticky). A CREATE race
 * (duplicate id / unique rejection) is caught and retried as an UPDATE.
 * option<T> fields use the literal NONE-in-SET pattern.
 */
export async function upsertContinuityGap(
  db: SurrealClient,
  write: ContinuityGapWrite,
  opts: UpsertContinuityGapOptions = {},
): Promise<ContinuityGapRecord> {
  const workspaceId = canonicalizeWorkspaceId(write.workspaceId);
  const recordId = buildContinuityGapRecordId(write.userId, workspaceId, write.projectKey, write.dedupeKey);
  const now = new Date().toISOString();

  let existing = await findExistingGap(db, recordId);
  const evidenceJson = JSON.stringify(write.evidence ?? []);
  const candidatePreview = write.candidateTaskPreview ? JSON.stringify(write.candidateTaskPreview) : undefined;

  // Shared mutable-field SET fragments (present in both CREATE content + UPDATE).
  const baseVars: Record<string, unknown> = {
    recordId,
    userId: write.userId,
    workspaceId,
    projectKey: write.projectKey,
    kind: write.kind,
    title: write.title,
    summary: write.summary,
    recommendation: write.recommendation,
    relatedWorkItems: write.relatedWorkItems,
    evidence: evidenceJson,
    score: write.score,
    confidence: write.confidence,
    dedupeKey: write.dedupeKey,
  };
  if (write.targetProjectId !== undefined) baseVars.targetProjectId = write.targetProjectId;
  if (write.targetNamespaceId !== undefined) baseVars.targetNamespaceId = write.targetNamespaceId;
  if (candidatePreview !== undefined) baseVars.candidatePreview = candidatePreview;

  const optionSet = (field: string, varName: string, present: boolean): string =>
    present ? `${field} = $${varName}` : `${field} = NONE`;

  if (!existing) {
    const firstSeenAt = write.firstSeenAt ?? now;
    const lastSeenAt = write.lastSeenAt ?? now;
    const created = await db
      .query<PersistedContinuityGapRow>(
        `CREATE type::record('continuity_gap', $recordId) SET
           user_id = $userId,
           workspace_id = $workspaceId,
           project_key = $projectKey,
           ${optionSet("target_project_id", "targetProjectId", write.targetProjectId !== undefined)},
           ${optionSet("target_namespace_id", "targetNamespaceId", write.targetNamespaceId !== undefined)},
           kind = $kind,
           title = $title,
           summary = $summary,
           recommendation = $recommendation,
           related_work_items = $relatedWorkItems,
           ${optionSet("candidate_task_preview", "candidatePreview", candidatePreview !== undefined)},
           evidence = $evidence,
           score = <float>$score,
           confidence = $confidence,
           status = $status,
           dedupe_key = $dedupeKey,
           first_seen_at = <datetime>$firstSeenAt,
           last_seen_at = <datetime>$lastSeenAt
         RETURN AFTER;`,
        { ...baseVars, status: write.status, firstSeenAt, lastSeenAt },
      )
      .catch(() => null);
    const row = created ? (created[0] ?? [])[0] : undefined;
    if (row) return mapGapRow(row);
    // CREATE race: another writer won between our miss and this create. Re-read
    // so the fallback UPDATE sees the raced row's (possibly sticky) status and
    // does not revert a concurrent dismiss/materialize/supersede (Codex F6).
    existing = await findExistingGap(db, recordId);
  }

  const priorStatus = existing?.status ?? "active";
  // reopenIfSuperseded narrows the sticky set to just {dismissed, materialized}
  // for this call — "superseded" becomes reopenable back to "new" (dismissed
  // stays terminal regardless: user intent, never reopened by any refire).
  const stickyForThisWrite = opts.reopenIfSuperseded
    ? new Set<ContinuityGapStatus>(["dismissed", "materialized"])
    : STICKY_STATUS;
  let nextStatus: ContinuityGapStatus = "active";
  if (stickyForThisWrite.has(priorStatus)) {
    nextStatus = priorStatus;
  } else if (opts.reopenIfSuperseded && priorStatus === "superseded") {
    nextStatus = "new";
  }
  const lastSeenAt = write.lastSeenAt ?? now;
  const updateResults = await db.query<PersistedContinuityGapRow>(
    `UPDATE type::record('continuity_gap', $recordId) SET
       user_id = $userId,
       workspace_id = $workspaceId,
       project_key = $projectKey,
       ${optionSet("target_project_id", "targetProjectId", write.targetProjectId !== undefined)},
       ${optionSet("target_namespace_id", "targetNamespaceId", write.targetNamespaceId !== undefined)},
       kind = $kind,
       title = $title,
       summary = $summary,
       recommendation = $recommendation,
       related_work_items = $relatedWorkItems,
       ${optionSet("candidate_task_preview", "candidatePreview", candidatePreview !== undefined)},
       evidence = $evidence,
       score = <float>$score,
       confidence = $confidence,
       status = $status,
       dedupe_key = $dedupeKey,
       last_seen_at = <datetime>$lastSeenAt
     RETURN AFTER;`,
    { ...baseVars, status: nextStatus, lastSeenAt },
  );
  const updated = (updateResults[0] ?? [])[0];
  if (updated) return mapGapRow(updated);

  // Neither create nor update returned a row (should not happen). Re-read.
  const reread = await db.query<PersistedContinuityGapRow>(
    `SELECT * FROM type::record('continuity_gap', $recordId);`,
    { recordId },
  );
  const row = (reread[0] ?? [])[0];
  if (!row) throw new Error(`[continuity-gap-store] upsert produced no row for ${recordId}`);
  return mapGapRow(row);
}

// ── Reads ────────────────────────────────────────────────────────────────────

const GAP_COLUMNS =
  "id, user_id, workspace_id, project_key, target_project_id, target_namespace_id, kind, title, summary, recommendation, related_work_items, candidate_task_preview, evidence, score, confidence, status, dedupe_key, first_seen_at, last_seen_at, last_reported_at";

/** Reads gaps for a project filtered by status (default new+active), ordered for
 *  the report (score DESC, last_seen_at DESC — served by idx_cg_report). */
export async function getContinuityGaps(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
  statuses: ContinuityGapStatus[] = ["new", "active"],
): Promise<ContinuityGapRecord[]> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<PersistedContinuityGapRow>(
    `SELECT ${GAP_COLUMNS} FROM continuity_gap
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       AND status IN $statuses
       ORDER BY score DESC, last_seen_at DESC;`,
    { userId, workspaceId, projectKey, statuses },
  );
  return (results[0] ?? []).map(mapGapRow);
}

/** Reads active/new gaps of ONE kind for a project — the reconciliation input
 *  (the detector supersedes those whose dedupe_key is not in the fired set). */
export async function listActiveGapsForKind(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
  kind: ContinuityGapKind,
): Promise<ContinuityGapRecord[]> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<PersistedContinuityGapRow>(
    `SELECT ${GAP_COLUMNS} FROM continuity_gap
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       AND kind = $kind AND status IN ['new', 'active'];`,
    { userId, workspaceId, projectKey, kind },
  );
  return (results[0] ?? []).map(mapGapRow);
}

// ── Lifecycle transitions ─────────────────────────────────────────────────────

/** Sets a gap's status by record id (the Leit lifecycle + reconciliation path).
 *  Transition legality is enforced by the caller. */
export async function setGapStatus(db: SurrealClient, gapId: string, status: ContinuityGapStatus): Promise<void> {
  await db.query(
    `UPDATE type::record('continuity_gap', $gapId) SET status = $status, last_seen_at = last_seen_at;`,
    { gapId, status },
  );
}

/** Stamps last_reported_at when the report surfaces a gap (report writer). */
export async function markGapReported(db: SurrealClient, gapId: string, at?: string): Promise<void> {
  const reportedAt = at ?? new Date().toISOString();
  await db.query(
    `UPDATE type::record('continuity_gap', $gapId) SET last_reported_at = <datetime>$reportedAt;`,
    { gapId, reportedAt },
  );
}

// ── Gap-evaluation cursor (evaluated_through) ────────────────────────────────

export async function readGapEvaluatedThrough(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
): Promise<string | null> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<{ evaluated_through: string }>(
    `SELECT evaluated_through FROM continuity_gap_build_state
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       LIMIT 1;`,
    { userId, workspaceId, projectKey },
  );
  const row = results[0]?.[0];
  return typeof row?.evaluated_through === "string" && row.evaluated_through.length > 0 ? row.evaluated_through : null;
}

export async function writeGapEvaluatedThrough(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
  evaluatedThrough: string,
): Promise<void> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const recordId = buildContinuityGapBuildStateRecordId(userId, workspaceId, projectKey);
  await db.query(
    `UPSERT type::record('continuity_gap_build_state', $recordId) SET
       user_id = $userId,
       workspace_id = $workspaceId,
       project_key = $projectKey,
       evaluated_through = $evaluatedThrough,
       updated_at = time::now();`,
    { recordId, userId, workspaceId, projectKey, evaluatedThrough },
  );
}

export async function readContinuityGapBuildState(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
): Promise<ContinuityGapBuildStateRecord | null> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<{ user_id: string; workspace_id: string; project_key: string; evaluated_through: string; updated_at: unknown }>(
    `SELECT user_id, workspace_id, project_key, evaluated_through, updated_at FROM continuity_gap_build_state
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       LIMIT 1;`,
    { userId, workspaceId, projectKey },
  );
  const row = results[0]?.[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    evaluatedThrough: row.evaluated_through,
    updatedAt: String(row.updated_at),
  };
}

// ── Report cursor (content hash) ─────────────────────────────────────────────

export async function readContinuityReportState(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
): Promise<ContinuityReportStateRecord | null> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<{
    user_id: string;
    workspace_id: string;
    project_key: string;
    reported_content_hash: string;
    reported_through: string;
    updated_at: unknown;
  }>(
    `SELECT user_id, workspace_id, project_key, reported_content_hash, reported_through, updated_at
       FROM continuity_report_state
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       LIMIT 1;`,
    { userId, workspaceId, projectKey },
  );
  const row = results[0]?.[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    reportedContentHash: row.reported_content_hash,
    reportedThrough: row.reported_through,
    updatedAt: String(row.updated_at),
  };
}

export async function writeContinuityReportState(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
  reportedContentHash: string,
  reportedThrough: string,
): Promise<void> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const recordId = buildContinuityReportStateRecordId(userId, workspaceId, projectKey);
  await db.query(
    `UPSERT type::record('continuity_report_state', $recordId) SET
       user_id = $userId,
       workspace_id = $workspaceId,
       project_key = $projectKey,
       reported_content_hash = $reportedContentHash,
       reported_through = $reportedThrough,
       updated_at = time::now();`,
    { recordId, userId, workspaceId, projectKey, reportedContentHash, reportedThrough },
  );
}
