// Continuity-state storage (Rúnir-78sy.3, Archeion v2 Phase 2).
//
// Three additive SCHEMAFULL tables:
//   - project_continuity_state: one CAS-versioned canonical row per
//     (user_id, workspace_id, project_key); supersede-by-replace, valid_at
//     stamped each write. CAS copies compareAndSwapProjectState verbatim
//     (surreal-store.ts:1685-1823) — WHERE-guarded UPDATE + CREATE-race .catch
//     re-read; a row existing on re-read means a genuine race → version_mismatch,
//     otherwise the original create error is rethrown (Rúnir-78sy.8 C2).
//   - project_enrollment: the builder's iteration set. option<T> optionals use
//     the literal NONE in SET writes (the logSupersedeShadow gotcha).
//   - continuity_build_state: per-project build cursor. built_through is the
//     verbatim ISO string of the newest evidence row folded into the last
//     successful synthesis, compared lexicographically app-side (dedup_state
//     pattern) — never a Surreal datetime round-trip.
//
// Convention: domain record types (camelCase) live in src/domain/memory/
// continuity.ts; Persisted*Row + mapRow live here (runir-session-store pattern).

import { canonicalizeWorkspaceId, fingerprint } from "../../identity/canonical-context.js";
import type {
  ContinuityBuildStateRecord,
  ProjectContinuityStateRecord,
  ProjectContinuityStateWrite,
  ProjectEnrollmentRecord,
  ProjectEnrollmentSource,
  ProjectEnrollmentWrite,
} from "../../domain/memory/continuity.js";
import { extractId, type SurrealClient } from "./surreal-store.js";

// ── Deterministic record ids ─────────────────────────────────────────────────
// `<table>_${fp24(userId::workspaceId::projectKey)}` — one canonical row per
// (user, workspace, project) triple, matching the composite unique index.

function continuityTripleFingerprint(userId: string, workspaceId: string, projectKey: string): string {
  return fingerprint(`${userId}::${workspaceId}::${projectKey}`);
}

export function buildProjectContinuityStateRecordId(userId: string, workspaceId: string, projectKey: string): string {
  return `project_continuity_state_${continuityTripleFingerprint(userId, workspaceId, projectKey)}`;
}

export function buildProjectEnrollmentRecordId(userId: string, workspaceId: string, projectKey: string): string {
  return `project_enrollment_${continuityTripleFingerprint(userId, workspaceId, projectKey)}`;
}

export function buildContinuityBuildStateRecordId(userId: string, workspaceId: string, projectKey: string): string {
  return `continuity_build_state_${continuityTripleFingerprint(userId, workspaceId, projectKey)}`;
}

// ── Persisted row shapes (snake_case) ────────────────────────────────────────

type PersistedProjectContinuityStateRow = {
  id: unknown;
  user_id: string;
  workspace_id: string;
  project_key: string;
  project_id: string | null;
  default_namespace_id: string | null;
  current_focus: string[] | null;
  latest_progress: string[] | null;
  next_steps: string[] | null;
  blockers: string[] | null;
  open_loops: string[] | null;
  unfiled_intentions: string[] | null;
  pending_verification: string[] | null;
  recently_changed_artifacts: string[] | null;
  likely_stale_beads: string[] | null;
  active_agent_runs: string[] | null;
  source_evidence_refs: string | Array<Record<string, unknown>> | null; // JSON string (legacy rows may still hold the pre-retype array)
  confidence: number | null;
  source_session_ids: string[] | null;
  supporting_semiote_ids: string[] | null;
  version: number | null;
  valid_at: unknown;
  updated_at: unknown;
};

type PersistedProjectEnrollmentRow = {
  id: unknown;
  user_id: string;
  workspace_id: string;
  project_key: string;
  project_id: string | null;
  default_namespace_id: string | null;
  repo_remote: string | null;
  repo_root_fingerprint: string | null;
  source: ProjectEnrollmentSource;
  enrolled_at: unknown;
};

type PersistedContinuityBuildStateRow = {
  user_id: string;
  workspace_id: string;
  project_key: string;
  built_through: string;
  updated_at: unknown;
};

function strArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Parses source_evidence_refs defensively: the field is a JSON string of
 * Array<Record<string, unknown>> (C1); legacy pre-retype rows may still hold
 * the raw array value (passed through as-is). Never throws — malformed or
 * unrecognized shapes fall back to [].
 */
function parseSourceEvidenceRefs(raw: string | Array<Record<string, unknown>> | null): Array<Record<string, unknown>> {
  const onlyObjects = (arr: unknown[]): Array<Record<string, unknown>> =>
    arr.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && !Array.isArray(e));
  if (Array.isArray(raw)) return onlyObjects(raw);
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? onlyObjects(parsed) : [];
  } catch {
    return [];
  }
}

function mapContinuityStateRow(row: PersistedProjectContinuityStateRow): ProjectContinuityStateRecord {
  return {
    id: extractId(row.id),
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    projectId: row.project_id ?? undefined,
    defaultNamespaceId: row.default_namespace_id ?? undefined,
    currentFocus: strArray(row.current_focus),
    latestProgress: strArray(row.latest_progress),
    nextSteps: strArray(row.next_steps),
    blockers: strArray(row.blockers),
    openLoops: strArray(row.open_loops),
    unfiledIntentions: strArray(row.unfiled_intentions),
    pendingVerification: strArray(row.pending_verification),
    recentlyChangedArtifacts: strArray(row.recently_changed_artifacts),
    likelyStaleBeads: strArray(row.likely_stale_beads),
    activeAgentRuns: strArray(row.active_agent_runs),
    sourceEvidenceRefs: parseSourceEvidenceRefs(row.source_evidence_refs),
    confidence: Number(row.confidence ?? 0),
    sourceSessionIds: strArray(row.source_session_ids),
    supportingSemioteIds: strArray(row.supporting_semiote_ids),
    version: Number(row.version ?? 0),
    validAt: String(row.valid_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEnrollmentRow(row: PersistedProjectEnrollmentRow): ProjectEnrollmentRecord {
  return {
    id: extractId(row.id),
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectKey: row.project_key,
    projectId: row.project_id ?? undefined,
    defaultNamespaceId: row.default_namespace_id ?? undefined,
    repoRemote: row.repo_remote ?? undefined,
    repoRootFingerprint: row.repo_root_fingerprint ?? undefined,
    source: row.source,
    enrolledAt: String(row.enrolled_at),
  };
}

// ── ensure* (additive, ensure-only — no versioned migration) ─────────────────

export async function ensureProjectContinuityStateTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS project_continuity_state SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE project_continuity_state TYPE string;
    DEFINE FIELD IF NOT EXISTS workspace_id ON TABLE project_continuity_state TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE project_continuity_state TYPE string;
    DEFINE FIELD IF NOT EXISTS project_id ON TABLE project_continuity_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS default_namespace_id ON TABLE project_continuity_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS current_focus ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS latest_progress ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS next_steps ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS blockers ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS open_loops ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS unfiled_intentions ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS pending_verification ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS recently_changed_artifacts ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS likely_stale_beads ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS active_agent_runs ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS confidence ON TABLE project_continuity_state TYPE float;
    DEFINE FIELD IF NOT EXISTS source_session_ids ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS supporting_semiote_ids ON TABLE project_continuity_state TYPE array<string>;
    DEFINE FIELD IF NOT EXISTS version ON TABLE project_continuity_state TYPE int;
    DEFINE FIELD IF NOT EXISTS valid_at ON TABLE project_continuity_state TYPE datetime;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE project_continuity_state TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_pcs_user_workspace_project ON TABLE project_continuity_state COLUMNS user_id, workspace_id, project_key UNIQUE;
  `);
  // Rúnir-78sy.8: source_evidence_refs was originally `array<object>`, which a
  // SCHEMAFULL table rejects for ANY non-empty write (varying nested keys —
  // "Found field 'refs[1].at', but no such field exists"). Retyped to a JSON
  // string (the continuity-gap-store.ts `evidence` pattern). This ONE field
  // deviates from the ensure-only IF-NOT-EXISTS convention: `DEFINE FIELD IF
  // NOT EXISTS` will never retype an already-defined field, so OVERWRITE is
  // required to migrate existing definitions. Safe to re-run: OVERWRITE is
  // idempotent and prod is greenfield for this table (no data migration, only
  // the schema retype + legacy in-place normalization below).
  await db.query("DEFINE FIELD OVERWRITE source_evidence_refs ON TABLE project_continuity_state TYPE string;");
  // OVERWRITE retypes the field DEFINITION but leaves any existing
  // `source_evidence_refs: []` array VALUES in place; an unrelated update to
  // such a row then fails ("Expected string but found `[]`"). Idempotent
  // normalization: legacy array-valued rows become the empty-array JSON
  // string. type::is_string is false for the pre-retype array shape and true
  // once normalized, so a re-run touches zero rows.
  await db.query(
    "UPDATE project_continuity_state SET source_evidence_refs = '[]' WHERE !type::is_string(source_evidence_refs);",
  );
}

export async function ensureProjectEnrollmentTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS project_enrollment SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE project_enrollment TYPE string;
    DEFINE FIELD IF NOT EXISTS workspace_id ON TABLE project_enrollment TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE project_enrollment TYPE string;
    DEFINE FIELD IF NOT EXISTS project_id ON TABLE project_enrollment TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS default_namespace_id ON TABLE project_enrollment TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS repo_remote ON TABLE project_enrollment TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS repo_root_fingerprint ON TABLE project_enrollment TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source ON TABLE project_enrollment TYPE string;
    DEFINE FIELD IF NOT EXISTS enrolled_at ON TABLE project_enrollment TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_pe_user_workspace_project ON TABLE project_enrollment COLUMNS user_id, workspace_id, project_key UNIQUE;
    DEFINE INDEX IF NOT EXISTS idx_pe_user ON TABLE project_enrollment COLUMNS user_id;
  `);
}

export async function ensureContinuityBuildStateTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS continuity_build_state SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE continuity_build_state TYPE string;
    DEFINE FIELD IF NOT EXISTS workspace_id ON TABLE continuity_build_state TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE continuity_build_state TYPE string;
    DEFINE FIELD IF NOT EXISTS built_through ON TABLE continuity_build_state TYPE string;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE continuity_build_state TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_cbs_user_workspace_project ON TABLE continuity_build_state COLUMNS user_id, workspace_id, project_key UNIQUE;
  `);
}

// ── Enrollment upsert / list ─────────────────────────────────────────────────

/**
 * Idempotent enrollment upsert keyed by the (user, workspace, project) triple.
 * option<T> fields use the literal NONE in the SET clause when absent — a bound
 * `null` param is coerced to NULL and rejected by the SCHEMAFULL type checker
 * (the logSupersedeShadow gotcha). Returns the persisted row.
 */
export async function upsertProjectEnrollment(
  db: SurrealClient,
  write: ProjectEnrollmentWrite,
): Promise<ProjectEnrollmentRecord> {
  const workspaceId = canonicalizeWorkspaceId(write.workspaceId);
  const recordId = buildProjectEnrollmentRecordId(write.userId, workspaceId, write.projectKey);
  const enrolledAt = write.enrolledAt ?? new Date().toISOString();

  const sets: string[] = [
    "user_id = $userId",
    "workspace_id = $workspaceId",
    "project_key = $projectKey",
    "source = $source",
    "enrolled_at = <datetime>$enrolledAt",
    write.projectId !== undefined ? "project_id = $projectId" : "project_id = NONE",
    write.defaultNamespaceId !== undefined ? "default_namespace_id = $defaultNamespaceId" : "default_namespace_id = NONE",
    write.repoRemote !== undefined ? "repo_remote = $repoRemote" : "repo_remote = NONE",
    write.repoRootFingerprint !== undefined ? "repo_root_fingerprint = $repoRootFingerprint" : "repo_root_fingerprint = NONE",
  ];

  const vars: Record<string, unknown> = {
    recordId,
    userId: write.userId,
    workspaceId,
    projectKey: write.projectKey,
    source: write.source,
    enrolledAt,
  };
  if (write.projectId !== undefined) vars.projectId = write.projectId;
  if (write.defaultNamespaceId !== undefined) vars.defaultNamespaceId = write.defaultNamespaceId;
  if (write.repoRemote !== undefined) vars.repoRemote = write.repoRemote;
  if (write.repoRootFingerprint !== undefined) vars.repoRootFingerprint = write.repoRootFingerprint;

  const results = await db.query<PersistedProjectEnrollmentRow>(
    `UPSERT type::record('project_enrollment', $recordId) SET ${sets.join(", ")} RETURN AFTER;`,
    vars,
  );
  const row = (results[0] ?? [])[0];
  return row
    ? mapEnrollmentRow(row)
    : {
        id: recordId,
        userId: write.userId,
        workspaceId,
        projectKey: write.projectKey,
        projectId: write.projectId,
        defaultNamespaceId: write.defaultNamespaceId,
        repoRemote: write.repoRemote,
        repoRootFingerprint: write.repoRootFingerprint,
        source: write.source,
        enrolledAt,
      };
}

/** Point lookup for ONE (userId, workspaceId, projectKey) enrollment — the
 *  ingestion-path existence check (Rúnir-78sy.9). Computes the deterministic
 *  record id directly rather than listing + filtering (more efficient than
 *  listProjectEnrollments for a single-triple check). */
export async function getProjectEnrollment(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
): Promise<ProjectEnrollmentRecord | null> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const recordId = buildProjectEnrollmentRecordId(userId, workspaceId, projectKey);
  const results = await db.query<PersistedProjectEnrollmentRow>(
    `SELECT id, user_id, workspace_id, project_key, project_id, default_namespace_id, repo_remote, repo_root_fingerprint, source, enrolled_at
       FROM type::record('project_enrollment', $recordId);`,
    { recordId },
  );
  const row = (results[0] ?? [])[0];
  return row ? mapEnrollmentRow(row) : null;
}

/** Lists every enrolled project for a user (the builder's iteration set). */
export async function listProjectEnrollments(db: SurrealClient, userId: string): Promise<ProjectEnrollmentRecord[]> {
  const results = await db.query<PersistedProjectEnrollmentRow>(
    `SELECT id, user_id, workspace_id, project_key, project_id, default_namespace_id, repo_remote, repo_root_fingerprint, source, enrolled_at
       FROM project_enrollment
       WHERE user_id = $userId
       ORDER BY enrolled_at ASC;`,
    { userId },
  );
  return (results[0] ?? []).map(mapEnrollmentRow);
}

// ── Build cursor read / write (dedup_state lexicographic pattern) ────────────

/** Reads built_through (verbatim ISO string) or null when no cursor exists. */
export async function readContinuityBuildCursor(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
): Promise<string | null> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<{ built_through: string }>(
    `SELECT built_through FROM continuity_build_state
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       LIMIT 1;`,
    { userId, workspaceId, projectKey },
  );
  const row = results[0]?.[0];
  return typeof row?.built_through === "string" && row.built_through.length > 0 ? row.built_through : null;
}

/** Advances built_through. Verbatim ISO string, never a datetime round-trip. */
export async function writeContinuityBuildCursor(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
  builtThrough: string,
): Promise<void> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const recordId = buildContinuityBuildStateRecordId(userId, workspaceId, projectKey);
  await db.query(
    `UPSERT type::record('continuity_build_state', $recordId) SET
       user_id = $userId,
       workspace_id = $workspaceId,
       project_key = $projectKey,
       built_through = $builtThrough,
       updated_at = time::now();`,
    { recordId, userId, workspaceId, projectKey, builtThrough },
  );
}

export async function readContinuityBuildState(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
): Promise<ContinuityBuildStateRecord | null> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<PersistedContinuityBuildStateRow>(
    `SELECT user_id, workspace_id, project_key, built_through, updated_at FROM continuity_build_state
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
    builtThrough: row.built_through,
    updatedAt: String(row.updated_at),
  };
}

// ── Continuity-state read ────────────────────────────────────────────────────

/**
 * Reads the canonical continuity row by (user_id, workspace_id, project_key)
 * DIRECTLY — no latest-any fallback (getProjectState's ORDER BY updated_at
 * fallback is a cross-project bleed risk the builder must avoid).
 */
export async function getProjectContinuityState(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
): Promise<ProjectContinuityStateRecord | null> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<PersistedProjectContinuityStateRow>(
    `SELECT * FROM project_continuity_state
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       LIMIT 1;`,
    { userId, workspaceId, projectKey },
  );
  const row = results[0]?.[0];
  return row ? mapContinuityStateRow(row) : null;
}

async function findExistingContinuityVersionedRow(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
): Promise<{ id: string; version: number } | undefined> {
  const workspaceId = canonicalizeWorkspaceId(workspaceIdRaw);
  const results = await db.query<{ id: unknown; version: number | null }>(
    `SELECT id, version FROM project_continuity_state
       WHERE user_id = $userId AND workspace_id = $workspaceId AND project_key = $projectKey
       LIMIT 1;`,
    { userId, workspaceId, projectKey },
  );
  const row = (results[0] ?? [])[0];
  if (row?.id) return { id: extractId(row.id), version: Number(row.version ?? 0) };
  return undefined;
}

// ── CAS write (copies compareAndSwapProjectState, surreal-store.ts:1685-1823) ─

export type ContinuityCasMismatch = {
  ok: false;
  reason: "version_mismatch";
  currentVersion: number;
  recordId?: string;
};

/**
 * Re-reads for a raced row and shapes a version_mismatch result from it,
 * falling back to `fallbackVersion`/`fallbackRecordId` when no row is found.
 * Shared by the two CAS CREATE post-failure sites (Rúnir-78sy.8 simplify S1):
 * the `.catch` discriminator (which additionally rethrows on no-row/re-read
 * failure — the caller's try/catch around this call handles that) and the
 * pre-existing `!created` empty-result fallback (which never throws).
 */
async function reportVersionMismatchFromReRead(
  db: SurrealClient,
  userId: string,
  workspaceIdRaw: string,
  projectKey: string,
  fallbackVersion: number,
  fallbackRecordId: string,
): Promise<ContinuityCasMismatch> {
  const raced = await findExistingContinuityVersionedRow(db, userId, workspaceIdRaw, projectKey);
  return {
    ok: false,
    reason: "version_mismatch",
    currentVersion: raced?.version ?? fallbackVersion,
    recordId: raced?.id ?? fallbackRecordId,
  };
}

/**
 * Compare-and-swap the continuity row. Reads the current {id, version}; a
 * mismatch returns version_mismatch. First write CREATEs with a .catch that
 * RE-READS to discriminate why the create failed (Rúnir-78sy.8 C2): a row
 * existing on re-read means a genuine concurrent writer won the race → report
 * version_mismatch, same as before — never index-name-only error matching. No
 * row existing means the create failed for a non-race reason (e.g. a schema
 * rejection or connection loss) → rethrow the original create error so the
 * caller sees a real error instead of a misleading version_mismatch. If the
 * discriminating re-read itself throws, the original create error is also
 * rethrown rather than synthesizing a fabricated currentVersion=0 CAS loss.
 * Update path is WHERE-guarded (empty result = lost race). valid_at is
 * stamped each successful write; version += 1.
 */
export async function compareAndSwapProjectContinuityState(
  db: SurrealClient,
  write: ProjectContinuityStateWrite & { expectedVersion: number },
): Promise<ProjectContinuityStateRecord | ContinuityCasMismatch> {
  const workspaceId = canonicalizeWorkspaceId(write.workspaceId);
  const current = await findExistingContinuityVersionedRow(db, write.userId, workspaceId, write.projectKey);
  const recordId = current?.id ?? buildProjectContinuityStateRecordId(write.userId, workspaceId, write.projectKey);
  const currentVersion = current?.version ?? 0;

  if (currentVersion !== write.expectedVersion) {
    return { ok: false, reason: "version_mismatch", currentVersion, recordId };
  }

  const now = new Date().toISOString();
  const validAt = write.validAt ?? now;
  const updatedAt = write.updatedAt ?? now;
  const version = currentVersion + 1;

  const content = {
    userId: write.userId,
    workspaceId,
    projectKey: write.projectKey,
    projectId: write.projectId ?? undefined,
    defaultNamespaceId: write.defaultNamespaceId ?? undefined,
    currentFocus: write.currentFocus,
    latestProgress: write.latestProgress,
    nextSteps: write.nextSteps,
    blockers: write.blockers,
    openLoops: write.openLoops,
    unfiledIntentions: write.unfiledIntentions,
    pendingVerification: write.pendingVerification,
    recentlyChangedArtifacts: write.recentlyChangedArtifacts,
    likelyStaleBeads: write.likelyStaleBeads,
    activeAgentRuns: write.activeAgentRuns,
    sourceEvidenceRefs: JSON.stringify(write.sourceEvidenceRefs ?? []),
    confidence: write.confidence,
    sourceSessionIds: write.sourceSessionIds,
    supportingSemioteIds: write.supportingSemioteIds,
    validAt,
    updatedAt,
    version,
    recordId,
  };

  const contentClause = `{
    user_id: $userId,
    workspace_id: $workspaceId,
    project_key: $projectKey,
    project_id: $projectId,
    default_namespace_id: $defaultNamespaceId,
    current_focus: $currentFocus,
    latest_progress: $latestProgress,
    next_steps: $nextSteps,
    blockers: $blockers,
    open_loops: $openLoops,
    unfiled_intentions: $unfiledIntentions,
    pending_verification: $pendingVerification,
    recently_changed_artifacts: $recentlyChangedArtifacts,
    likely_stale_beads: $likelyStaleBeads,
    active_agent_runs: $activeAgentRuns,
    source_evidence_refs: $sourceEvidenceRefs,
    confidence: $confidence,
    source_session_ids: $sourceSessionIds,
    supporting_semiote_ids: $supportingSemioteIds,
    valid_at: <datetime>$validAt,
    updated_at: <datetime>$updatedAt,
    version: <int>$version
  }`;

  if (!current) {
    const createResults = await db
      .query<any>(`CREATE type::record('project_continuity_state', $recordId) CONTENT ${contentClause} RETURN AFTER;`, content)
      .catch(async (createError: unknown) => {
        // Discriminate WHY the create failed (Rúnir-78sy.8 C2): re-read for a
        // raced row. A row existing means a genuine concurrent writer won —
        // report version_mismatch exactly as before. No row existing means the
        // create failed for a non-race reason (schema rejection, connection
        // loss) — rethrow the original error so the caller sees a real error
        // instead of a synthesized, misleading cas_lost/version_mismatch. If
        // the discriminating re-read itself throws, we cannot tell whether a
        // race occurred either — surface the original createError rather than
        // synthesize currentVersion=0 as a fabricated CAS loss.
        let raced: { id: string; version: number } | undefined;
        try {
          raced = await findExistingContinuityVersionedRow(db, write.userId, workspaceId, write.projectKey);
        } catch {
          throw createError;
        }
        if (!raced) throw createError;
        return [[{ __runirVersionMismatch: true, id: raced.id, version: raced.version }]];
      });
    const created = (createResults[0] ?? [])[0];
    if (created?.__runirVersionMismatch) {
      return {
        ok: false,
        reason: "version_mismatch",
        currentVersion: Number(created.version ?? 0),
        recordId: extractId(created.id),
      };
    }
    // Pre-existing empty-result edge case: the real CREATE resolved (no
    // .catch) but RETURN AFTER came back with no row (distinct from the
    // discriminated-race path above, which always either returns a
    // __runirVersionMismatch marker or rethrows). Shares the same
    // re-read-and-shape logic via the S1 helper.
    if (!created) {
      return reportVersionMismatchFromReRead(db, write.userId, workspaceId, write.projectKey, 0, recordId);
    }
  } else {
    const updateResults = await db.query<any>(
      `UPDATE type::record('project_continuity_state', $recordId) SET
         user_id = $userId,
         workspace_id = $workspaceId,
         project_key = $projectKey,
         project_id = $projectId,
         default_namespace_id = $defaultNamespaceId,
         current_focus = $currentFocus,
         latest_progress = $latestProgress,
         next_steps = $nextSteps,
         blockers = $blockers,
         open_loops = $openLoops,
         unfiled_intentions = $unfiledIntentions,
         pending_verification = $pendingVerification,
         recently_changed_artifacts = $recentlyChangedArtifacts,
         likely_stale_beads = $likelyStaleBeads,
         active_agent_runs = $activeAgentRuns,
         source_evidence_refs = $sourceEvidenceRefs,
         confidence = $confidence,
         source_session_ids = $sourceSessionIds,
         supporting_semiote_ids = $supportingSemioteIds,
         valid_at = <datetime>$validAt,
         updated_at = <datetime>$updatedAt,
         version = <int>$version
       WHERE id = type::record('project_continuity_state', $recordId)
         AND (version = $expectedVersion OR (version = NONE AND $expectedVersion = 0))
       RETURN AFTER;`,
      { ...content, expectedVersion: write.expectedVersion },
    );
    const updated = (updateResults[0] ?? [])[0];
    if (!updated) {
      const latest = await findExistingContinuityVersionedRow(db, write.userId, workspaceId, write.projectKey);
      return {
        ok: false,
        reason: "version_mismatch",
        currentVersion: latest?.version ?? currentVersion,
        recordId: latest?.id ?? recordId,
      };
    }
  }

  const { expectedVersion: _expectedVersion, ...writeFields } = write;
  return { ...writeFields, id: recordId, workspaceId, version, validAt, updatedAt };
}
