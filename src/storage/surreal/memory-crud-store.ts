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
import {
  ProducerPolicyRefusalError,
  runWithMintedProcessingLineage,
  type MintedProcessingLineage,
  type ProducerAuthority,
} from "../../app/processing-policy/authority.js";
import {
  classifyProcessingLineage,
  conservativeJoinProcessingLineage,
  type ProcessingLineageV1,
} from "../../domain/memory/processing-lineage.js";
import { SurrealClient } from "./surreal-client.js";
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
function composeMemoryRecord(
  operation: "UPSERT" | "CREATE ONLY",
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
  processingLineage?: ProcessingLineageV1,
  supersedeProvenance?: SupersedeProvenance,
  nowOverride?: string,
): { statement: string; vars: Record<string, unknown> } {
  if (!text || text.trim() === '') {
    throw new Error('upsertMemory: text must be non-empty');
  }
  const now = nowOverride ?? new Date().toISOString();
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
  // Caller metadata is never an authority source and cannot place lineage in
  // the payload. Protected creation adds the canonical value at the top level.
  delete payload.processing_lineage;
  if (processingLineage) {
    // Protected content and lifecycle facts are writer arguments, never
    // metadata. Keep unrelated metadata (tags, category, etc.) intact.
    Object.assign(payload, {
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
    });
  }
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
  const processingLineageClause = processingLineage
    ? `,\n       processing_lineage: $${p}processingLineage`
    : "";
  const supersedeProvenanceClause = supersedeProvenance
    ? `,\n       supersede_provenance: $${p}supersedeProvenance`
    : "";
  const absentLineageWhere = operation === "UPSERT" ? " WHERE processing_lineage = NONE" : "";
  const statement =
    `${operation} type::record('${tableName}', $${p}recordId) CONTENT {
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
       lineage_root_id: $${p}lineageRootId${processingLineageClause}${supersedeProvenanceClause}
     }${absentLineageWhere};`;
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
  if (processingLineage) vars[`${p}processingLineage`] = processingLineage;
  if (supersedeProvenance) vars[`${p}supersedeProvenance`] = supersedeProvenance;
  return { statement, vars };
}

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
  return composeMemoryRecord(
    "UPSERT",
    id,
    text,
    userId,
    embedding,
    metadata,
    scope,
    sessionId,
    lifecycle,
    tableName,
    paramPrefix,
  );
}

function composeProtectedCreateMemory(
  id: string,
  text: string,
  userId: string,
  embedding: number[],
  metadata: Record<string, unknown> | undefined,
  scope: MemoryScope,
  sessionId: string | undefined,
  lifecycle: MemoryLifecycleState,
  tableName: MemoryRecordTable,
  lineage: ProcessingLineageV1,
  paramPrefix = "",
  nowOverride?: string,
): { statement: string; vars: Record<string, unknown> } {
  return composeMemoryRecord(
    "CREATE ONLY",
    id,
    text,
    userId,
    embedding,
    metadata,
    scope,
    sessionId,
    lifecycle,
    tableName,
    paramPrefix,
    lineage,
    undefined,
    nowOverride,
  );
}

function composeGenericCreateMemory(
  id: string,
  text: string,
  userId: string,
  embedding: number[],
  metadata: Record<string, unknown> | undefined,
  scope: MemoryScope,
  sessionId: string | undefined,
  lifecycle: MemoryLifecycleState,
  tableName: MemoryRecordTable,
  supersedeProvenance: SupersedeProvenance,
  paramPrefix = "",
): { statement: string; vars: Record<string, unknown> } {
  return composeMemoryRecord(
    "CREATE ONLY",
    id,
    text,
    userId,
    embedding,
    metadata,
    scope,
    sessionId,
    lifecycle,
    tableName,
    paramPrefix,
    undefined,
    supersedeProvenance,
  );
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
  const result = await db.query(statement, vars);
  if (db instanceof SurrealClient && Array.isArray(result[0]) && result[0].length === 0) {
    // The guarded UPSERT matched an existing row with present lineage. The
    // database correctly performed no update; surface that no-op as a
    // content-free refusal so callers do not emit a false commit/overlay.
    throw new ProducerPolicyRefusalError("lineage_present");
  }
  return id;
}

export type ProtectedMemoryCreateInput = Readonly<{
  id: string;
  text: string;
  userId: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  scope?: MemoryScope;
  sessionId?: string;
  lifecycle?: MemoryLifecycleState;
  tableName?: MemoryRecordTable;
}>;

/**
 * Creates one protected Minni row using the exact private-map mint result.
 * CREATE ONLY makes every id collision a transaction error; it never rewrites
 * an existing row. The canonical lineage is written beside payload/content and
 * lifecycle fields in the same queryTransaction.
 */
export async function createMemoryWithProcessingLineage(
  db: SurrealClient,
  authority: ProducerAuthority,
  minted: MintedProcessingLineage | unknown,
  input: ProtectedMemoryCreateInput,
): Promise<string> {
  const result = await runWithMintedProcessingLineage(
    authority,
    minted,
    async (lineage) => {
      const { statement, vars } = composeProtectedCreateMemory(
        input.id,
        input.text,
        input.userId,
        input.embedding,
        input.metadata,
        input.scope ?? "user",
        input.sessionId,
        input.lifecycle ?? DEFAULT_ACTIVE_LIFECYCLE,
        input.tableName ?? PRIMARY_MEMORY_TABLE,
        lineage,
      );
      await db.queryTransaction(statement, vars);
    },
    { targetUserId: input.userId },
  );
  if (!result.ok) throw new ProducerPolicyRefusalError(result.reason);
  return input.id;
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
       AND processing_lineage = NONE
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

type ProtectedMemoryMergeInput = Readonly<{
  id: string;
  userId: string;
  newText: string;
  embedding: number[];
  writeSource: WriteSource;
  atomicFactAction: "retain" | "clear";
  continuityMetadata?: {
    memoryRole?: MemoryRole;
    validAt?: string;
    continuitySubjectKey?: string;
  };
  tableName?: MemoryRecordTable;
}>;

type ProtectedMemoryMergePreflight = Readonly<{
  expectedUserId: string;
  expectedProcessingLineage: unknown;
  mergedProcessingLineage: ProcessingLineageV1;
}>;

function refusalForStoredLineage(
  storedValue: unknown,
  incomingLineage: ProcessingLineageV1,
): { expectedProcessingLineage: unknown; mergedProcessingLineage: ProcessingLineageV1 } {
  const stored = classifyProcessingLineage(storedValue);
  const joined = conservativeJoinProcessingLineage(
    stored,
    { state: "minni_verified", lineage: incomingLineage },
  );
  if (!joined.ok) throw new ProducerPolicyRefusalError("lineage_invalid");
  return {
    // Keep the exact persisted snapshot for the transaction CAS. The parsed
    // value above is used only for strict compatibility and the monotonic join;
    // a normalized surrogate must not hide a concurrent stored-field change.
    expectedProcessingLineage: storedValue,
    mergedProcessingLineage: joined.lineage,
  };
}

function composeProtectedMergeMemory(
  input: ProtectedMemoryMergeInput,
  preflight: ProtectedMemoryMergePreflight,
): { statement: string; vars: Record<string, unknown> } {
  if (!input.newText || input.newText.trim() === '') {
    throw new Error("mergeMemoryWithProcessingLineage: newText must be non-empty");
  }
  const now = new Date().toISOString();
  const textNorm = input.newText.toLowerCase().trim();
  const atomicFactClearClause = input.atomicFactAction === "clear"
    ? ",\n       payload.atomicFact = NONE"
    : "";
  const statement = `
    LET $mergeRows = (
      UPDATE type::record('${input.tableName ?? PRIMARY_MEMORY_TABLE}', $recordId) SET
        processing_lineage = $mergedProcessingLineage,
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
        updated_at = <datetime>$now${atomicFactClearClause}
      WHERE user_id = $expectedUserId
        AND processing_lineage = $expectedProcessingLineage
      RETURN VALUE id
    );
    IF array::len($mergeRows) != 1 {
      THROW "processing lineage compare-and-set failed";
    };
  `;
  return {
    statement,
    vars: {
      recordId: input.id,
      expectedUserId: preflight.expectedUserId,
      expectedProcessingLineage: preflight.expectedProcessingLineage,
      mergedProcessingLineage: preflight.mergedProcessingLineage,
      embedding: embeddingForStore(input.embedding),
      newText: input.newText,
      now,
      writeSource: input.writeSource,
      arbitrationOutcome: "merge-update",
      textNorm,
      memoryRole: input.continuityMetadata?.memoryRole ?? undefined,
      validAt: input.continuityMetadata?.validAt ?? undefined,
      continuitySubjectKey: input.continuityMetadata?.continuitySubjectKey ?? undefined,
    },
  };
}

/**
 * Merges a known protected row after exact Sourceb-A authority revalidation.
 * The first authority seam admits a lineage-only preflight; the second seam
 * runs immediately before the guarded transaction, so a revoked or changed
 * registration cannot reuse a successful pre-read. No content is selected
 * during preflight.
 */
export async function mergeMemoryWithProcessingLineage(
  db: SurrealClient,
  authority: ProducerAuthority,
  minted: MintedProcessingLineage | unknown,
  input: ProtectedMemoryMergeInput,
): Promise<void> {
  const tableName = input.tableName ?? PRIMARY_MEMORY_TABLE;
  const preflightResult = await runWithMintedProcessingLineage(
    authority,
    minted,
    async (incomingLineage, context): Promise<ProtectedMemoryMergePreflight> => {
      const results = await db.query<{
        id: unknown;
        user_id: unknown;
        processing_lineage: unknown;
      }>(
        `SELECT id, user_id, processing_lineage FROM type::record('${tableName}', $recordId);`,
        { recordId: input.id },
      );
      const rows = results[0] ?? [];
      if (rows.length !== 1) throw new ProducerPolicyRefusalError("lineage_invalid");
      const row = rows[0];
      if (row.user_id !== context.targetUserId || row.user_id !== input.userId) {
        throw new ProducerPolicyRefusalError("lineage_invalid");
      }
      const compatible = refusalForStoredLineage(row.processing_lineage, incomingLineage);
      return {
        expectedUserId: context.targetUserId,
        expectedProcessingLineage: compatible.expectedProcessingLineage,
        mergedProcessingLineage: compatible.mergedProcessingLineage,
      };
    },
    { targetUserId: input.userId },
  );
  if (!preflightResult.ok) throw new ProducerPolicyRefusalError(preflightResult.reason);

  const { statement, vars } = composeProtectedMergeMemory(input, preflightResult.value);
  const transactionResult = await runWithMintedProcessingLineage(
    authority,
    minted,
    async () => db.queryTransaction(statement, vars),
    { targetUserId: input.userId },
  );
  if (!transactionResult.ok) throw new ProducerPolicyRefusalError(transactionResult.reason);
}

type ProtectedSupersedeReplacement = Readonly<{
  id: string;
  l2?: string;
  text?: string;
  userId: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  scope: MemoryScope;
  sessionId?: string;
  writeSource: WriteSource;
}>;

export type ProtectedMemorySupersedeInput = Readonly<{
  previousId: string;
  replacement: ProtectedSupersedeReplacement;
  supersedeProvenance: SupersedeProvenance;
  inactiveReason?: string;
  tableName?: MemoryRecordTable;
  previousStaleFlags?: { staleSince: string; contradictedBy: string };
}>;

type SupersedeMetadataSnapshot = Readonly<{
  id: unknown;
  user_id: unknown;
  payload_user_id: unknown;
  processing_lineage: unknown;
  active: unknown;
  supersedes: unknown;
  superseded_by: unknown;
  lineage_root_id: unknown;
  inactive_at: unknown;
  inactive_reason: unknown;
  supersede_provenance: unknown;
  updated_at: unknown;
  payload_active: unknown;
  payload_inactive_at: unknown;
  payload_inactive_reason: unknown;
  payload_superseded_by_id: unknown;
  payload_supersedes_id: unknown;
  payload_lineage_root_id: unknown;
  payload_supersede_provenance: unknown;
  payload_updated_at: unknown;
  payload_write_source: unknown;
  payload_arbitration_outcome: unknown;
  payload_is_stale: unknown;
  payload_stale_since: unknown;
  payload_contradicted_by: unknown;
}>;

type ProtectedSupersedePreflight = Readonly<{
  previous: SupersedeMetadataSnapshot;
  replacement?: SupersedeMetadataSnapshot;
  mergedProcessingLineage: ProcessingLineageV1;
  lineageRootId: string;
}>;

function classifyAndJoinSupersedeLineage(
  incomingLineage: ProcessingLineageV1,
  storedValues: readonly unknown[],
): ProcessingLineageV1 {
  let joined: ProcessingLineageV1 = incomingLineage;
  for (const storedValue of storedValues) {
    const result = conservativeJoinProcessingLineage(
      { state: "minni_verified", lineage: joined },
      classifyProcessingLineage(storedValue),
    );
    if (!result.ok) throw new ProducerPolicyRefusalError("lineage_invalid");
    joined = result.lineage;
  }
  return joined;
}

function snapshotPresent(rows: readonly SupersedeMetadataSnapshot[]): SupersedeMetadataSnapshot | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}

function supersedeMetadataSelect(tableName: MemoryRecordTable): string {
  // This projection is deliberately metadata-only. It is used for authority,
  // CAS, and outcome reconciliation; it must never expose payload text or
  // embeddings to the protected supersede control flow.
  return `SELECT id, user_id, payload.userId AS payload_user_id, processing_lineage,
                 active, supersedes, superseded_by, lineage_root_id, inactive_at,
                 inactive_reason, supersede_provenance, updated_at,
                 payload.active AS payload_active,
                 payload.inactiveAt AS payload_inactive_at,
                 payload.inactiveReason AS payload_inactive_reason,
                 payload.supersededById AS payload_superseded_by_id,
                 payload.supersedesId AS payload_supersedes_id,
                 payload.lineageRootId AS payload_lineage_root_id,
                 payload.supersede_provenance AS payload_supersede_provenance,
                 payload.updatedAt AS payload_updated_at,
                 payload.writeSource AS payload_write_source,
                 payload.arbitrationOutcome AS payload_arbitration_outcome,
                 payload.isStale AS payload_is_stale,
                 payload.staleSince AS payload_stale_since,
                 payload.contradictedBy AS payload_contradicted_by
          FROM type::record('${tableName}', $recordId);`;
}

async function readSupersedeMetadata(
  db: SurrealClient,
  tableName: MemoryRecordTable,
  recordId: string,
): Promise<SupersedeMetadataSnapshot | undefined> {
  const result = await db.query<SupersedeMetadataSnapshot>(
    supersedeMetadataSelect(tableName),
    { recordId },
  );
  return snapshotPresent(result[0] ?? []);
}

function sameSupersedeBranchWhere(prefix: string, row: SupersedeMetadataSnapshot): string {
  const expected = (field: string, suffix: string, value: unknown): string =>
    value === undefined ? `${field} = NONE` : `${field} = $${prefix}${suffix}`;
  const payloadExpected = (field: string, suffix: string, value: unknown): string =>
    value === undefined ? `${field} = NONE` : `${field} = $${prefix}${suffix}`;
  return `user_id = $${prefix}UserId
        AND ${payloadExpected("payload.userId", "PayloadUserId", row.payload_user_id)}
        AND processing_lineage = $${prefix}ProcessingLineage
        AND ${expected("active", "Active", row.active)}
        AND ${expected("supersedes", "Supersedes", row.supersedes)}
        AND ${expected("superseded_by", "SupersededBy", row.superseded_by)}
        AND ${expected("lineage_root_id", "LineageRootId", row.lineage_root_id)}
        AND ${expected("inactive_at", "InactiveAt", row.inactive_at)}
        AND ${expected("inactive_reason", "InactiveReason", row.inactive_reason)}
        AND ${expected("supersede_provenance", "SupersedeProvenance", row.supersede_provenance)}
        AND ${expected("updated_at", "UpdatedAt", row.updated_at)}
        AND ${payloadExpected("payload.active", "PayloadActive", row.payload_active)}
        AND ${payloadExpected("payload.inactiveAt", "PayloadInactiveAt", row.payload_inactive_at)}
        AND ${payloadExpected("payload.inactiveReason", "PayloadInactiveReason", row.payload_inactive_reason)}
        AND ${payloadExpected("payload.supersededById", "PayloadSupersededById", row.payload_superseded_by_id)}
        AND ${payloadExpected("payload.supersedesId", "PayloadSupersedesId", row.payload_supersedes_id)}
        AND ${payloadExpected("payload.lineageRootId", "PayloadLineageRootId", row.payload_lineage_root_id)}
        AND ${payloadExpected("payload.supersede_provenance", "PayloadSupersedeProvenance", row.payload_supersede_provenance)}
        AND ${payloadExpected("payload.updatedAt", "PayloadUpdatedAt", row.payload_updated_at)}
        AND ${payloadExpected("payload.writeSource", "PayloadWriteSource", row.payload_write_source)}
        AND ${payloadExpected("payload.arbitrationOutcome", "PayloadArbitrationOutcome", row.payload_arbitration_outcome)}
        AND ${payloadExpected("payload.isStale", "PayloadIsStale", row.payload_is_stale)}
        AND ${payloadExpected("payload.staleSince", "PayloadStaleSince", row.payload_stale_since)}
        AND ${payloadExpected("payload.contradictedBy", "PayloadContradictedBy", row.payload_contradicted_by)}`;
}

function snapshotVars(
  prefix: string,
  row: SupersedeMetadataSnapshot,
): Record<string, unknown> {
  return {
    [`${prefix}UserId`]: row.user_id,
    [`${prefix}PayloadUserId`]: row.payload_user_id,
    [`${prefix}ProcessingLineage`]: row.processing_lineage,
    [`${prefix}Active`]: row.active,
    [`${prefix}Supersedes`]: row.supersedes,
    [`${prefix}SupersededBy`]: row.superseded_by,
    [`${prefix}LineageRootId`]: row.lineage_root_id,
    [`${prefix}InactiveAt`]: row.inactive_at,
    [`${prefix}InactiveReason`]: row.inactive_reason,
    [`${prefix}SupersedeProvenance`]: row.supersede_provenance,
    [`${prefix}UpdatedAt`]: row.updated_at,
    [`${prefix}PayloadActive`]: row.payload_active,
    [`${prefix}PayloadInactiveAt`]: row.payload_inactive_at,
    [`${prefix}PayloadInactiveReason`]: row.payload_inactive_reason,
    [`${prefix}PayloadSupersededById`]: row.payload_superseded_by_id,
    [`${prefix}PayloadSupersedesId`]: row.payload_supersedes_id,
    [`${prefix}PayloadLineageRootId`]: row.payload_lineage_root_id,
    [`${prefix}PayloadSupersedeProvenance`]: row.payload_supersede_provenance,
    [`${prefix}PayloadUpdatedAt`]: row.payload_updated_at,
    [`${prefix}PayloadWriteSource`]: row.payload_write_source,
    [`${prefix}PayloadArbitrationOutcome`]: row.payload_arbitration_outcome,
    [`${prefix}PayloadIsStale`]: row.payload_is_stale,
    [`${prefix}PayloadStaleSince`]: row.payload_stale_since,
    [`${prefix}PayloadContradictedBy`]: row.payload_contradicted_by,
  };
}

function canonicalMetadataValue(value: unknown): string {
  if (value === undefined) return "<NONE>";
  if (value === null) return "<NULL>";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && "toJSON" in value && typeof value.toJSON === "function") {
    return canonicalMetadataValue(value.toJSON());
  }
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if ("id" in value && (value as { id?: unknown }).id !== undefined) {
      return `<record:${extractId(value)}>`;
    }
    try {
      return JSON.stringify(value, (_key, nested) => {
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
        return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
      });
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function sameMetadataValue(left: unknown, right: unknown): boolean {
  const leftCanonical = canonicalMetadataValue(left);
  const rightCanonical = canonicalMetadataValue(right);
  if (leftCanonical === rightCanonical) return true;
  if (left && typeof left === "object" && "id" in left && typeof right === "string") {
    return extractId(left) === extractId(right);
  }
  if (right && typeof right === "object" && "id" in right && typeof left === "string") {
    return extractId(right) === extractId(left);
  }
  return false;
}

function sameSupersedeSnapshot(left: SupersedeMetadataSnapshot | undefined, right: SupersedeMetadataSnapshot | undefined): boolean {
  if (!left || !right) return left === right;
  return sameMetadataValue(left.id, right.id)
    && sameMetadataValue(left.user_id, right.user_id)
    && sameMetadataValue(left.payload_user_id, right.payload_user_id)
    && sameMetadataValue(left.processing_lineage, right.processing_lineage)
    && sameMetadataValue(left.active, right.active)
    && sameMetadataValue(left.supersedes, right.supersedes)
    && sameMetadataValue(left.superseded_by, right.superseded_by)
    && sameMetadataValue(left.lineage_root_id, right.lineage_root_id)
    && sameMetadataValue(left.inactive_at, right.inactive_at)
    && sameMetadataValue(left.inactive_reason, right.inactive_reason)
    && sameMetadataValue(left.supersede_provenance, right.supersede_provenance)
    && sameMetadataValue(left.updated_at, right.updated_at)
    && sameMetadataValue(left.payload_active, right.payload_active)
    && sameMetadataValue(left.payload_inactive_at, right.payload_inactive_at)
    && sameMetadataValue(left.payload_inactive_reason, right.payload_inactive_reason)
    && sameMetadataValue(left.payload_superseded_by_id, right.payload_superseded_by_id)
    && sameMetadataValue(left.payload_supersedes_id, right.payload_supersedes_id)
    && sameMetadataValue(left.payload_lineage_root_id, right.payload_lineage_root_id)
    && sameMetadataValue(left.payload_supersede_provenance, right.payload_supersede_provenance)
    && sameMetadataValue(left.payload_updated_at, right.payload_updated_at)
    && sameMetadataValue(left.payload_write_source, right.payload_write_source)
    && sameMetadataValue(left.payload_arbitration_outcome, right.payload_arbitration_outcome)
    && sameMetadataValue(left.payload_is_stale, right.payload_is_stale)
    && sameMetadataValue(left.payload_stale_since, right.payload_stale_since)
    && sameMetadataValue(left.payload_contradicted_by, right.payload_contradicted_by);
}

function protectedSupersedeExpectedState(
  input: ProtectedMemorySupersedeInput,
  preflight: ProtectedSupersedePreflight,
  now: string,
): { previous: SupersedeMetadataSnapshot; replacement: SupersedeMetadataSnapshot } {
  const inactiveReason = input.inactiveReason ?? "superseded";
  const previous: SupersedeMetadataSnapshot = {
    ...preflight.previous,
    processing_lineage: preflight.mergedProcessingLineage,
    active: false,
    superseded_by: input.replacement.id,
    lineage_root_id: preflight.lineageRootId,
    inactive_at: now,
    inactive_reason: inactiveReason,
    supersede_provenance: input.supersedeProvenance,
    updated_at: now,
    payload_active: false,
    payload_inactive_at: now,
    payload_inactive_reason: inactiveReason,
    payload_superseded_by_id: input.replacement.id,
    payload_lineage_root_id: preflight.lineageRootId,
    payload_supersede_provenance: input.supersedeProvenance,
    payload_updated_at: now,
    ...(input.previousStaleFlags
      ? {
          payload_is_stale: true,
          payload_stale_since: input.previousStaleFlags.staleSince,
          payload_contradicted_by: input.previousStaleFlags.contradictedBy,
        }
      : {}),
  };
  const replacement: SupersedeMetadataSnapshot = preflight.replacement
    ? {
        ...preflight.replacement,
        processing_lineage: preflight.mergedProcessingLineage,
        supersedes: input.previousId,
        lineage_root_id: preflight.lineageRootId,
        supersede_provenance: input.supersedeProvenance,
        updated_at: now,
        payload_supersedes_id: input.previousId,
        payload_lineage_root_id: preflight.lineageRootId,
        payload_updated_at: now,
        payload_write_source: input.replacement.writeSource,
        payload_arbitration_outcome: "supersede",
        payload_supersede_provenance: input.supersedeProvenance,
      }
    : {
        id: input.replacement.id,
        user_id: input.replacement.userId,
        payload_user_id: input.replacement.userId,
        processing_lineage: preflight.mergedProcessingLineage,
        active: true,
        supersedes: input.previousId,
        superseded_by: undefined,
        lineage_root_id: preflight.lineageRootId,
        inactive_at: undefined,
        inactive_reason: undefined,
        supersede_provenance: input.supersedeProvenance,
        updated_at: now,
        payload_active: true,
        payload_inactive_at: undefined,
        payload_inactive_reason: undefined,
        payload_superseded_by_id: undefined,
        payload_supersedes_id: input.previousId,
        payload_lineage_root_id: preflight.lineageRootId,
        payload_supersede_provenance: input.supersedeProvenance,
        payload_updated_at: now,
        payload_write_source: input.replacement.writeSource,
        payload_arbitration_outcome: "supersede",
        payload_is_stale: undefined,
        payload_stale_since: undefined,
        payload_contradicted_by: undefined,
      };
  return { previous, replacement };
}

function supersedeOutcome(
  previous: SupersedeMetadataSnapshot | undefined,
  replacement: SupersedeMetadataSnapshot | undefined,
  input: ProtectedMemorySupersedeInput,
  preflight: ProtectedSupersedePreflight,
  now: string,
): "committed" | "rolled_back" | "inconsistent_or_unresolved" {
  const expected = protectedSupersedeExpectedState(input, preflight, now);
  if (sameSupersedeSnapshot(previous, expected.previous)
    && sameSupersedeSnapshot(replacement, expected.replacement)) return "committed";

  const previousRolledBack = sameSupersedeSnapshot(previous, preflight.previous);
  const replacementRolledBack = input.replacement.id === input.previousId
    ? false
    : preflight.replacement === undefined
      ? replacement === undefined
      : sameSupersedeSnapshot(replacement, preflight.replacement);
  if (previousRolledBack && replacementRolledBack) return "rolled_back";
  return "inconsistent_or_unresolved";
}

/**
 * Supersedes one known protected Minni row through an atomic CREATE/UPDATE
 * transaction. This is intentionally a separate entry point from generic
 * arbitration: protected content never becomes a similarity candidate or a
 * judge input, and the opaque mint is the only authority for the lineage.
 */
export async function supersedeMemoryWithProcessingLineage(
  db: SurrealClient,
  authority: ProducerAuthority,
  minted: MintedProcessingLineage | unknown,
  input: ProtectedMemorySupersedeInput,
): Promise<void> {
  const tableName = input.tableName ?? PRIMARY_MEMORY_TABLE;
  const replacement = input.replacement;
  if (replacement.id === input.previousId) {
    throw new ProducerPolicyRefusalError("lineage_invalid");
  }
  if (replacement.scope === "global") {
    throw new ProducerPolicyRefusalError("lineage_invalid");
  }
  const text = replacement.l2 ?? replacement.text ?? "";
  if (!text || text.trim() === "") {
    throw new Error("supersedeMemoryWithProcessingLineage: text must be non-empty");
  }

  // Exact mint validation runs before any row metadata is read. A structural
  // copy or parsed lineage DTO cannot reach this preflight callback.
  const preflightResult = await runWithMintedProcessingLineage(
    authority,
    minted,
    async (incomingLineage, context): Promise<ProtectedSupersedePreflight> => {
      if (replacement.userId !== context.targetUserId) {
        throw new ProducerPolicyRefusalError("target_user_mismatch");
      }
      const { wouldCreateCycle } = await import("../../lifecycle/semion/dag-guard.js");
      if (await wouldCreateCycle(db as any, replacement.id, input.previousId, replacement.userId, tableName)) {
        throw new ProducerPolicyRefusalError("lineage_invalid");
      }
      const previous = await readSupersedeMetadata(db, tableName, input.previousId);
      if (!previous || previous.user_id !== context.targetUserId || previous.active !== true) {
        throw new ProducerPolicyRefusalError("lineage_invalid");
      }
      const replacementRow = await readSupersedeMetadata(db, tableName, replacement.id);
      if (replacementRow && replacementRow.user_id !== context.targetUserId) {
        throw new ProducerPolicyRefusalError("lineage_invalid");
      }
      const stored = replacementRow
        ? [previous.processing_lineage, replacementRow.processing_lineage]
        : [previous.processing_lineage];
      const mergedProcessingLineage = classifyAndJoinSupersedeLineage(incomingLineage, stored);
      const lineageRootId = typeof previous.lineage_root_id === "string"
        ? previous.lineage_root_id
        : input.previousId;
      return {
        previous,
        replacement: replacementRow,
        mergedProcessingLineage,
        lineageRootId,
      };
    },
    { targetUserId: replacement.userId },
  );
  if (!preflightResult.ok) throw new ProducerPolicyRefusalError(preflightResult.reason);

  const preflight = preflightResult.value;
  const now = new Date().toISOString();
  const vars: Record<string, unknown> = {
    now,
    previousId: input.previousId,
    replacementId: replacement.id,
    mergedProcessingLineage: preflight.mergedProcessingLineage,
    lineageRootId: preflight.lineageRootId,
    supersedeProvenance: input.supersedeProvenance,
    inactiveReason: input.inactiveReason ?? "superseded",
    supersededById: replacement.id,
    writeSource: replacement.writeSource,
    ...snapshotVars("previous", preflight.previous),
    ...(preflight.replacement ? snapshotVars("replacement", preflight.replacement) : {}),
  };
  const statements: string[] = [];

  if (preflight.replacement) {
    statements.push(`
      LET $replacementRows = (
        UPDATE type::record('${tableName}', $replacementId) SET
          processing_lineage = $mergedProcessingLineage,
          supersedes = $previousId,
          lineage_root_id = $lineageRootId,
          supersede_provenance = $supersedeProvenance,
          updated_at = <datetime>$now,
          payload.supersedesId = $previousId,
          payload.lineageRootId = $lineageRootId,
          payload.updatedAt = $now,
          payload.writeSource = $writeSource,
          payload.arbitrationOutcome = 'supersede',
          payload.supersede_provenance = $supersedeProvenance
        WHERE ${sameSupersedeBranchWhere("replacement", preflight.replacement)}
        RETURN VALUE id
      );
      IF array::len($replacementRows) != 1 {
        THROW "protected supersede replacement compare-and-set failed";
      };
    `);
  } else {
    const { statement, vars: createVars } = composeProtectedCreateMemory(
      replacement.id,
      text,
      replacement.userId,
      replacement.embedding,
      {
        ...replacement.metadata,
        writeSource: replacement.writeSource,
        arbitrationOutcome: "supersede",
        supersede_provenance: input.supersedeProvenance,
      },
      replacement.scope,
      replacement.sessionId,
      {
        active: true,
        supersedesId: input.previousId,
        lineageRootId: preflight.lineageRootId,
      },
      tableName,
      preflight.mergedProcessingLineage,
      "protected_supersede_",
      now,
    );
    const createWithReturn = `${statement.replace(/;\s*$/, "")} RETURN VALUE id`;
    statements.push(`
      LET $replacementRows = (${createWithReturn});
      IF $replacementRows = NONE {
        THROW "protected supersede replacement create affected unexpected rows";
      };
    `);
    Object.assign(vars, createVars);
    statements.push(`
      LET $replacementBookkeepingRows = (
        UPDATE type::record('${tableName}', $replacementId) SET
          supersede_provenance = $supersedeProvenance
        RETURN VALUE id
      );
      IF array::len($replacementBookkeepingRows) != 1 {
        THROW "protected supersede replacement bookkeeping failed";
      };
    `);
  }

  const staleFlagsClause = input.previousStaleFlags
    ? `,
          payload.isStale = true,
          payload.staleSince = $staleSince,
          payload.contradictedBy = $contradictedBy`
    : "";
  if (input.previousStaleFlags) {
    vars.staleSince = input.previousStaleFlags.staleSince;
    vars.contradictedBy = input.previousStaleFlags.contradictedBy;
  }
  statements.push(`
    LET $previousRows = (
      UPDATE type::record('${tableName}', $previousId) SET
        processing_lineage = $mergedProcessingLineage,
        active = false,
        inactive_at = <datetime>$now,
        inactive_reason = $inactiveReason,
        superseded_by = $supersededById,
        lineage_root_id = $lineageRootId,
        supersede_provenance = $supersedeProvenance,
        payload.active = false,
        payload.inactiveAt = $now,
        payload.inactiveReason = $inactiveReason,
        payload.supersededById = $supersededById,
        payload.lineageRootId = $lineageRootId,
        payload.supersede_provenance = $supersedeProvenance,
        payload.updatedAt = $now,
        updated_at = <datetime>$now${staleFlagsClause}
      WHERE ${sameSupersedeBranchWhere("previous", preflight.previous)}
      RETURN VALUE id
    );
    IF array::len($previousRows) != 1 {
      THROW "protected supersede previous compare-and-set failed";
    };
  `);

  // This is the second and immediate opaque-mint check. All awaited metadata
  // reads and lineage joins happen before it; a revoked/changed authority
  // therefore cannot reuse a successful preflight. A returned authority
  // refusal is known before any transaction attempt and is not reconciled.
  let transactionResult: Awaited<ReturnType<typeof runWithMintedProcessingLineage<void>>>;
  try {
    transactionResult = await runWithMintedProcessingLineage(
      authority,
      minted,
      async () => db.queryTransaction(statements.join("\n"), vars),
      { targetUserId: replacement.userId },
    );
  } catch (error) {
    // queryTransaction deliberately treats a post-COMMIT connection failure as
    // ambiguous. Reconcile only bounded metadata and attach the classification;
    // never retry a non-idempotent supersede from an SDK error.
    try {
      const [previousAfter, replacementAfter] = await Promise.all([
        readSupersedeMetadata(db, tableName, input.previousId),
        readSupersedeMetadata(db, tableName, replacement.id),
      ]);
      const outcome = supersedeOutcome(previousAfter, replacementAfter, input, preflight, now);
      if (error instanceof Error) {
        Object.assign(error, {
          protectedSupersedeOutcome: outcome,
          protectedSupersedeMetadataReadback: {
            previousExists: previousAfter !== undefined,
            replacementExists: replacementAfter !== undefined,
          },
        });
      }
    } catch {
      // Preserve the original transaction/authority error when reconciliation
      // itself cannot complete; no stronger outcome claim is safe.
    }
    throw error;
  }
  if (!transactionResult.ok) throw new ProducerPolicyRefusalError(transactionResult.reason);
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
  const result = await db.query(
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
       updated_at = <datetime>$now${atomicFactClearClause}
     WHERE processing_lineage = NONE
     RETURN VALUE id;`,
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
  if (db instanceof SurrealClient && Array.isArray(result[0]) && result[0].length === 0) {
    // A guarded no-op must not look like a committed merge. Re-read only the
    // row identity and lineage so the refusal stays content-free; a missing
    // row is also refused, rather than inventing a successful write receipt.
    const presence = await db.query<{ id: unknown; processing_lineage: unknown }>(
      `SELECT id, processing_lineage FROM type::record('${tableName}', $recordId);`,
      { recordId: id },
    );
    if ((presence[0] ?? []).length > 0) {
      throw new ProducerPolicyRefusalError("lineage_present");
    }
    throw new ProducerPolicyRefusalError("lineage_invalid");
  }
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

  // Generic lifecycle callers are intentionally legacy-only. The maintenance
  // searches filter present lineage before mapping text, while this low-level
  // guard closes direct-call paths before cycle checks or any write mutation.
  // Keep the metadata read behind the real client check so existing pure unit
  // mocks retain their compatibility contract.
  let previousMetadata: SupersedeMetadataSnapshot | undefined;
  let replacementMetadata: SupersedeMetadataSnapshot | undefined;
  let replacementExists: boolean;
  if (db instanceof SurrealClient) {
    [previousMetadata, replacementMetadata] = await Promise.all([
      readSupersedeMetadata(db, tableName, previous.id),
      readSupersedeMetadata(db, tableName, replacement.id),
    ]);
    if (!previousMetadata
      || previousMetadata.user_id !== replacement.userId
      || previousMetadata.payload_user_id !== replacement.userId) {
      throw new Error("supersedeMemory: previous generic snapshot mismatch");
    }
    if (previousMetadata.processing_lineage !== undefined
      || replacementMetadata?.processing_lineage !== undefined) {
      throw new ProducerPolicyRefusalError("lineage_present");
    }
    if (replacementMetadata
      && (replacementMetadata.user_id !== replacement.userId
        || replacementMetadata.payload_user_id !== replacement.userId)) {
      throw new Error("supersedeMemory: replacement generic snapshot user mismatch");
    }
    replacementExists = replacementMetadata !== undefined;
  } else {
    const existsResults = await (db as any).query(
      `SELECT id FROM type::record('${tableName}', $id);`,
      { id: replacement.id },
    );
    replacementExists = (existsResults[0] ?? []).length > 0;
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
    ...(previousMetadata ? snapshotVars("genericPrevious", previousMetadata) : {}),
    ...(replacementMetadata ? snapshotVars("genericReplacement", replacementMetadata) : {}),
  };
  const genericPreviousWhere = previousMetadata
    ? sameSupersedeBranchWhere("genericPrevious", previousMetadata)
    : "payload.userId = $userId AND processing_lineage = NONE";
  const genericReplacementWhere = replacementMetadata
    ? sameSupersedeBranchWhere("genericReplacement", replacementMetadata)
    : "payload.userId = $userId AND processing_lineage = NONE";

  if (replacementExists) {
    statements.push(
      `LET $replacementRows = (
         UPDATE type::record('${tableName}', $id) SET
           supersedes = $prevId,
           lineage_root_id = $lineageRootId,
           updated_at = <datetime>$now,
           payload.supersedesId = $prevId,
           payload.lineageRootId = $lineageRootId,
           payload.updatedAt = $now,
           payload.writeSource = $writeSource,
           payload.arbitrationOutcome = 'supersede',
           payload.supersede_provenance = $provenance,
           supersede_provenance = $provenance
         WHERE ${genericReplacementWhere}
         RETURN VALUE id
       );
       IF array::len($replacementRows) != 1 {
         THROW "generic supersede replacement compare-and-set failed";
       };`,
    );
    vars.prevId = previous.id;
    vars.writeSource = replacement.writeSource;
  } else {
    // Fresh ids use CREATE ONLY. The pre-read is advisory; a concurrent row at
    // this id must make the transaction fail rather than let generic UPSERT
    // replace another user's or lineage-bearing record.
    const { statement, vars: createVars } = composeGenericCreateMemory(
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
      supersede_provenance,
      "sup_",
    );
    const createWithReturn = `${statement.replace(/;\s*$/, "")} RETURN VALUE id`;
    statements.push(`
      LET $replacementRows = (${createWithReturn});
      IF $replacementRows = NONE {
        THROW "generic supersede replacement create affected unexpected rows";
      };
    `);
    Object.assign(vars, createVars);
  }

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
    `LET $previousRows = (
      UPDATE type::record('${tableName}', $prevRecordId) SET
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
     WHERE ${genericPreviousWhere}
     RETURN VALUE id
    );
    IF array::len($previousRows) != 1 {
      THROW "generic supersede previous compare-and-set failed";
    };`,
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
     AND processing_lineage = NONE
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
     AND processing_lineage = NONE
     AND active = false
     AND inactive_at < <datetime>$cutoff
     AND (archived = NONE OR archived = false);`,
    { userId, scope, cutoff: cutoffIso },
  );
  const ids = (fetchResults[0] ?? []).map((r) => r.id);
  if (ids.length === 0) return 0;

  const updateResults = await db.query<{ id: unknown }>(
    `UPDATE ${tableName} SET archived = true, updated_at = time::now()
     WHERE payload.userId = $userId
     AND payload.scope = $scope
     AND processing_lineage = NONE
     AND active = false
     AND inactive_at < <datetime>$cutoff
     AND (archived = NONE OR archived = false)
     RETURN VALUE id;`,
    { userId, scope, cutoff: cutoffIso },
  );
  return (updateResults[0] ?? []).length;
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
