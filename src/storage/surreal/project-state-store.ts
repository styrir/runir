import { normalizeContinuityDirectives } from "../../continuity/directives.js";
import type {
  MemoryRecordTable,
  MemoryRole,
  ProjectStateRecord,
  ProjectStateWrite,
  SearchHit,
} from "../../domain/memory/types";
import { isContinuityStateMemoryRole, PRIMARY_MEMORY_TABLE } from "../../domain/memory/types";
import type { CanonicalContextIdentity } from "../../identity/canonical-context.js";
import type { SurrealClient } from "./surreal-client.js";
import {
  extractId,
  ACTIVE_MEMORY_FILTER,
  mapMemoryRowToSearchHit,
  projectStateRecordId,
} from "./surreal-client.js";

const CONTINUITY_STATE_ROLE_FILTER = [
  "current_status",
  "session_handoff",
  "debugging_active",
  "planning_active",
].map((role) => `payload.memoryRole = '${role}'`).join(" OR ");

export async function ensureProjectStateTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS project_state SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE project_state TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE project_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS path ON TABLE project_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS current_focus ON TABLE project_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS active_ticket_ids ON TABLE project_state TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS latest_progress ON TABLE project_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS blockers ON TABLE project_state TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS next_steps ON TABLE project_state TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS directives ON TABLE project_state TYPE option<array<object>>;
    DEFINE FIELD IF NOT EXISTS updated_at ON TABLE project_state TYPE datetime;
    DEFINE FIELD IF NOT EXISTS source_session_id ON TABLE project_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS supporting_memory_ids ON TABLE project_state TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS confidence ON TABLE project_state TYPE float;
    DEFINE FIELD IF NOT EXISTS version ON TABLE project_state TYPE int;
    DEFINE FIELD IF NOT EXISTS previous_project_state_id ON TABLE project_state TYPE option<string>;
    DEFINE INDEX IF NOT EXISTS idx_project_state_user_project_key ON TABLE project_state COLUMNS user_id, project_key UNIQUE;
    DEFINE INDEX IF NOT EXISTS idx_project_state_user_path ON TABLE project_state COLUMNS user_id, path UNIQUE;
    DEFINE INDEX IF NOT EXISTS idx_project_state_user_updated ON TABLE project_state COLUMNS user_id, updated_at;
  `);
  await db.query("UPDATE project_state SET version = 1 WHERE version = NONE OR version = NULL;");
}

function projectStateVersion(value: unknown): number {
  return Number(value ?? 1);
}

async function findExistingProjectStateRecordId(
  db: SurrealClient,
  userId: string,
  projectKey?: string,
  path?: string,
): Promise<string | undefined> {
  if (projectKey) {
    const byProjectKey = await db.query<any>(
      `SELECT id
         FROM project_state
         WHERE user_id = $userId AND project_key = $projectKey
         LIMIT 1;`,
      { userId, projectKey },
    );
    const row = (byProjectKey[0] ?? [])[0];
    if (row?.id) return extractId(row.id);
  }

  if (path) {
    const byPath = await db.query<any>(
      `SELECT id
         FROM project_state
         WHERE user_id = $userId AND path = $path
         LIMIT 1;`,
      { userId, path },
    );
    const row = (byPath[0] ?? [])[0];
    if (row?.id) return extractId(row.id);
  }

  return undefined;
}

async function findExistingProjectStateVersionedRow(
  db: SurrealClient,
  userId: string,
  projectKey?: string,
  path?: string,
): Promise<{ id: string; version: number } | undefined> {
  if (projectKey) {
    const byProjectKey = await db.query<any>(
      `SELECT id, version
         FROM project_state
         WHERE user_id = $userId AND project_key = $projectKey
         LIMIT 1;`,
      { userId, projectKey },
    );
    const row = (byProjectKey[0] ?? [])[0];
    if (row?.id) return { id: extractId(row.id), version: projectStateVersion(row.version) };
  }

  if (path) {
    const byPath = await db.query<any>(
      `SELECT id, version
         FROM project_state
         WHERE user_id = $userId AND path = $path
         LIMIT 1;`,
      { userId, path },
    );
    const row = (byPath[0] ?? [])[0];
    if (row?.id) return { id: extractId(row.id), version: projectStateVersion(row.version) };
  }

  return undefined;
}

export async function upsertProjectState(db: SurrealClient, state: ProjectStateWrite): Promise<ProjectStateRecord> {
  const existingRecordId = await findExistingProjectStateRecordId(db, state.userId, state.projectKey, state.path);
  const id = existingRecordId ?? projectStateRecordId(state.userId, { projectKey: state.projectKey, path: state.path });
  const updatedAt = state.updatedAt || new Date().toISOString();
  const version = state.version ?? 1;
  const directives = normalizeContinuityDirectives(state.directives);
  await db.query(
    `UPSERT type::record('project_state', $recordId) CONTENT {
       user_id: $userId,
       project_key: $projectKey,
       path: $path,
       current_focus: $currentFocus,
       active_ticket_ids: $activeTicketIds,
       latest_progress: $latestProgress,
       blockers: $blockers,
       next_steps: $nextSteps,
       directives: $directives,
       updated_at: <datetime>$updatedAt,
       source_session_id: $sourceSessionId,
       supporting_memory_ids: $supportingMemoryIds,
       confidence: $confidence,
       version: <int>$version,
       previous_project_state_id: $previousProjectStateId
     };`,
    {
      recordId: id,
      userId: state.userId,
      projectKey: state.projectKey ?? undefined,
      path: state.path ?? undefined,
      currentFocus: state.currentFocus ?? undefined,
      activeTicketIds: state.activeTicketIds,
      latestProgress: state.latestProgress ?? undefined,
      blockers: state.blockers,
      nextSteps: state.nextSteps,
      directives: directives.length > 0 ? directives : undefined,
      updatedAt,
      sourceSessionId: state.sourceSessionId ?? undefined,
      supportingMemoryIds: state.supportingMemoryIds,
      confidence: state.confidence,
      version,
      previousProjectStateId: state.previousProjectStateId ?? undefined,
    },
  );
  return { ...state, id, updatedAt, version, ...(directives.length > 0 ? { directives } : {}) };
}

/**
 * Re-reads for a raced row and shapes a version_mismatch result from it,
 * falling back to `fallbackVersion`/`fallbackRecordId` when no row is found.
 * Mirrors continuity-state-store.ts's `reportVersionMismatchFromReRead`
 * (Rúnir-78sy.8 S1) — per-store colocation, no cross-store import. Used by
 * the pre-existing `!created` empty-RETURN-AFTER fallback below (which never
 * throws); the `.catch` discriminator keeps its own inline re-read+rethrow
 * logic, same as the sibling.
 */
async function reportProjectStateVersionMismatchFromReRead(
  db: SurrealClient,
  userId: string,
  projectKey: string | undefined,
  path: string | undefined,
  fallbackVersion: number,
  fallbackRecordId: string,
): Promise<{ ok: false; reason: "version_mismatch"; currentVersion: number; recordId?: string }> {
  const raced = await findExistingProjectStateVersionedRow(db, userId, projectKey, path);
  return {
    ok: false,
    reason: "version_mismatch",
    currentVersion: raced?.version ?? fallbackVersion,
    recordId: raced?.id ?? fallbackRecordId,
  };
}

/**
 * Compare-and-swap the project_state row. Reads the current {id, version}; a
 * mismatch returns version_mismatch. First write CREATEs with a .catch that
 * RE-READS to discriminate why the create failed (Rúnir-sfzl, porting
 * 78sy.8 C2): a row existing on re-read means a genuine concurrent writer
 * won the race → report version_mismatch, same as before — never
 * index-name-only error matching. No row existing means the create failed
 * for a non-race reason (e.g. a schema rejection or connection loss) →
 * rethrow the original create error so the caller sees a real error instead
 * of a misleading version_mismatch. If the discriminating re-read itself
 * throws, the original create error is also rethrown rather than
 * synthesizing a fabricated currentVersion=0 CAS loss.
 */
export async function compareAndSwapProjectState(
  db: SurrealClient,
  state: ProjectStateWrite & { expectedVersion: number },
): Promise<ProjectStateRecord | { ok: false; reason: "version_mismatch"; currentVersion: number; recordId?: string }> {
  const current = await findExistingProjectStateVersionedRow(db, state.userId, state.projectKey, state.path);
  const recordId = current?.id ?? projectStateRecordId(state.userId, { projectKey: state.projectKey, path: state.path });
  const currentVersion = current?.version ?? 0;

  if (currentVersion !== state.expectedVersion) {
    return { ok: false, reason: "version_mismatch", currentVersion, recordId };
  }

  const updatedAt = state.updatedAt || new Date().toISOString();
  const version = currentVersion + 1;
  const directives = normalizeContinuityDirectives(state.directives);
  if (!current) {
    const createResults = await db.query<any>(
      `CREATE type::record('project_state', $recordId) CONTENT {
         user_id: $userId,
         project_key: $projectKey,
         path: $path,
         current_focus: $currentFocus,
         active_ticket_ids: $activeTicketIds,
         latest_progress: $latestProgress,
         blockers: $blockers,
         next_steps: $nextSteps,
         directives: $directives,
         updated_at: <datetime>$updatedAt,
         source_session_id: $sourceSessionId,
         supporting_memory_ids: $supportingMemoryIds,
         confidence: $confidence,
         version: <int>$version,
         previous_project_state_id: NONE
       } RETURN AFTER;`,
      {
        recordId,
        userId: state.userId,
        projectKey: state.projectKey ?? undefined,
        path: state.path ?? undefined,
        currentFocus: state.currentFocus ?? undefined,
        activeTicketIds: state.activeTicketIds,
        latestProgress: state.latestProgress ?? undefined,
        blockers: state.blockers,
        nextSteps: state.nextSteps,
        directives: directives.length > 0 ? directives : undefined,
        updatedAt,
        sourceSessionId: state.sourceSessionId ?? undefined,
        supportingMemoryIds: state.supportingMemoryIds,
        confidence: state.confidence,
        version,
      },
    ).catch(async (createError: unknown) => {
      // Discrimination rationale: see the compareAndSwapProjectState JSDoc above.
      let raced: { id: string; version: number } | undefined;
      try {
        raced = await findExistingProjectStateVersionedRow(db, state.userId, state.projectKey, state.path);
      } catch {
        throw createError;
      }
      if (!raced) throw createError;
      return [[{
        __runirVersionMismatch: true,
        id: raced.id,
        version: raced.version,
      }]];
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
    // re-read-and-shape logic via the local helper (S1-parity).
    if (!created) {
      return reportProjectStateVersionMismatchFromReRead(db, state.userId, state.projectKey, state.path, 0, recordId);
    }
  } else {
    const updateResults = await db.query<any>(
      `UPDATE type::record('project_state', $recordId) SET
         user_id = $userId,
         project_key = $projectKey,
         path = $path,
         current_focus = $currentFocus,
         active_ticket_ids = $activeTicketIds,
         latest_progress = $latestProgress,
         blockers = $blockers,
         next_steps = $nextSteps,
         directives = $directives,
         updated_at = <datetime>$updatedAt,
         source_session_id = $sourceSessionId,
         supporting_memory_ids = $supportingMemoryIds,
         confidence = $confidence,
         version = <int>$version,
         previous_project_state_id = $previousProjectStateId
       WHERE id = type::record('project_state', $recordId)
         AND (version = $expectedVersion OR (version = NONE AND $expectedVersion = 1))
       RETURN AFTER;`,
      {
        recordId,
        userId: state.userId,
        projectKey: state.projectKey ?? undefined,
        path: state.path ?? undefined,
        currentFocus: state.currentFocus ?? undefined,
        activeTicketIds: state.activeTicketIds,
        latestProgress: state.latestProgress ?? undefined,
        blockers: state.blockers,
        nextSteps: state.nextSteps,
        directives: directives.length > 0 ? directives : undefined,
        updatedAt,
        sourceSessionId: state.sourceSessionId ?? undefined,
        supportingMemoryIds: state.supportingMemoryIds,
        confidence: state.confidence,
        version,
        previousProjectStateId: recordId,
        expectedVersion: state.expectedVersion,
      },
    );
    const updated = (updateResults[0] ?? [])[0];
    if (!updated) {
      const latest = await findExistingProjectStateVersionedRow(db, state.userId, state.projectKey, state.path);
      return {
        ok: false,
        reason: "version_mismatch",
        currentVersion: latest?.version ?? currentVersion,
        recordId: latest?.id ?? recordId,
      };
    }
  }

  return {
    ...state,
    id: recordId,
    updatedAt,
    version,
    ...(directives.length > 0 ? { directives } : {}),
    previousProjectStateId: current ? recordId : undefined,
  };
}

/** Maps a persisted project_state row → ProjectStateRecord (shared 17-field mapping). */
function mapProjectStateRow(row: any): ProjectStateRecord {
  return {
    id: extractId(row.id),
    userId: row.user_id,
    projectKey: row.project_key ?? undefined,
    path: row.path ?? undefined,
    currentFocus: row.current_focus ?? undefined,
    activeTicketIds: row.active_ticket_ids ?? [],
    latestProgress: row.latest_progress ?? undefined,
    blockers: row.blockers ?? [],
    nextSteps: row.next_steps ?? [],
    directives: normalizeContinuityDirectives(row.directives),
    updatedAt: String(row.updated_at),
    sourceSessionId: row.source_session_id ?? undefined,
    supportingMemoryIds: row.supporting_memory_ids ?? [],
    confidence: Number(row.confidence ?? 0.7),
    version: projectStateVersion(row.version),
    previousProjectStateId: row.previous_project_state_id ? extractId(row.previous_project_state_id) : undefined,
  };
}

export async function getProjectState(
  db: SurrealClient,
  userId: string,
  path?: string,
  projectKey?: string,
): Promise<ProjectStateRecord | null> {
  const mapRow = (row: any): ProjectStateRecord => ({
    id: extractId(row.id),
    userId: row.user_id,
    projectKey: row.project_key ?? undefined,
    path: row.path ?? undefined,
    currentFocus: row.current_focus ?? undefined,
    activeTicketIds: row.active_ticket_ids ?? [],
    latestProgress: row.latest_progress ?? undefined,
    blockers: row.blockers ?? [],
    nextSteps: row.next_steps ?? [],
    directives: normalizeContinuityDirectives(row.directives),
    updatedAt: String(row.updated_at),
    sourceSessionId: row.source_session_id ?? undefined,
    supportingMemoryIds: row.supporting_memory_ids ?? [],
    confidence: Number(row.confidence ?? 0.7),
    version: projectStateVersion(row.version),
    previousProjectStateId: row.previous_project_state_id ? extractId(row.previous_project_state_id) : undefined,
  });

  if (projectKey) {
    const results = await db.query<any>(
      `SELECT id, user_id, project_key, path, current_focus, active_ticket_ids, latest_progress, blockers, next_steps, directives, updated_at, source_session_id, supporting_memory_ids, confidence, version, previous_project_state_id
         FROM project_state
         WHERE user_id = $userId AND project_key = $projectKey
         LIMIT 1;`,
      { userId, projectKey },
    );
    const row = (results[0] ?? [])[0];
    if (row) return mapRow(row);
  }

  if (path) {
    const results = await db.query<any>(
      `SELECT id, user_id, project_key, path, current_focus, active_ticket_ids, latest_progress, blockers, next_steps, directives, updated_at, source_session_id, supporting_memory_ids, confidence, version, previous_project_state_id
         FROM project_state
         WHERE user_id = $userId AND path = $path
         LIMIT 1;`,
      { userId, path },
    );
    const row = (results[0] ?? [])[0];
    return row ? mapRow(row) : null;
  }

  const pathlessSingletonId = projectStateRecordId(userId, { projectKey, path: undefined });
  const pathlessResults = await db.query<any>(
    `SELECT id, user_id, project_key, path, current_focus, active_ticket_ids, latest_progress, blockers, next_steps, directives, updated_at, source_session_id, supporting_memory_ids, confidence, version, previous_project_state_id
       FROM project_state
       WHERE id = type::record('project_state', $singletonId)
       LIMIT 1;`,
    { singletonId: pathlessSingletonId },
  );
  const pathlessRow = (pathlessResults[0] ?? [])[0];
  if (pathlessRow) return mapRow(pathlessRow);

  const latestResults = await db.query<any>(
    `SELECT id, user_id, project_key, path, current_focus, active_ticket_ids, latest_progress, blockers, next_steps, directives, updated_at, source_session_id, supporting_memory_ids, confidence, version, previous_project_state_id
       FROM project_state
       WHERE user_id = $userId
       ORDER BY updated_at DESC
       LIMIT 1;`,
    { userId },
  );
  const latestRow = (latestResults[0] ?? [])[0];
  return latestRow ? mapRow(latestRow) : null;
}

/**
 * STRICT read of the per-turn warmer's `project_state` row by (user_id,
 * project_key) — no path / pathless / latest-any fallback. The continuity
 * builder feeds this fresh warmed state into synthesis and the warmer-merge
 * fallback; the strict lookup (backed by idx_project_state_user_project_key
 * UNIQUE) prevents the cross-project bleed getProjectState's fallbacks would
 * introduce (a caller with only projectKey must never resolve another project's
 * row). project_state has no workspaceId axis — keyed on (userId, projectKey).
 */
export async function getProjectStateByProjectKey(
  db: SurrealClient,
  userId: string,
  projectKey: string,
): Promise<ProjectStateRecord | null> {
  if (!projectKey) return null;
  const results = await db.query<any>(
    `SELECT id, user_id, project_key, path, current_focus, active_ticket_ids, latest_progress, blockers, next_steps, directives, updated_at, source_session_id, supporting_memory_ids, confidence, version, previous_project_state_id
       FROM project_state
       WHERE user_id = $userId AND project_key = $projectKey
       LIMIT 1;`,
    { userId, projectKey },
  );
  const row = (results[0] ?? [])[0];
  return row ? mapProjectStateRow(row) : null;
}

export async function getProjectStateForCaptureContext(
  db: SurrealClient,
  userId: string,
  identity: CanonicalContextIdentity,
): Promise<ProjectStateRecord | null> {
  switch (identity.contextScopeKind) {
    case "session":
    case "project": {
      if (identity.projectKey) {
        const byProjectKey = await db.query<any>(
          `SELECT id, user_id, project_key, path, current_focus, active_ticket_ids, latest_progress, blockers, next_steps, directives, updated_at, source_session_id, supporting_memory_ids, confidence, version, previous_project_state_id
             FROM project_state
             WHERE user_id = $userId AND project_key = $projectKey
             LIMIT 1;`,
          { userId, projectKey: identity.projectKey },
        );
        const row = (byProjectKey[0] ?? [])[0];
        if (row) {
          return {
            id: extractId(row.id),
            userId: row.user_id,
            projectKey: row.project_key ?? undefined,
            path: row.path ?? undefined,
            currentFocus: row.current_focus ?? undefined,
            activeTicketIds: row.active_ticket_ids ?? [],
            latestProgress: row.latest_progress ?? undefined,
            blockers: row.blockers ?? [],
            nextSteps: row.next_steps ?? [],
            directives: normalizeContinuityDirectives(row.directives),
            updatedAt: String(row.updated_at),
            sourceSessionId: row.source_session_id ?? undefined,
            supportingMemoryIds: row.supporting_memory_ids ?? [],
            confidence: Number(row.confidence ?? 0.7),
            version: Number(row.version ?? 1),
            previousProjectStateId: row.previous_project_state_id ? extractId(row.previous_project_state_id) : undefined,
          };
        }
      }

      if (identity.raw.path) {
        const byPath = await db.query<any>(
          `SELECT id, user_id, project_key, path, current_focus, active_ticket_ids, latest_progress, blockers, next_steps, directives, updated_at, source_session_id, supporting_memory_ids, confidence, version, previous_project_state_id
             FROM project_state
             WHERE user_id = $userId AND path = $path
             LIMIT 1;`,
          { userId, path: identity.raw.path },
        );
        const row = (byPath[0] ?? [])[0];
        if (row) {
          return {
            id: extractId(row.id),
            userId: row.user_id,
            projectKey: row.project_key ?? undefined,
            path: row.path ?? undefined,
            currentFocus: row.current_focus ?? undefined,
            activeTicketIds: row.active_ticket_ids ?? [],
            latestProgress: row.latest_progress ?? undefined,
            blockers: row.blockers ?? [],
            nextSteps: row.next_steps ?? [],
            directives: normalizeContinuityDirectives(row.directives),
            updatedAt: String(row.updated_at),
            sourceSessionId: row.source_session_id ?? undefined,
            supportingMemoryIds: row.supporting_memory_ids ?? [],
            confidence: Number(row.confidence ?? 0.7),
            version: Number(row.version ?? 1),
            previousProjectStateId: row.previous_project_state_id ? extractId(row.previous_project_state_id) : undefined,
          };
        }
      }

      return null;
    }
    case "agent":
    default:
      return null;
  }
}

export async function getProjectStateForRecall(
  db: SurrealClient,
  userId: string,
  path?: string,
  projectKey?: string,
): Promise<{ projectState: ProjectStateRecord | null; usedPathFallback: boolean }> {
  if (!path) {
    return { projectState: await getProjectState(db, userId, undefined, projectKey), usedPathFallback: false };
  }
  const exact = await getProjectState(db, userId, path, projectKey);
  if (exact) {
    if (projectKey && exact.projectKey !== projectKey) {
      const migrated = await upsertProjectState(db, { ...exact, projectKey });
      return { projectState: migrated, usedPathFallback: false };
    }
    return { projectState: exact, usedPathFallback: false };
  }
  const pathless = await getProjectState(db, userId, undefined, projectKey);
  return { projectState: pathless, usedPathFallback: pathless !== null };
}

export async function listContinuityMemoryHits(
  db: SurrealClient,
  userId: string,
  options: {
    path?: string;
    limit?: number;
    includeTransitional?: boolean;
    activeOnly?: boolean;
    tableName?: MemoryRecordTable;
  } = {},
): Promise<SearchHit[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const pathClause = options.path ? "AND payload.path = $path" : "";
  const activeClause = options.activeOnly === false ? "" : ACTIVE_MEMORY_FILTER;
  const transitionalClause = options.includeTransitional === false
    ? ""
    : `OR ((payload.memoryRole = NONE OR payload.memoryRole = NULL)
        AND payload.category != NONE
        AND payload.category INSIDE ['entities', 'events']
        AND payload.tier = 'working'
        AND (updated_at > <datetime>$cutoff OR created_at > <datetime>$cutoff))`;
  const results = await db.query<any>(
    // Rúnir-ekos B4 (scout-missed site): defaults to the current-era table.
    `SELECT id, payload, created_at, updated_at, active, inactive_reason, superseded_by, lineage_root_id, valid_at, invalid_at
     FROM ${options.tableName ?? PRIMARY_MEMORY_TABLE}
     WHERE payload.userId = $userId
       ${activeClause}
       ${pathClause}
       AND (invalid_at = NONE OR invalid_at = NULL OR invalid_at > time::now())
       AND ((${CONTINUITY_STATE_ROLE_FILTER}) OR payload.memoryRole = 'recent_work' ${transitionalClause})
     ORDER BY valid_at DESC, updated_at DESC
     LIMIT $limit;`,
    options.path
      ? { userId, path: options.path, limit, cutoff }
      : { userId, limit, cutoff },
  );
  const rows = results[0] ?? [];
  return rows.map((row: any) => mapMemoryRowToSearchHit({ ...row, score: 0 }));
}

export async function invalidateContinuityStateRecords(
  db: SurrealClient,
  params: {
    userId: string;
    path?: string;
    replacementId: string;
    replacementRole: MemoryRole;
    replacementTimestamp?: string;
    tableName?: MemoryRecordTable;
  },
): Promise<void> {
  if (!isContinuityStateMemoryRole(params.replacementRole)) {
    return;
  }
  const now = params.replacementTimestamp ?? new Date().toISOString();
  const pathClause = params.path ? "AND payload.path = $path" : "AND (payload.path = NONE OR payload.path = NULL)";
  const roleClause = params.replacementRole === "session_handoff"
    ? "payload.memoryRole = 'session_handoff'"
    : `(${CONTINUITY_STATE_ROLE_FILTER})`;
  // Rúnir-ekos B4 (scout-missed site): defaults to the current-era table.
  const invalidateTableName = params.tableName ?? PRIMARY_MEMORY_TABLE;
  await db.query(
    `UPDATE ${invalidateTableName} SET
       active = false,
       inactive_at = <datetime>$now,
       inactive_reason = $inactiveReason,
       superseded_by = $replacementId,
       invalid_at = <datetime>$now,
       payload.active = false,
       payload.inactiveAt = $now,
       payload.inactiveReason = $inactiveReason,
       payload.supersededById = $replacementId,
       payload.invalidAt = $now,
       payload.updatedAt = $now,
       updated_at = <datetime>$now
     WHERE payload.userId = $userId
       ${pathClause}
       AND id != type::record('${invalidateTableName}', $replacementId)
       AND (${roleClause})
       AND (active = NONE OR active = true);`,
    {
      userId: params.userId,
      path: params.path ?? undefined,
      replacementId: params.replacementId,
      inactiveReason: "continuity-invalidated",
      now,
    },
  );
}
