// Continuity-evidence ingestion storage (Rúnir-78sy.9, Archeion v2 Phase 0/3b).
//
// One additive SCHEMAFULL table backing POST /hooks/evidence:
//   - continuity_evidence: pushed EvidenceRef rows (S-2), deduped on the UNIQUE
//     (user_id, workspace_id, project_key, source_type, source_id) 5-tuple.
//     Re-posting the same commit/bead/etc. UPDATES (last_seen_at/ref/binding/
//     conflict) rather than duplicating; first_seen_at is set ONCE. The
//     collector-blocked detectors (orphaned_change/doc_drift/bead_stale/
//     stale_agent_run) QUERY this table — continuity_gap.evidence stays
//     detector OUTPUT, never ingest input (orchestrator ruling 1).
//
// Convention: camelCase domain types in src/domain/memory/continuity.ts;
// Persisted*Row + mapRow + ensure*/query fns here (continuity-gap-store.ts
// pattern). `ref` is stored as a JSON STRING (Rúnir-78sy.8 lesson: SCHEMAFULL
// array<object>/object rejects any write whose nested keys vary — EvidenceRef
// has optional uri/excerpt/timestamp/confidence/sensitivity).

import { canonicalizeWorkspaceId, fingerprint } from "../../identity/canonical-context.js";
import { buildBindingConditions, deriveContinuityBindingKeys } from "../../lifecycle/semion/continuity-build.js";
import type {
  ContinuityEvidenceRecord,
  ContinuityEvidenceWrite,
  EvidenceRef,
  LeitEvidenceSourceType,
} from "../../domain/memory/continuity.js";
import { extractId, type SurrealClient } from "./surreal-store.js";

// ── Deterministic record id ──────────────────────────────────────────────────
// Folds the FULL dedupe 5-tuple so a re-post of the same source hits the SAME
// row (one row per source, not one per project).

/**
 * Canonicalizes workspaceId itself (per-fn contract, src/storage/AGENTS.md:19)
 * so a direct caller can never mint an id inconsistent with the canonicalized
 * 5-tuple the upsert path uses. canonicalizeWorkspaceId is idempotent, so the
 * upsert path's own canonicalization before calling this is harmless
 * double-canonicalization, not a bug.
 */
export function buildContinuityEvidenceRecordId(
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
  sourceType: string,
  sourceId: string,
): string {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  return `continuity_evidence_${fingerprint(`${userId}::${workspaceId}::${projectKey}::${sourceType}::${sourceId}`)}`;
}

// ── Persisted row shape (snake_case) ─────────────────────────────────────────

type PersistedContinuityEvidenceRow = {
  id: unknown;
  user_id: string;
  workspace_id: string;
  project_key: string;
  project_id: string | null;
  conflicting_project_id: string | null;
  source_type: string;
  source_id: string;
  occurred_at: string | null;
  ref: string; // JSON string of the full EvidenceRef (78sy.8 lesson).
  bound_session_id: string | null;
  first_seen_at: unknown;
  last_seen_at: unknown;
};

/** Guarded JSON parse for the `ref` column — never throws on read; malformed
 *  or non-object data falls back to a minimal placeholder rather than losing
 *  the row. */
function parseRef(raw: string, sourceType: string, sourceId: string): EvidenceRef {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as EvidenceRef;
    }
  } catch {
    // Malformed ref JSON → fall through to the placeholder below.
  }
  return { sourceType: sourceType as LeitEvidenceSourceType, sourceId, label: sourceId };
}

function mapEvidenceRow(row: PersistedContinuityEvidenceRow): ContinuityEvidenceRecord {
  return {
    id: extractId(row.id),
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    projectId: row.project_id ?? undefined,
    conflictingProjectId: row.conflicting_project_id ?? undefined,
    sourceType: row.source_type as LeitEvidenceSourceType,
    sourceId: row.source_id,
    occurredAt: row.occurred_at ?? undefined,
    ref: parseRef(row.ref, row.source_type, row.source_id),
    boundSessionId: row.bound_session_id ?? undefined,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

// ── ensure* (additive, ensure-only — no versioned migration) ─────────────────

export async function ensureContinuityEvidenceTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS continuity_evidence SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE continuity_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS workspace_id ON TABLE continuity_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE continuity_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS project_id ON TABLE continuity_evidence TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS conflicting_project_id ON TABLE continuity_evidence TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_type ON TABLE continuity_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS source_id ON TABLE continuity_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE continuity_evidence TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS ref ON TABLE continuity_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS bound_session_id ON TABLE continuity_evidence TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE continuity_evidence TYPE datetime;
    DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE continuity_evidence TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_ce_dedupe ON TABLE continuity_evidence COLUMNS user_id, workspace_id, project_key, source_type, source_id UNIQUE;
    DEFINE INDEX IF NOT EXISTS idx_ce_kind_report ON TABLE continuity_evidence COLUMNS user_id, workspace_id, project_key, source_type, last_seen_at;
    DEFINE INDEX IF NOT EXISTS idx_ce_project_report ON TABLE continuity_evidence COLUMNS user_id, workspace_id, project_key, last_seen_at;
  `);
}

// ── Upsert (read-then-branch; first_seen_at set ONCE) ────────────────────────

async function findExistingEvidence(
  db: SurrealClient,
  recordId: string,
): Promise<{ id: string } | undefined> {
  const results = await db.query<{ id: unknown }>(
    `SELECT id FROM type::record('continuity_evidence', $recordId);`,
    { recordId },
  );
  const row = (results[0] ?? [])[0];
  if (row?.id) return { id: extractId(row.id) };
  return undefined;
}

/**
 * Upserts one evidence row keyed by (userId, workspaceId, projectKey,
 * sourceType, sourceId). CREATE stamps first_seen_at = last_seen_at = now;
 * UPDATE leaves first_seen_at untouched and refreshes last_seen_at + the
 * mutable fields (ref/occurredAt/boundSessionId/conflictingProjectId). A
 * CREATE race (duplicate id / unique rejection) is caught and retried as an
 * UPDATE. option<T> fields use the literal NONE-in-SET pattern (a bound null
 * param coerces to NULL, which SCHEMAFULL option<T> rejects).
 */
export async function upsertContinuityEvidence(
  db: SurrealClient,
  write: ContinuityEvidenceWrite,
): Promise<{ record: ContinuityEvidenceRecord; outcome: "created" | "updated" }> {
  const workspaceId = canonicalizeWorkspaceId(write.workspaceId);
  const recordId = buildContinuityEvidenceRecordId(write.userId, workspaceId, write.projectKey, write.sourceType, write.sourceId);
  const now = new Date().toISOString();
  const refJson = JSON.stringify(write.ref);

  const optionSet = (field: string, varName: string, present: boolean): string =>
    present ? `${field} = $${varName}` : `${field} = NONE`;

  const baseVars: Record<string, unknown> = {
    recordId,
    userId: write.userId,
    workspaceId,
    projectKey: write.projectKey,
    sourceType: write.sourceType,
    sourceId: write.sourceId,
    ref: refJson,
  };
  if (write.projectId !== undefined) baseVars.projectId = write.projectId;
  if (write.conflictingProjectId !== undefined) baseVars.conflictingProjectId = write.conflictingProjectId;
  if (write.occurredAt !== undefined) baseVars.occurredAt = write.occurredAt;
  if (write.boundSessionId !== undefined) baseVars.boundSessionId = write.boundSessionId;

  let existing = await findExistingEvidence(db, recordId);

  if (!existing) {
    const firstSeenAt = write.firstSeenAt ?? now;
    const lastSeenAt = write.lastSeenAt ?? now;
    const created = await db
      .query<PersistedContinuityEvidenceRow>(
        `CREATE type::record('continuity_evidence', $recordId) SET
           user_id = $userId,
           workspace_id = $workspaceId,
           project_key = $projectKey,
           ${optionSet("project_id", "projectId", write.projectId !== undefined)},
           ${optionSet("conflicting_project_id", "conflictingProjectId", write.conflictingProjectId !== undefined)},
           source_type = $sourceType,
           source_id = $sourceId,
           ${optionSet("occurred_at", "occurredAt", write.occurredAt !== undefined)},
           ref = $ref,
           ${optionSet("bound_session_id", "boundSessionId", write.boundSessionId !== undefined)},
           first_seen_at = <datetime>$firstSeenAt,
           last_seen_at = <datetime>$lastSeenAt
         RETURN AFTER;`,
        { ...baseVars, firstSeenAt, lastSeenAt },
      )
      .catch(() => null);
    const row = created ? (created[0] ?? [])[0] : undefined;
    if (row) return { record: mapEvidenceRow(row), outcome: "created" };
    // CREATE race: another writer won between our miss and this create.
    existing = await findExistingEvidence(db, recordId);
  }

  const lastSeenAt = write.lastSeenAt ?? now;
  const updateResults = await db.query<PersistedContinuityEvidenceRow>(
    `UPDATE type::record('continuity_evidence', $recordId) SET
       user_id = $userId,
       workspace_id = $workspaceId,
       project_key = $projectKey,
       ${optionSet("project_id", "projectId", write.projectId !== undefined)},
       ${optionSet("conflicting_project_id", "conflictingProjectId", write.conflictingProjectId !== undefined)},
       source_type = $sourceType,
       source_id = $sourceId,
       ${optionSet("occurred_at", "occurredAt", write.occurredAt !== undefined)},
       ref = $ref,
       ${optionSet("bound_session_id", "boundSessionId", write.boundSessionId !== undefined)},
       last_seen_at = <datetime>$lastSeenAt
     RETURN AFTER;`,
    { ...baseVars, lastSeenAt },
  );
  const updated = (updateResults[0] ?? [])[0];
  if (updated) return { record: mapEvidenceRow(updated), outcome: "updated" };

  // Neither create nor update returned a row (should not happen). Re-read.
  const reread = await db.query<PersistedContinuityEvidenceRow>(
    `SELECT * FROM type::record('continuity_evidence', $recordId);`,
    { recordId },
  );
  const row = (reread[0] ?? [])[0];
  if (!row) throw new Error(`[continuity-evidence-store] upsert produced no row for ${recordId}`);
  return { record: mapEvidenceRow(row), outcome: "updated" };
}

// ── Reads ────────────────────────────────────────────────────────────────────

const EVIDENCE_COLUMNS =
  "id, user_id, workspace_id, project_key, project_id, conflicting_project_id, source_type, source_id, occurred_at, ref, bound_session_id, first_seen_at, last_seen_at";

export interface ListEvidenceOptions {
  sourceType?: LeitEvidenceSourceType;
  limit?: number;
}

/**
 * Lists ingested evidence for a project, optionally filtered to one
 * sourceType, ordered newest-first (last_seen_at DESC). Each branch is served
 * by its matching index (F4): the sourceType-filtered branch by
 * idx_ce_kind_report, the project-wide branch by idx_ce_project_report — every
 * ORDER BY idiom lives in the SELECT projection (Rúnir-78sy.12).
 */
export async function listEvidenceForProject(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
  options: ListEvidenceOptions = {},
): Promise<ContinuityEvidenceRecord[]> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const limit = options.limit ?? 100;
  if (options.sourceType) {
    const results = await db.query<PersistedContinuityEvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} FROM continuity_evidence
         WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
         AND source_type = $sourceType
         ORDER BY last_seen_at DESC
         LIMIT $limit;`,
      { userId, workspaceId, projectKey, sourceType: options.sourceType, limit },
    );
    return (results[0] ?? []).map(mapEvidenceRow);
  }
  const results = await db.query<PersistedContinuityEvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM continuity_evidence
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       ORDER BY last_seen_at DESC
       LIMIT $limit;`,
    { userId, workspaceId, projectKey, limit },
  );
  return (results[0] ?? []).map(mapEvidenceRow);
}

// ── Session binding (C4, v1 deterministic) ───────────────────────────────────
// Best-effort enrichment ONLY — binding failure never rejects an evidence row
// (orchestrator ruling 2). PURE reads only; never resolveRunirSession
// (resolve-or-CREATE) — a binding lookup must not mint or touch session rows
// (F6). The project-anchor filter reuses deriveContinuityBindingKeys, the same
// mechanism the detectors/builder use (src/lifecycle/semion/continuity-gaps.ts
// fetchRecentlyEndedSessions) — candidate sessions are ONLY those matching the
// enrollment's binding keys; a concurrent session from an unrelated project
// can never bind (F2). Unlike fetchRecentlyEndedSessions this considers BOTH
// closed AND open (closed_at NONE) sessions (F6).

export interface CandidateSession {
  id: string;
  startedAt: string;
  closedAt?: string;
}

/**
 * Fetches every session matching the enrollment's project-anchor binding
 * keys — closed or still open — for the binding-window search below. Exported
 * (Codex P1) so a per-request caller (evidence-ingest.ts) can fetch ONCE and
 * reuse the same candidate list across every EvidenceRef in the batch, instead
 * of re-querying per item (only `occurredAt` varies across items, and that is
 * applied in-memory by selectBoundSessionId, not in this query).
 */
export async function fetchAnchoredCandidateSessions(
  db: SurrealClient,
  userId: string,
  enrollment: { projectId?: string; repoRemote?: string; repoRootFingerprint?: string },
): Promise<CandidateSession[]> {
  const keys = deriveContinuityBindingKeys(enrollment);
  const binding = buildBindingConditions(keys, "workspace_fingerprint");
  if (!binding) return [];
  const { conditions, vars: bindingVars } = binding;
  const vars: Record<string, unknown> = { userId, ...bindingVars };

  const results = await db.query<{ id: unknown; opened_at: unknown; closed_at: unknown }>(
    `SELECT id, opened_at, closed_at FROM runir_session
       WHERE user_id = $userId AND (${conditions.join(" OR ")})
       ORDER BY opened_at ASC;`,
    vars,
  );
  return (results[0] ?? [])
    .map((r) => ({
      id: extractId(r.id),
      startedAt: r.opened_at != null ? String(r.opened_at) : "",
      closedAt: r.closed_at != null ? String(r.closed_at) : undefined,
    }))
    .filter((s) => s.id.length > 0 && s.startedAt.length > 0);
}

/**
 * Pure in-memory selection of the NARROWEST-window anchored session that
 * contains `occurredAt`, `[started_at, closed_at ?? now]` (open sessions
 * eligible). Ties (equal-width overlap) → most recently started wins. A
 * missing/unparseable/future timestamp selects nothing (F1 — no clock-skew
 * fudge in v1). Takes an ALREADY-FETCHED candidate list (Codex P1) so a
 * per-request caller fetches sessions once and calls this per item — no SQL
 * here, never creates or mutates a session row (F6).
 */
export function selectBoundSessionId(
  candidates: CandidateSession[],
  occurredAt: string | undefined,
): string | undefined {
  if (!occurredAt) return undefined;
  const occurredMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredMs)) return undefined;

  const nowMs = Date.now();
  let best: { id: string; startedMs: number; widthMs: number } | undefined;
  for (const candidate of candidates) {
    const startedMs = Date.parse(candidate.startedAt);
    if (!Number.isFinite(startedMs)) continue;
    const endMs = candidate.closedAt ? Date.parse(candidate.closedAt) : nowMs;
    const effectiveEndMs = Number.isFinite(endMs) ? endMs : nowMs;
    if (occurredMs < startedMs || occurredMs > effectiveEndMs) continue;
    const widthMs = effectiveEndMs - startedMs;
    if (
      !best ||
      widthMs < best.widthMs ||
      (widthMs === best.widthMs && startedMs > best.startedMs)
    ) {
      best = { id: candidate.id, startedMs, widthMs };
    }
  }
  return best?.id;
}

/**
 * Binds an evidence timestamp to the NARROWEST-window anchored session that
 * contains it — the single-item convenience wrapper (fetch-then-select) kept
 * for callers binding ONE timestamp at a time (e.g. the live repro test's
 * per-case assertions). A per-request batch caller should instead call
 * fetchAnchoredCandidateSessions ONCE and selectBoundSessionId per item
 * (Codex P1) rather than this wrapper in a loop.
 */
export async function bindEvidenceToSession(
  db: SurrealClient,
  userId: string,
  enrollment: { projectId?: string; repoRemote?: string; repoRootFingerprint?: string },
  occurredAt: string | undefined,
): Promise<string | undefined> {
  if (!occurredAt) return undefined;
  const candidates = await fetchAnchoredCandidateSessions(db, userId, enrollment);
  return selectBoundSessionId(candidates, occurredAt);
}
