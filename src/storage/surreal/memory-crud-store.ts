import type {
  Bm25CorpusStats,
  MemoryLifecycleState,
  MemoryRecordTable,
  MemoryRole,
  MemoryScope,
  SearchHit,
  SimilarCandidate,
  SupersedeProvenance,
  WriteSource,
} from "../../domain/memory/types";
import { PRIMARY_MEMORY_TABLE } from "../../domain/memory/types";
import type { CanonicalContextIdentity } from "../../identity/canonical-context.js";
import type { ScopeFilter } from "../../recall/query/scope-predicate";
import type { SurrealClient } from "./surreal-client.js";
import { extractId, ACTIVE_MEMORY_FILTER, mapMemoryRowToSearchHit } from "./surreal-client.js";

const DEFAULT_ACTIVE_LIFECYCLE: MemoryLifecycleState = {
  active: true,
};

export async function hydrateLatestStateRepresentativeHits(
  db: SurrealClient,
  userId: string,
  args: {
    continuitySubjectKeys?: string[];
    lineageRootIds?: string[];
    scopeFilter?: ScopeFilter;
    tableName?: MemoryRecordTable;
  },
): Promise<SearchHit[]> {
  const continuitySubjectKeys = Array.from(new Set((args.continuitySubjectKeys ?? []).filter(Boolean)));
  const lineageRootIds = Array.from(new Set((args.lineageRootIds ?? []).filter(Boolean)));
  if (continuitySubjectKeys.length === 0 && lineageRootIds.length === 0) {
    return [];
  }

  const tableName = args.tableName ?? "semiote";
  const sf = args.scopeFilter ?? { whereClause: "", vars: {} };
  const identityClauses: string[] = [];
  if (continuitySubjectKeys.length > 0) {
    identityClauses.push("payload.continuitySubjectKey INSIDE $continuitySubjectKeys");
  }
  if (lineageRootIds.length > 0) {
    identityClauses.push("(lineage_root_id INSIDE $lineageRootIds OR payload.lineageRootId INSIDE $lineageRootIds)");
  }

  const results = await db.query<any>(
    `SELECT * FROM ${tableName}
     WHERE (user_id = $userId OR payload.userId = $userId)
       AND (${identityClauses.join(" OR ")})
       AND (active = NONE OR active = true)
       ${sf.whereClause};`,
    {
      userId,
      continuitySubjectKeys,
      lineageRootIds,
      ...sf.vars,
    },
  );

  return (results[0] ?? []).map((row: any) => mapMemoryRowToSearchHit(row));
}

/**
 * Coerce an embedding for storage. A real vector is stored as-is; an empty or
 * absent vector becomes `null` (→ SurrealDB NONE) so the HNSW DIMENSION index —
 * which rejects 0-dimension vectors — simply skips the row instead of erroring on
 * write. Readers map NONE back to [] (e.g. the memory-query fetch path), so
 * downstream array consumers are unaffected.
 */
export function embeddingForStore(
  embedding: readonly number[] | null | undefined,
): number[] | null {
  return Array.isArray(embedding) && embedding.length > 0 ? (embedding as number[]) : null;
}

/**
 * Builds the `UPSERT … CONTENT` statement + bound vars for a memory row WITHOUT
 * executing it, so the upsert can either run on its own ({@link upsertMemory})
 * or be inlined into a larger transaction (supersedeMemory's fresh-id branch,
 * where the upsert and the previous-row inactivation must commit atomically).
 *
 * Every bound param is namespaced by `paramPrefix` so the fragment composes into
 * another statement's transaction body without collision; the default empty
 * prefix reproduces {@link upsertMemory}'s original param names exactly. DML-only
 * (a single UPSERT, no DDL), so it is safe to concatenate into a BEGIN/COMMIT.
 */
export function composeUpsertMemory(
  id: string,
  text: string,
  userId: string,
  embedding: number[],
  metadata: Record<string, unknown> | undefined,
  scope: MemoryScope,
  sessionId: string | undefined,
  lifecycle: MemoryLifecycleState,
  tableName: MemoryRecordTable,
  paramPrefix = "",
): { statement: string; vars: Record<string, unknown> } {
  if (!text || text.trim() === '') {
    throw new Error('upsertMemory: text must be non-empty');
  }
  const now = new Date().toISOString();
  const textNorm = text.toLowerCase().trim();
  const payload: Record<string, unknown> = {
    l2: text,
    userId,
    createdAt: now,
    updatedAt: now,
    source: "memory-hybrid",
    scope,
    sessionId: sessionId ?? undefined,
    active: lifecycle.active,
    inactiveAt: lifecycle.inactiveAt ?? undefined,
    inactiveReason: lifecycle.inactiveReason ?? undefined,
    supersededById: lifecycle.supersededById ?? undefined,
    supersedesId: lifecycle.supersedesId ?? undefined,
    lineageRootId: lifecycle.lineageRootId ?? undefined,
    ...metadata,
  };
  const topLevelPath = typeof payload.path === "string" ? payload.path : undefined;
  const topLevelMemoryRole = typeof payload.memoryRole === "string" ? payload.memoryRole : undefined;
  const topLevelValidAt = typeof payload.validAt === "string" ? payload.validAt : undefined;
  const topLevelInvalidAt = typeof payload.invalidAt === "string" ? payload.invalidAt : undefined;
  const topLevelConfidence = typeof payload.confidence === "number" ? payload.confidence : undefined;
  // MIM-70 guard: if pinnedAt was not explicitly provided in metadata, remove it
  // so UPSERT CONTENT does not overwrite an existing pinnedAt with undefined.
  // Callers must pass pinnedAt in metadata if they want it preserved.
  if (payload['pinnedAt'] === undefined || payload['pinnedAt'] === null) {
    delete payload['pinnedAt'];
  }

  const p = paramPrefix;
  const statement =
    `UPSERT type::record('${tableName}', $${p}recordId) CONTENT {
       embedding: $${p}embedding ?? NONE,
       payload: $${p}payload,
       text_norm: $${p}text_norm,
       created_at: <datetime>$${p}now,
       updated_at: <datetime>$${p}now,
       user_id: $${p}userId,
       scope: $${p}scope,
       session_id: $${p}sessionId,
       path: $${p}path,
       memory_role: $${p}memoryRole,
       valid_at: IF $${p}validAt != NONE THEN <datetime>$${p}validAt ELSE NONE END,
       invalid_at: IF $${p}invalidAt != NONE THEN <datetime>$${p}invalidAt ELSE NONE END,
       confidence: $${p}confidence,
       active: $${p}active,
       inactive_at: $${p}inactiveAt,
       inactive_reason: $${p}inactiveReason,
       superseded_by: $${p}supersededById,
       supersedes: $${p}supersedesId,
       lineage_root_id: $${p}lineageRootId
     };`;
  const vars: Record<string, unknown> = {
    [`${p}recordId`]: id,
    [`${p}embedding`]: embeddingForStore(embedding),
    [`${p}payload`]: payload,
    [`${p}text_norm`]: textNorm,
    [`${p}now`]: now,
    [`${p}userId`]: userId,
    [`${p}scope`]: scope,
    [`${p}sessionId`]: sessionId ?? undefined,
    [`${p}path`]: topLevelPath,
    [`${p}memoryRole`]: topLevelMemoryRole,
    [`${p}validAt`]: topLevelValidAt,
    [`${p}invalidAt`]: topLevelInvalidAt,
    [`${p}confidence`]: topLevelConfidence,
    [`${p}active`]: lifecycle.active,
    [`${p}inactiveAt`]: lifecycle.inactiveAt ?? undefined,
    [`${p}inactiveReason`]: lifecycle.inactiveReason ?? undefined,
    [`${p}supersededById`]: lifecycle.supersededById ?? undefined,
    [`${p}supersedesId`]: lifecycle.supersedesId ?? undefined,
    [`${p}lineageRootId`]: lifecycle.lineageRootId ?? undefined,
  };
  return { statement, vars };
}

/** Inserts or updates a memory row in SurrealDB with explicit id, embedding, and scope metadata. */
export async function upsertMemory(
  db: SurrealClient,
  id: string,
  text: string,
  userId: string,
  embedding: number[],
  metadata?: Record<string, unknown>,
  scope: MemoryScope = "user",
  sessionId?: string,
  lifecycle: MemoryLifecycleState = DEFAULT_ACTIVE_LIFECYCLE,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<string> {
  const { statement, vars } = composeUpsertMemory(
    id,
    text,
    userId,
    embedding,
    metadata,
    scope,
    sessionId,
    lifecycle,
    tableName,
  );
  await db.query(statement, vars);
  return id;
}

/** Lists user memories newest-first, optionally filtered by scope. */
export async function listMemories(
  db: SurrealClient,
  userId: string,
  scopeFilter?: ScopeFilter,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<any[]> {
  const sf = scopeFilter ?? { whereClause: "", vars: {} };
  const results = await db.query<any>(
    `SELECT id, payload, created_at, updated_at FROM ${tableName} WHERE payload.userId = $userId ${ACTIVE_MEMORY_FILTER} ${sf.whereClause} ORDER BY created_at DESC LIMIT 100;`,
    { userId, ...sf.vars },
  );
  return results[0] ?? [];
}

/** Fetches a single user-scoped memory row by sanitized record id. */
export async function getMemoryById(
  db: SurrealClient,
  id: string,
  userId: string,
  tableName: MemoryRecordTable,
): Promise<any[]> {
  const results = await db.query<any>(
    `SELECT id, payload, created_at, updated_at FROM type::record('${tableName}', $id) WHERE payload.userId = $userId ${ACTIVE_MEMORY_FILTER};`,
    { id, userId },
  );
  return results[0] ?? [];
}

/** Forgets one memory id scoped to user, soft-inactivating by default. */
export async function deleteMemoryById(
  db: SurrealClient,
  id: string,
  userId: string,
  mode: "soft-inactivate" | "hard-delete" = "soft-inactivate",
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<void> {
  if (mode === "hard-delete") {
    // Reserved for an explicit compliance/erasure surface in 52e.7; not exposed by default tooling.
    await db.query(
      `DELETE type::record('${tableName}', $id) WHERE payload.userId = $userId;`,
      { id, userId },
    );
    return;
  }

  const now = new Date().toISOString();
  await db.query(
    `UPDATE type::record('${tableName}', $id) SET
       active = false,
       inactive_at = <datetime>$now,
       inactive_reason = $inactiveReason,
       payload.active = false,
       payload.inactiveAt = $now,
       payload.inactiveReason = $inactiveReason,
       payload.updatedAt = $now,
       updated_at = <datetime>$now
     WHERE payload.userId = $userId;`,
    { id, userId, now, inactiveReason: "forgotten" },
  );
}

/** Returns recent user memories in a cutoff time window, optionally filtered by scope. */
export async function listRecentMemories(
  db: SurrealClient,
  userId: string,
  cutoff: string,
  limit: number,
  scopeFilter?: ScopeFilter,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<any[]> {
  const sf = scopeFilter ?? { whereClause: "", vars: {} };
  const results = await db.query<any>(
    `SELECT id, payload, created_at, updated_at FROM ${tableName} WHERE payload.userId = $userId AND created_at > <datetime>$cutoff ${ACTIVE_MEMORY_FILTER} ${sf.whereClause} ORDER BY created_at DESC LIMIT $limit;`,
    { userId, cutoff, limit, ...sf.vars },
  );
  return results[0] ?? [];
}

function buildCaptureContextIdentityClauses(identity: CanonicalContextIdentity): {
  clause: string;
  supported: boolean;
  vars: Record<string, unknown>;
} {
  const clauses: string[] = [];
  const vars: Record<string, unknown> = {};

  switch (identity.contextScopeKind) {
    case "session":
      if (!identity.raw.sessionId) {
        return { clause: "", supported: false, vars: {} };
      }
      clauses.push("AND payload.sessionId = $sessionId");
      vars.sessionId = identity.raw.sessionId;
      if (identity.raw.path) {
        clauses.push("AND payload.path = $path");
        vars.path = identity.raw.path;
      }
      break;
    case "project":
      if (!identity.raw.path) {
        return { clause: "", supported: false, vars: {} };
      }
      clauses.push("AND payload.path = $path");
      vars.path = identity.raw.path;
      break;
    case "agent":
    default:
      return { clause: "", supported: false, vars: {} };
  }

  return {
    clause: clauses.join("\n       "),
    supported: true,
    vars,
  };
}

export async function listRecentFactsForCaptureContext(
  db: SurrealClient,
  userId: string,
  identity: CanonicalContextIdentity,
  opts: { limit?: number; maxAgeHours?: number } = {},
  tableName: MemoryRecordTable = "semiote",
): Promise<SearchHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 10));
  const maxAgeHours = Math.max(1, Math.min(opts.maxAgeHours ?? 72, 24 * 14));
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
  const { clause, supported, vars } = buildCaptureContextIdentityClauses(identity);
  if (!supported) return [];
  const results = await db.query<any>(
    `SELECT id, payload, created_at, updated_at, active, inactive_reason, superseded_by, lineage_root_id, valid_at, invalid_at
     FROM ${tableName}
     WHERE payload.userId = $userId
       ${ACTIVE_MEMORY_FILTER}
       AND (invalid_at = NONE OR invalid_at = NULL OR invalid_at > time::now())
       AND (updated_at > <datetime>$cutoff OR created_at > <datetime>$cutoff)
       ${clause}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $limit;`,
    { userId, cutoff, limit, ...vars },
  );
  return (results[0] ?? []).map((row: any) => mapMemoryRowToSearchHit({ ...row, score: 0 }));
}

export async function listNearbyExistingForCaptureContext(
  db: SurrealClient,
  userId: string,
  identity: CanonicalContextIdentity,
  opts: { limit?: number } = {},
  tableName: MemoryRecordTable = "semiote",
): Promise<SearchHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 10));
  const { clause, supported, vars } = buildCaptureContextIdentityClauses(identity);
  if (!supported) return [];
  const results = await db.query<any>(
    `SELECT id, payload, created_at, updated_at, active, inactive_reason, superseded_by, lineage_root_id, valid_at, invalid_at
     FROM ${tableName}
     WHERE payload.userId = $userId
       ${ACTIVE_MEMORY_FILTER}
       AND (invalid_at = NONE OR invalid_at = NULL OR invalid_at > time::now())
       ${clause}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $limit;`,
    { userId, limit, ...vars },
  );
  return (results[0] ?? []).map((row: any) => mapMemoryRowToSearchHit({ ...row, score: 0 }));
}

/**
 * Finds similar memories for a user using cosine similarity, filtered to a recent time window.
 * Used by write arbitration to detect near-duplicates and merge candidates.
 *
 * 52e.3: This is the DB-level similarity helper feeding the prefilter stage.
 */
export async function findSimilarMemories(
  db: SurrealClient,
  userId: string,
  embedding: number[],
  windowHours: number,
  limit: number,
  scope?: MemoryScope,
  sessionId?: string,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
  // Rúnir-pn1l Q4 U2: optional injected clock for the seeded-replay harness.
  // When omitted (every production caller) this resolves to `Date.now()` at THIS
  // call site — byte-identical to the prior hardcoded `Date.now()`. The seeder
  // passes the replayed row's original `created_at` (ms) so the candidate-pool
  // recency cutoff is anchored to simulated historical time, not the wall clock.
  nowMs?: number,
): Promise<SimilarCandidate[]> {
  const cutoff = new Date((nowMs ?? Date.now()) - windowHours * 3600 * 1000).toISOString();
  const vectorLiteral = JSON.stringify(embedding);
  let scopeClause = "";
  const vars: Record<string, unknown> = { userId, cutoff, limit };

  if (scope === "session") {
    scopeClause = "AND scope = $scope AND session_id = $sessionId";
    vars.scope = scope;
    vars.sessionId = sessionId ?? undefined;
  } else if (scope === "user") {
    scopeClause = "AND (scope = NONE OR scope = $scope)";
    vars.scope = scope;
  } else if (scope === "global") {
    scopeClause = "AND scope = $scope";
    vars.scope = scope;
  }

  const results = await db.query<any>(
    `SELECT id, payload, scope, session_id, memory_role, valid_at, invalid_at, lineage_root_id, vector::similarity::cosine(embedding, ${vectorLiteral}) AS sim, created_at, updated_at
     FROM ${tableName}
     WHERE payload.userId = $userId
       AND embedding != NONE
       ${ACTIVE_MEMORY_FILTER}
       AND (updated_at > <datetime>$cutoff OR created_at > <datetime>$cutoff)
       ${scopeClause}
     ORDER BY sim DESC
     LIMIT $limit;`,
    vars,
  );
  const rows = results[0] ?? [];
  return rows.map((r: any) => ({
    id: extractId(r.id),
    l2: r.payload?.l2 ?? r.payload?.data ?? "",
    text: r.payload?.l2 ?? r.payload?.data ?? "",
    similarity: r.sim ?? 0,
    createdAt: r.payload?.createdAt ?? r.created_at ?? "",
    updatedAt: r.payload?.updatedAt ?? r.updated_at,
    scope: r.scope ?? r.payload?.scope,
    sessionId: r.session_id ?? r.payload?.sessionId,
    memoryRole: r.memory_role ?? r.payload?.memoryRole,
    validAt: r.valid_at ?? r.payload?.validAt,
    invalidAt: r.invalid_at ?? r.payload?.invalidAt,
    lineageRootId: r.lineage_root_id ?? r.payload?.lineageRootId,
    continuitySubjectKey: r.payload?.continuitySubjectKey,
    tags: Array.isArray(r.payload?.tags) ? r.payload.tags : undefined,
    // Rúnir-pn1l.2: durability tier for the supersede temporal/durability guard.
    tier: typeof r.payload?.tier === "string" ? r.payload.tier : undefined,
    // Rúnir-pn1l.13.4: referent-identity keys carried through from the stored
    // payload so proveReferentIdentity's key-equality arms have real data (was
    // silently dropped, forcing empty keys). Mirrors mapMemoryRowToSearchHit's
    // payload-access pattern. Absent payload fields → undefined (never crash).
    factKey: r.payload?.factKey,
    noemaClaimKey: r.payload?.noemaClaimKey,
    atomicFact: r.payload?.atomicFact,
  }));
}

/**
 * Updates an existing memory's text, embedding, and updated_at timestamp.
 * Used by write arbitration merge-update resolution.
 *
 * 52e.3: Preserves the original record's created_at, user_id, scope, and session_id.
 *
 * Rúnir-h435.1 PIN-7 [R1-2, R2-2, R7-3]: `atomicFactAction` is REQUIRED.
 * "clear" appends `payload.atomicFact = NONE` to the SET clause; "retain" leaves
 * the SET clause byte-identical to pre-h435.1 HEAD (never blind-writes the
 * incoming triple onto the merged row).
 */
export async function updateMemoryText(
  db: SurrealClient,
  id: string,
  newText: string,
  embedding: number[],
  writeSource: WriteSource,
  // Rúnir-h435.1 PIN-7: required merge-clear action (computed by mergeAtomicFactAction).
  atomicFactAction: "retain" | "clear",
  continuityMetadata?: {
    memoryRole?: MemoryRole;
    validAt?: string;
    continuitySubjectKey?: string;
  },
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<void> {
  if (!newText || newText.trim() === '') {
    throw new Error('updateMemoryText: newText must be non-empty');
  }
  const now = new Date().toISOString();
  const textNorm = newText.toLowerCase().trim();
  // MIM-70 guard: this function uses SET (not CONTENT), so payload.pinnedAt
  // is never overwritten — it is preserved on the existing record automatically.
  // Rúnir-h435.1 PIN-7: clear appends payload.atomicFact = NONE; retain is byte-identical to HEAD.
  const atomicFactClearClause =
    atomicFactAction === "clear" ? ",\n       payload.atomicFact = NONE" : "";
  await db.query(
    `UPDATE type::record('${tableName}', $recordId) SET
       embedding = $embedding ?? NONE,
       payload.l2 = $newText,
       payload.updatedAt = $now,
       payload.writeSource = $writeSource,
       payload.arbitrationOutcome = $arbitrationOutcome,
       payload.active = true,
       payload.inactiveAt = NONE,
       payload.inactiveReason = NONE,
       payload.invalidAt = NONE,
       payload.memoryRole = $memoryRole,
       payload.validAt = $validAt,
       payload.continuitySubjectKey = $continuitySubjectKey,
       text_norm = $textNorm,
       active = true,
       inactive_at = NONE,
       inactive_reason = NONE,
       invalid_at = NONE,
       memory_role = $memoryRole,
       valid_at = IF $validAt != NONE THEN <datetime>$validAt ELSE NONE END,
       updated_at = <datetime>$now${atomicFactClearClause};`,
    {
      recordId: id,
      embedding: embeddingForStore(embedding),
      newText,
      now,
      writeSource,
      arbitrationOutcome: "merge-update",
      textNorm,
      memoryRole: continuityMetadata?.memoryRole ?? undefined,
      validAt: continuityMetadata?.validAt ?? undefined,
      continuitySubjectKey: continuityMetadata?.continuitySubjectKey ?? undefined,
    },
  );
}

export async function supersedeMemory(
  db: SurrealClient,
  previous: SimilarCandidate,
  replacement: {
    id: string;
    l2?: string;
    text?: string;
    userId: string;
    embedding: number[];
    metadata?: Record<string, unknown>;
    scope: MemoryScope;
    sessionId?: string;
    writeSource: WriteSource;
  },
  supersede_provenance: SupersedeProvenance,
  isInternalCaller?: boolean,
  inactiveReason: string = "superseded",
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
  previousStaleFlags?: { staleSince: string; contradictedBy: string },
): Promise<void> {
  if (replacement.scope === "global" && !isInternalCaller) {
    throw new Error("supersedeMemory: global scope requires isInternalCaller flag");
  }

  // DAG guard: prevent cycles in the supersession chain. Read-only precondition —
  // runs BEFORE BEGIN against the committed snapshot.
  const { wouldCreateCycle } = await import("../../lifecycle/semion/dag-guard.js");
  const hasCycle = await wouldCreateCycle(db as any, replacement.id, previous.id, replacement.userId, tableName);
  if (hasCycle) {
    throw new Error(`supersedeMemory: cycle detected — ${replacement.id} -> ${previous.id} would form a loop`);
  }

  const lineageRootId = previous.lineageRootId ?? previous.id;

  // Existence check (read BEFORE BEGIN): when the replacement row ALREADY EXISTS
  // (consolidation dedup and the staleness pass both supersede onto an existing
  // survivor), stamp ONLY the supersession bookkeeping — the full upsertMemory
  // CONTENT replacement gutted the survivor's payload
  // (confidence/factKey/tier/usefulness/l0/l1…) and falsified its createdAt
  // (Rúnir-xxa9, live-observed on the first real dedup pass 2026-06-11). The
  // arbitration path passes a fresh id and takes the upsert branch.
  const existsResults = await db.query<{ id: string }>(
    `SELECT id FROM type::record('${tableName}', $id);`,
    { id: replacement.id },
  );
  const replacementExists = (existsResults[0] ?? []).length > 0;

  // The branch write + both tail UPDATEs run as ONE atomic transaction so a
  // mid-sequence failure can never leave the previous row inactivated without
  // the replacement bookkept, or vice versa. One consistent timestamp for the
  // whole supersede (was two near-identical new Date()s across separate queries).
  const now = new Date().toISOString();
  const statements: string[] = [];
  const vars: Record<string, unknown> = {
    id: replacement.id,
    prevRecordId: previous.id,
    now,
    lineageRootId,
    userId: replacement.userId,
    provenance: supersede_provenance,
    supersede_provenance,
    inactiveReason,
    supersededById: replacement.id,
  };

  if (replacementExists) {
    statements.push(
      `UPDATE type::record('${tableName}', $id) SET
         supersedes = $prevId,
         lineage_root_id = $lineageRootId,
         updated_at = <datetime>$now,
         payload.supersedesId = $prevId,
         payload.lineageRootId = $lineageRootId,
         payload.updatedAt = $now,
         payload.writeSource = $writeSource,
         payload.arbitrationOutcome = 'supersede',
         payload.supersede_provenance = $provenance
       WHERE payload.userId = $userId;`,
    );
    vars.prevId = previous.id;
    vars.writeSource = replacement.writeSource;
  } else {
    // Fresh id (arbitration path): inline the full upsert so the new row and the
    // previous-row inactivation commit atomically. Prefixed params ("sup_") avoid
    // colliding with the tail-update params below.
    const { statement, vars: upsertVars } = composeUpsertMemory(
      replacement.id,
      replacement.l2 ?? replacement.text ?? "",
      replacement.userId,
      replacement.embedding,
      {
        ...replacement.metadata,
        writeSource: replacement.writeSource,
        arbitrationOutcome: "supersede",
        supersede_provenance,
      },
      replacement.scope,
      replacement.sessionId,
      {
        active: true,
        supersedesId: previous.id,
        lineageRootId,
      },
      tableName,
      "sup_",
    );
    statements.push(statement);
    Object.assign(vars, upsertVars);
  }

  // Tail 1: top-level supersede_provenance on the NEW record (id-only, no user
  // filter — the payload field already landed via the branch write above).
  statements.push(
    `UPDATE type::record('${tableName}', $id) SET supersede_provenance = $provenance;`,
  );

  // Tail 2: inactivate the PREVIOUS row. When previousStaleFlags is provided
  // (staleness-pass caller), also land the queryable staleness fields atomically
  // in the same transaction so they can never be orphaned by a crash between the
  // supersede commit and a separate UPDATE.
  const staleFlagsClause = previousStaleFlags
    ? `,\n       payload.isStale = true,\n       payload.staleSince = $staleSince,\n       payload.contradictedBy = $contradictedBy`
    : "";
  if (previousStaleFlags) {
    vars.staleSince = previousStaleFlags.staleSince;
    vars.contradictedBy = previousStaleFlags.contradictedBy;
  }
  statements.push(
    `UPDATE type::record('${tableName}', $prevRecordId) SET
       active = false,
       inactive_at = <datetime>$now,
       inactive_reason = $inactiveReason,
       superseded_by = $supersededById,
       lineage_root_id = $lineageRootId,
       supersede_provenance = $supersede_provenance,
       payload.active = false,
       payload.inactiveAt = $now,
       payload.inactiveReason = $inactiveReason,
       payload.supersededById = $supersededById,
       payload.lineageRootId = $lineageRootId,
       payload.supersede_provenance = $supersede_provenance,
       payload.updatedAt = $now,
       updated_at = <datetime>$now${staleFlagsClause}
     WHERE payload.userId = $userId;`,
  );

  await db.queryTransaction(statements.join("\n"), vars);
}


export async function restoreMemoryById(
  db: SurrealClient,
  id: string,
  userId: string,
  tableName: MemoryRecordTable,
): Promise<boolean> {
  const now = new Date().toISOString();
  const results = await db.query<any>(
    `UPDATE type::record('${tableName}', $id) SET
       active = true,
       inactive_at = NONE,
       inactive_reason = NONE,
       payload.active = true,
       payload.inactiveAt = NONE,
       payload.inactiveReason = NONE,
       payload.updatedAt = $now,
       updated_at = <datetime>$now
     WHERE payload.userId = $userId AND (active = false OR active = NONE);`,
    { id, userId, now },
  );
  const rows = results[0] ?? [];
  return rows.length > 0;
}

/** Walks the supersession chain for a memory, returning the full lineage. */
export async function getMemoryLineage(
  db: SurrealClient,
  id: string,
  userId: string,
  tableName: MemoryRecordTable,
): Promise<any[]> {
  // First, find the record to get its lineage_root_id
  const seedResults = await db.query<any>(
    `SELECT id, payload, created_at, updated_at, active, inactive_at, inactive_reason, superseded_by, supersedes, lineage_root_id
     FROM type::record('${tableName}', $id)
     WHERE payload.userId = $userId;`,
    { id, userId },
  );
  const seedRows = seedResults[0] ?? [];
  if (seedRows.length === 0) {
    return [];
  }

  const seed = seedRows[0];
  const lineageRootId = seed.lineage_root_id ?? extractId(seed.id);

  // Fetch all records sharing the same lineage root
  const chainResults = await db.query<any>(
    `SELECT id, payload, created_at, updated_at, active, inactive_at, inactive_reason, superseded_by, supersedes, lineage_root_id
     FROM ${tableName}
     WHERE payload.userId = $userId AND (lineage_root_id = $lineageRootId OR id = type::record('${tableName}', $lineageRootId))
     ORDER BY created_at ASC;`,
    { userId, lineageRootId },
  );

  const chainRows = chainResults[0] ?? [];
  return chainRows.map((r: any) => ({
    id: extractId(r.id),
    text: r.payload?.l2 ?? r.payload?.data ?? "",
    active: r.active ?? true,
    createdAt: r.payload?.createdAt ?? r.created_at,
    updatedAt: r.payload?.updatedAt ?? r.updated_at,
    inactiveAt: r.inactive_at ?? r.payload?.inactiveAt,
    inactiveReason: r.inactive_reason ?? r.payload?.inactiveReason,
    supersededBy: r.superseded_by ?? r.payload?.supersededById,
    supersedes: r.supersedes ?? r.payload?.supersedesId,
    lineageRootId: r.lineage_root_id ?? r.payload?.lineageRootId,
  }));
}

/** Returns health stats for a user's memory store. */
export async function getMemoryHealth(
  db: SurrealClient,
  userId: string,
  tableName: MemoryRecordTable,
): Promise<{
  total: number;
  active: number;
  inactive: number;
  oldest: string | null;
  newest: string | null;
  maintenance: {
    lastRunAt: string | null;
    lastDecayPruned: number | null;
    lastPromoted: number | null;
    lastDeduped: number | null;
  };
}> {
  // Verified against SurrealDB v3: `count(predicate)` counts rows where the
  // predicate is truthy. Legacy rows with `active = NONE` satisfy `active = true
  // OR active = NONE` and are intentionally counted as active (matching the
  // ACTIVE_MEMORY_FILTER used in retrieval queries).
  const results = await db.query<any>(
    `SELECT
       count() AS total,
       count(active = true OR active = NONE) AS active_count,
       count(active = false) AS inactive_count,
       math::min(created_at) AS oldest,
       math::max(created_at) AS newest
     FROM ${tableName}
     WHERE payload.userId = $userId
     GROUP ALL;`,
    { userId },
  );
  const row = (results[0] ?? [])[0];

  // MIM-70: Get maintenance stats via sweep_id
  let maintenance: { lastRunAt: string | null; lastDecayPruned: number | null; lastPromoted: number | null; lastDeduped: number | null } = { lastRunAt: null, lastDecayPruned: null, lastPromoted: null, lastDeduped: null };

  try {
    const stateResults = await db.query<any>(
      `SELECT last_sweep_id, last_run_at FROM consolidation_state WHERE user_id = $userId LIMIT 1;`,
      { userId },
    );
    const stateRow = (stateResults[0] ?? [])[0];
    const lastSweepId = stateRow?.last_sweep_id ?? null;
    const lastRunAt = stateRow?.last_run_at ?? null;

    if (lastSweepId) {
      const logResults = await db.query<any>(
        `SELECT
           math::sum(deduped_count) AS total_deduped,
           math::sum(decay_pruned_count) AS total_decay_pruned,
           math::sum(promoted_count) AS total_promoted
         FROM consolidation_log
         WHERE user_id = $userId AND sweep_id = $sweepId
         GROUP ALL;`,
        { userId, sweepId: lastSweepId },
      );
      const logRow = (logResults[0] ?? [])[0];
      maintenance = {
        lastRunAt: lastRunAt ? String(lastRunAt) : null,
        lastDecayPruned: logRow?.total_decay_pruned != null ? Number(logRow.total_decay_pruned) : null,
        lastPromoted: logRow?.total_promoted != null ? Number(logRow.total_promoted) : null,
        lastDeduped: logRow?.total_deduped != null ? Number(logRow.total_deduped) : null,
      };
    } else if (lastRunAt) {
      maintenance = { lastRunAt: String(lastRunAt), lastDecayPruned: null, lastPromoted: null, lastDeduped: null };
    }
  } catch {
    // Maintenance stats are non-critical, fail gracefully
  }

  if (!row) {
    return { total: 0, active: 0, inactive: 0, oldest: null, newest: null, maintenance };
  }
  return {
    total: Number(row.total ?? 0),
    active: Number(row.active_count ?? 0),
    inactive: Number(row.inactive_count ?? 0),
    oldest: row.oldest ?? undefined,
    newest: row.newest ?? undefined,
    maintenance,
  };
}

/** Loads and caches BM25 corpus statistics for one user. */
export async function getBm25CorpusStats(
  db: SurrealClient,
  userId: string,
  cache: Map<string, Bm25CorpusStats>,
  ttlMs: number,
  tableName: MemoryRecordTable,
): Promise<Bm25CorpusStats> {
  const now = Date.now();
  const cacheKey = `${tableName}:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.refreshedAtMs < ttlMs) {
    return cached;
  }

    const results = await db.query<any>(
      `SELECT count() AS total_docs, math::mean(array::len(string::split(text_norm, ' '))) AS avg_doc_length FROM ${tableName} WHERE payload.userId = $userId AND text_norm != NONE ${ACTIVE_MEMORY_FILTER} GROUP ALL;`,
      { userId },
    );
  const row = (results[0] ?? [])[0] ?? {};
  const totalDocs = Number(row.total_docs ?? 0);
  const avgDocLengthRaw = Number(row.avg_doc_length ?? 0);
  const stats: Bm25CorpusStats = {
    totalDocs,
    avgDocLength:
      Number.isFinite(avgDocLengthRaw) && avgDocLengthRaw > 0
        ? avgDocLengthRaw
        : 1,
    refreshedAtMs: now,
  };
  cache.set(cacheKey, stats);
  return stats;
}

/**
 * Fetches a paginated batch of all active memories for a userId/scope pair.
 * Used by the consolidation sweep dedup step.
 * @param limit - batch size (default 50)
 * @param offset - pagination offset (default 0)
 */
export async function fetchAllActiveMemoriesForScope(
  db: SurrealClient,
  userId: string,
  scope: string,
  limit: number = 50,
  offset: number = 0,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<Array<{ id: string; l2: string; similarity: number; createdAt: string; updatedAt?: string; scope?: string; sessionId?: string; embedding: number[] }>> {
  // embedding rides along so the consolidation dedup sweep compares STORED
  // vectors instead of re-embedding every pair (Rúnir-x46j: the O(n²)
  // embedText loop made user-scope runs unbounded).
  const results = await db.query<{
    id: string;
    embedding?: number[];
    payload: { l2: string; createdAt: string; updatedAt?: string; scope?: string; sessionId?: string };
  }>(
    `SELECT id, payload, embedding FROM ${tableName}
     WHERE payload.userId = $userId
     AND payload.scope = $scope
     AND (active = NONE OR active = true)
     LIMIT $limit
     START $offset;`,
    { userId, scope, limit, offset },
  );
  const rows = results[0] ?? [];
  return rows.map((r) => ({
    // extractId, NOT String(): String(RecordId) yields 'semiote:uuid', which
    // supersedeMemory re-prefixes via type::record into a phantom record id.
    id: extractId(r.id),
    l2: r.payload?.l2 ?? (r.payload as any)?.data ?? "",
    similarity: 0,
    createdAt: r.payload?.createdAt ?? new Date().toISOString(),
    updatedAt: r.payload?.updatedAt,
    scope: r.payload?.scope,
    sessionId: r.payload?.sessionId,
    embedding: Array.isArray(r.embedding) ? r.embedding : [],
  }));
}

/**
 * Soft-archives inactive memories older than the given cutoff ISO timestamp.
 * Sets archived = true on matching records. NO hard-delete — AGENTS.md policy.
 * Returns count of records archived.
 */
export async function softArchiveInactiveOlderThan(
  db: SurrealClient,
  userId: string,
  scope: string,
  cutoffIso: string,
  tableName: MemoryRecordTable,
): Promise<number> {
  // Fetch IDs first to count, then update
  const fetchResults = await db.query<{ id: string }>(
    `SELECT id FROM ${tableName}
     WHERE payload.userId = $userId
     AND payload.scope = $scope
     AND active = false
     AND inactive_at < <datetime>$cutoff
     AND (archived = NONE OR archived = false);`,
    { userId, scope, cutoff: cutoffIso },
  );
  const ids = (fetchResults[0] ?? []).map((r) => r.id);
  if (ids.length === 0) return 0;

  await db.query(
    `UPDATE ${tableName} SET archived = true, updated_at = time::now()
     WHERE payload.userId = $userId
     AND payload.scope = $scope
     AND active = false
     AND inactive_at < <datetime>$cutoff
     AND (archived = NONE OR archived = false);`,
    { userId, scope, cutoff: cutoffIso },
  );
  return ids.length;
}


export async function queryTopMemoriesForNovelty(
  db: SurrealClient,
  userId: string,
  scope: string,
  sessionKey: string,
  embedding: number[],
  K: number = 10,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<number[]> {
  try {
    const vectorLiteral = JSON.stringify(embedding);
    const results = await db.query<{ similarity: number }>(
      `SELECT vector::similarity::cosine(embedding, ${vectorLiteral}) AS similarity
       FROM ${tableName}
       WHERE payload.userId = $userId
         AND payload.scope = $scope
         AND payload.scope != 'global'
         AND payload.sessionId != $sessionKey
         AND payload.active = true
       ORDER BY similarity DESC
       LIMIT $K;`,
      { userId, scope, sessionKey, K },
    );
    const rows = results[0] ?? [];
    return rows.map((r) => r.similarity ?? 0);
  } catch (err) {
    console.warn("queryTopMemoriesForNovelty: query failed, returning []:", err);
    return [];
  }
}


export async function backfillHasPath(db: SurrealClient): Promise<number> {
  const result = await db.query<any>(
    `UPDATE memories SET payload.hasPath = (payload.path != NONE) WHERE payload.hasPath = NONE RETURN NONE;
     SELECT count() FROM memories WHERE payload.hasPath != NONE GROUP ALL;`,
    {},
  );
  return result[1]?.[0]?.count ?? 0;
}
