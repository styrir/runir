import { RecordId, StringRecordId } from "surrealdb";
import { SurrealClient, extractId } from "../storage/surreal/surreal-store.js";
import { entityIdSlug } from "./entity-arbitrator.js";
import { EdgeKind, EntityEdge, EntityRecord, MemoryRecordTable, MemoryScope } from "../domain/memory/types.js";

export async function ensureEntityTables(
  db: SurrealClient,
): Promise<void> {
  // --- entities table ---
  await db.query("DEFINE TABLE IF NOT EXISTS entities SCHEMAFULL;");
  await db.query(
    "DEFINE FIELD IF NOT EXISTS kind ON TABLE entities TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS canonicalName ON TABLE entities TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS nameNorm ON TABLE entities TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS aliases ON TABLE entities TYPE option<array<string>>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS aliasesNorm ON TABLE entities TYPE option<array<string>>;",
  );
  // Stamped by entity-alias-enricher when LLM alias enrichment persists. The
  // SCHEMAFULL table rejects the enricher's whole UPDATE without this field,
  // so nothing ever persisted and every /admin/export re-paid for every
  // alias-less entity (runaway paid loop, discovered-from Rúnir-o75n.4).
  await db.query(
    "DEFINE FIELD IF NOT EXISTS aliases_enriched_at ON TABLE entities TYPE option<datetime | string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS description ON TABLE entities TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS sourceProject ON TABLE entities TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS firstSeenAt ON TABLE entities TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS lastSeenAt ON TABLE entities TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS confidence ON TABLE entities TYPE float;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS scope ON TABLE entities TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS sessionId ON TABLE entities TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS userId ON TABLE entities TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS createdAt ON TABLE entities TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS updatedAt ON TABLE entities TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS handles ON TABLE entities TYPE option<array<string>>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS titles ON TABLE entities TYPE option<array<string>>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS classification ON TABLE entities TYPE option<object>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS orgType ON TABLE entities TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS subtype ON TABLE entities TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS locationType ON TABLE entities TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS eventType ON TABLE entities TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS startAt ON TABLE entities TYPE option<datetime>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS endAt ON TABLE entities TYPE option<datetime>;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_entities_nameNorm ON TABLE entities COLUMNS nameNorm;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_entities_userId ON TABLE entities COLUMNS userId;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_entities_scope ON TABLE entities COLUMNS scope;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_entities_kind ON TABLE entities COLUMNS kind;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_entities_userId_scope ON TABLE entities COLUMNS userId, scope;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_entities_userId_nameNorm_kind_scope_session ON TABLE entities COLUMNS userId, nameNorm, kind, scope, sessionId UNIQUE;",
  );
  // All-equality composite for findEntityByName's (userId, scope, nameNorm) predicate.
  // Without it the planner picks idx_entities_userId_scope and residual-filters the
  // whole per-user slice (~2.7k rows ≈ 15–20ms/lookup live); the recall entity leg
  // issues up to 32 such lookups per query, so this index is hot-path load-bearing.
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_entities_userId_scope_nameNorm ON TABLE entities COLUMNS userId, scope, nameNorm;",
  );

  // --- entity_edges relation table ---
  // Keep this as a table-definition overwrite rather than a remove/recreate migration:
  // older databases may already have entity_edges constrained to `entities | memories`,
  // and `IF NOT EXISTS` will not widen that relation target set. OVERWRITE updates
  // the table definition in place without hard-deleting existing edges.
  await db.query(
    "DEFINE TABLE OVERWRITE entity_edges TYPE RELATION FROM entities TO entities | memories | semiote SCHEMAFULL;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS kind ON TABLE entity_edges TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS confidence ON TABLE entity_edges TYPE float;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS weight ON TABLE entity_edges TYPE float DEFAULT 1.0;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS sourceMemoryId ON TABLE entity_edges TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS contextText ON TABLE entity_edges TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS observedAt ON TABLE entity_edges TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS lastSeenAt ON TABLE entity_edges TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS sourceProject ON TABLE entity_edges TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS scope ON TABLE entity_edges TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS sessionId ON TABLE entity_edges TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS provenance ON TABLE entity_edges TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS updatedAt ON TABLE entity_edges TYPE option<datetime>;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_ee_kind ON TABLE entity_edges COLUMNS kind;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_ee_unique ON TABLE entity_edges COLUMNS in, out, kind UNIQUE;",
  );
}

/**
 * Builds a composable UPSERT statement for an entity record. Returns the SQL
 * statement string, the bound-param object (every param namespaced by
 * `paramPrefix`), and the computed `recordId` so callers do not need to
 * recompute it.
 *
 * When `paramPrefix` is `""` (the default) the statement and param names are
 * byte-identical to the original `upsertEntity` db.query call, preserving
 * backwards compatibility. With a non-empty prefix every `$param` becomes
 * `$<prefix>param` so the fragment can be concatenated into a larger
 * transaction without param-name collisions.
 *
 * The `now` timestamp is accepted as an optional argument so callers that
 * assemble a multi-step transaction can pin a single wall-clock instant across
 * all steps.
 */
export function composeUpsertEntity(
  entity: Omit<EntityRecord, "id" | "createdAt" | "updatedAt">,
  paramPrefix = "",
  now = new Date().toISOString(),
): { statement: string; vars: Record<string, unknown>; recordId: string } {
  const recordId = entityIdSlug(
    entity.nameNorm,
    entity.kind,
    entity.userId,
    entity.scope,
    entity.sessionId,
  );
  const p = paramPrefix;
  const statement = `UPSERT type::record('entities', $${p}recordId) SET
      kind = $${p}kind,
      canonicalName = $${p}canonicalName,
      nameNorm = $${p}nameNorm,
      aliases = array::union(aliases ?? [], $${p}aliases),
      aliasesNorm = array::union(aliasesNorm ?? [], $${p}aliasesNorm),
      description = IF string::len($${p}description ?? "") > string::len(description ?? "") THEN $${p}description ELSE description ?? $${p}description END,
      sourceProject = $${p}sourceProject,
      firstSeenAt = IF firstSeenAt != NONE THEN firstSeenAt ELSE <datetime>$${p}firstSeenAt END,
      lastSeenAt = <datetime>$${p}lastSeenAt,
      confidence = IF confidence != NONE AND confidence > $${p}confidence THEN confidence ELSE $${p}confidence END,
      scope = $${p}scope,
      sessionId = $${p}sessionId,
      userId = $${p}userId,
      createdAt = IF createdAt != NONE THEN createdAt ELSE <datetime>$${p}createdAt END,
      updatedAt = <datetime>$${p}updatedAt,
      handles = $${p}handles,
      titles = $${p}titles,
      classification = $${p}classification,
      orgType = $${p}orgType,
      subtype = $${p}subtype,
      locationType = $${p}locationType,
      eventType = $${p}eventType,
      startAt = $${p}startAt,
      endAt = $${p}endAt;`;
  const vars: Record<string, unknown> = {
    [`${p}recordId`]: recordId,
    [`${p}kind`]: entity.kind,
    [`${p}canonicalName`]: entity.canonicalName,
    [`${p}nameNorm`]: entity.nameNorm,
    [`${p}aliases`]: entity.aliases ?? [],
    [`${p}aliasesNorm`]: entity.aliasesNorm ?? [],
    [`${p}description`]: entity.description ?? undefined,
    [`${p}sourceProject`]: entity.sourceProject,
    [`${p}firstSeenAt`]: entity.firstSeenAt,
    [`${p}lastSeenAt`]: entity.lastSeenAt,
    [`${p}confidence`]: entity.confidence,
    [`${p}scope`]: entity.scope,
    [`${p}sessionId`]: entity.sessionId ?? undefined,
    [`${p}userId`]: entity.userId,
    [`${p}createdAt`]: now,
    [`${p}updatedAt`]: now,
    [`${p}handles`]: entity.handles ?? undefined,
    [`${p}titles`]: entity.titles ?? undefined,
    [`${p}classification`]: entity.classification ?? undefined,
    [`${p}orgType`]: entity.orgType ?? undefined,
    [`${p}subtype`]: entity.subtype ?? undefined,
    [`${p}locationType`]: entity.locationType ?? undefined,
    [`${p}eventType`]: entity.eventType ?? undefined,
    [`${p}startAt`]: entity.startAt ?? undefined,
    [`${p}endAt`]: entity.endAt ?? undefined,
  };
  return { statement, vars, recordId };
}

export async function upsertEntity(
  db: SurrealClient,
  entity: Omit<EntityRecord, "id" | "createdAt" | "updatedAt">,
): Promise<string> {
  const { statement, vars, recordId } = composeUpsertEntity(entity);
  await db.query(statement, vars);
  return recordId;
}

/**
 * Finds entities by exact nameNorm match.
 * Defaults to scope = "user" when omitted.
 * To return session stubs, pass scope: "session" explicitly.
 */
export async function findEntityByName(
  db: SurrealClient,
  nameNorm: string,
  kind?: string,
  userId?: string,
  scope?: MemoryScope,
): Promise<EntityRecord[]> {
  const effectiveScope = scope ?? "user";
  let sql = "SELECT * FROM entities WHERE nameNorm = $nameNorm AND scope = $scope";
  const params: Record<string, unknown> = { nameNorm, scope: effectiveScope };

  if (kind !== undefined) {
    sql += " AND kind = $kind";
    params.kind = kind;
  }
  if (userId !== undefined) {
    sql += " AND userId = $userId";
    params.userId = userId;
  }

  const result = await db.query(sql, params);
  return (result[0] as EntityRecord[]) ?? [];
}

/**
 * Finds entities where aliasesNorm array CONTAINS the given aliasNorm.
 * Defaults to scope = "user" when omitted.
 * To return session stubs, pass scope: "session" explicitly.
 */
export async function findEntityByAlias(
  db: SurrealClient,
  aliasNorm: string,
  userId?: string,
  scope?: MemoryScope,
): Promise<EntityRecord[]> {
  const effectiveScope = scope ?? "user";
  let sql = "SELECT * FROM entities WHERE aliasesNorm CONTAINS $aliasNorm AND scope = $scope";
  const params: Record<string, unknown> = { aliasNorm, scope: effectiveScope };

  if (userId !== undefined) {
    sql += " AND userId = $userId";
    params.userId = userId;
  }

  const result = await db.query(sql, params);
  return (result[0] as EntityRecord[]) ?? [];
}

/**
 * Batched form of findEntityByName for the recall entity leg: ONE query resolves
 * every candidate's exact-nameNorm matches; the caller partitions rows back to
 * candidates by `row.nameNorm` — the same predicate the per-candidate query
 * evaluated server-side. Collapses the leg's per-candidate N+1 (up to 16
 * candidates × 2 scopes ≈ 32 queries, each a (userId,scope) slice scan).
 */
export async function findEntitiesByNames(
  db: SurrealClient,
  nameNorms: string[],
  userId?: string,
  scope?: MemoryScope,
): Promise<EntityRecord[]> {
  if (nameNorms.length === 0) return [];
  const effectiveScope = scope ?? "user";
  let sql = "SELECT * FROM entities WHERE nameNorm IN $nameNorms AND scope = $scope";
  const params: Record<string, unknown> = { nameNorms, scope: effectiveScope };
  if (userId !== undefined) {
    sql += " AND userId = $userId";
    params.userId = userId;
  }
  const result = await db.query(sql, params);
  return (result[0] as EntityRecord[]) ?? [];
}

/**
 * Batched form of findEntityByAlias: CONTAINSANY over all candidates in one query;
 * the caller partitions rows back by `row.aliasesNorm` membership (CONTAINS on an
 * array is element equality — `.includes` app-side is the same predicate).
 */
export async function findEntitiesByAliases(
  db: SurrealClient,
  aliasNorms: string[],
  userId?: string,
  scope?: MemoryScope,
): Promise<EntityRecord[]> {
  if (aliasNorms.length === 0) return [];
  const effectiveScope = scope ?? "user";
  let sql = "SELECT * FROM entities WHERE aliasesNorm CONTAINSANY $aliasNorms AND scope = $scope";
  const params: Record<string, unknown> = { aliasNorms, scope: effectiveScope };
  if (userId !== undefined) {
    sql += " AND userId = $userId";
    params.userId = userId;
  }
  const result = await db.query(sql, params);
  return (result[0] as EntityRecord[]) ?? [];
}

/** Adds aliases to an existing entity (deduped via array::union; aliasesNorm
 *  gets the lowercased forms). Used by the nightly entity-repair job when a
 *  failed query mention is a prefix-relative of exactly one user canonical. */
export async function addEntityAliases(
  db: SurrealClient,
  entityId: string,
  aliases: string[],
): Promise<void> {
  if (aliases.length === 0) return;
  await db.query(
    `UPDATE type::record('entities', $entityId) SET
       aliases = array::union(aliases ?? [], $aliases),
       aliasesNorm = array::union(aliasesNorm ?? [], $aliasesNorm),
       updatedAt = <datetime>$now;`,
    {
      entityId,
      aliases,
      aliasesNorm: aliases.map((a) => a.toLowerCase().trim()),
      now: new Date().toISOString(),
    },
  );
}

// --- Edge and traversal functions (MIM-24) ---

export async function linkEntityToMemory(
  db: SurrealClient,
  entityId: string,
  memoryId: string,
  opts: {
    confidence: number;
    contextText?: string;
    sourceProject: string;
    scope: MemoryScope;
    sessionId?: string;
  },
  memoryTable: MemoryRecordTable = "semiote",
): Promise<string> {
  // Entity edges intentionally keep the generic `memoryId` field until the
  // semiote/noema read-model discriminator decision is made.
  const now = new Date().toISOString();
  try {
    await db.query(
      `RELATE $fromRecord -> entity_edges -> $toRecord SET
        kind = "mentioned_in",
        confidence = $confidence,
        contextText = $contextText,
        observedAt = <datetime>$now,
        lastSeenAt = <datetime>$now,
        sourceProject = $sourceProject,
        scope = $scope,
        sessionId = $sessionId,
        provenance = "session-end-extraction";`,
      {
        fromRecord: new RecordId("entities", entityId),
        toRecord: new RecordId(memoryTable, memoryId),
        confidence: opts.confidence,
        contextText: opts.contextText ?? undefined,
        now,
        sourceProject: opts.sourceProject,
        scope: opts.scope,
        sessionId: opts.sessionId ?? undefined,
      },
    );
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("already exists")) {
      await db.query(
        `UPDATE entity_edges SET lastSeenAt = <datetime>$now, confidence = $confidence
          WHERE in = type::record('entities', $entityId)
          AND out = type::record('${memoryTable}', $memoryId)
          AND kind = "mentioned_in";`,
        { now, confidence: opts.confidence, entityId, memoryId },
      );
    } else {
      throw err;
    }
  }
  return `${entityId}->mentioned_in->${memoryId}`;
}

export async function getSupportingMemoryIds(
  db: SurrealClient,
  entityId: string,
): Promise<string[]> {
  // Graph traversal, NOT `WHERE in = …` on entity_edges: SurrealDB's planner serves
  // that predicate from idx_ee_kind (≈ every mentioned_in edge) and scans the whole
  // edge set — 55–72ms/call on the live graph vs <1ms pointer-walking the record's
  // own edges. The recall entity leg pays this once per matched entity, which made
  // the scan form the dominant cost behind its 5s timeouts. No composite index fixes
  // it: the planner never serves `in =` equality from (in, …) indexes.
  const result = await db.query(
    `SELECT ->entity_edges[WHERE kind = "mentioned_in"].out AS outs FROM $entityRecord;`,
    { entityRecord: new RecordId("entities", entityId) },
  );
  const rows = (result[0] ?? []) as Array<{ outs?: unknown[] }>;
  return (rows[0]?.outs ?? []).map((out) => String(out));
}

/**
 * Batched form of getSupportingMemoryIds (imaf.11 #3): ONE traversal query for
 * the recall entity leg's whole match set instead of one per entity. FROM a
 * record list pointer-walks each record's own edges, so the per-record `outs`
 * ordering matches the single-record form exactly (replay-identical).
 */
export async function getSupportingMemoryIdsBatch(
  db: SurrealClient,
  entityIds: string[],
): Promise<Map<string, string[]>> {
  if (entityIds.length === 0) return new Map();
  const result = await db.query(
    `SELECT id, ->entity_edges[WHERE kind = "mentioned_in"].out AS outs FROM $entityRecords;`,
    { entityRecords: entityIds.map((id) => new RecordId("entities", id)) },
  );
  const rows = (result[0] ?? []) as Array<{ id?: unknown; outs?: unknown[] }>;
  const byEntity = new Map<string, string[]>();
  for (const row of rows) {
    byEntity.set(extractId(row.id), (row.outs ?? []).map((out) => String(out)));
  }
  return byEntity;
}

export async function linkEntities(
  db: SurrealClient,
  fromEntityId: string,
  toEntityId: string,
  kind: EdgeKind,
  opts: {
    confidence: number;
    weight?: number;
    sourceMemoryId?: string;
    contextText?: string;
    sourceProject: string;
    scope: MemoryScope;
    sessionId?: string;
    provenance?: string;
  },
): Promise<string> {
  const now = new Date().toISOString();
  try {
    await db.query(
      `RELATE $fromRecord -> entity_edges -> $toRecord SET
        kind = $kind,
        confidence = $confidence,
        weight = $weight,
        sourceMemoryId = $sourceMemoryId,
        contextText = $contextText,
        observedAt = <datetime>$now,
        lastSeenAt = <datetime>$now,
        sourceProject = $sourceProject,
        scope = $scope,
        sessionId = $sessionId,
        provenance = $provenance;`,
      {
        fromRecord: new RecordId("entities", fromEntityId),
        toRecord: new RecordId("entities", toEntityId),
        kind,
        confidence: opts.confidence,
        weight: opts.weight ?? 1.0,
        sourceMemoryId: opts.sourceMemoryId ?? undefined,
        contextText: opts.contextText ?? undefined,
        now,
        sourceProject: opts.sourceProject,
        scope: opts.scope,
        sessionId: opts.sessionId ?? undefined,
        provenance: opts.provenance ?? "entity-extraction",
      },
    );
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("already exists")) {
      await db.query(
        `UPDATE entity_edges SET lastSeenAt = <datetime>$now, confidence = $confidence
          WHERE in = type::record('entities', $fromEntityId)
          AND out = type::record('entities', $toEntityId)
          AND kind = $kind;`,
        { now, confidence: opts.confidence, fromEntityId, toEntityId, kind },
      );
    } else {
      throw err;
    }
  }
  return `${fromEntityId}->${kind}->${toEntityId}`;
}

export async function getEntityNeighbors(
  db: SurrealClient,
  entityId: string,
  opts?: { kind?: EdgeKind; scope?: MemoryScope },
): Promise<Array<{ entity: EntityRecord; edge: EntityEdge }>> {
  // SurrealDB #2962 — WHERE in graph traversals is buggy. Fetch ALL then filter in app code.
  const [outResult, inResult] = await Promise.all([
    db.query(
      `SELECT * FROM entity_edges WHERE in = type::record('entities', $entityId) AND kind != "mentioned_in";`,
      { entityId },
    ),
    db.query(
      `SELECT * FROM entity_edges WHERE out = type::record('entities', $entityId) AND kind != "mentioned_in";`,
      { entityId },
    ),
  ]);

  const outEdges = (outResult[0] ?? []) as EntityEdge[];
  const inEdges = (inResult[0] ?? []) as EntityEdge[];

  const allEdges: Array<{ edge: EntityEdge; neighborId: string }> = [];
  for (const edge of outEdges) {
    allEdges.push({ edge, neighborId: String(edge.out) });
  }
  for (const edge of inEdges) {
    allEdges.push({ edge, neighborId: String(edge.in) });
  }

  // Filter by opts in app code
  const filtered = allEdges.filter((item) => {
    if (opts?.kind && item.edge.kind !== opts.kind) return false;
    if (opts?.scope && item.edge.scope !== opts.scope) return false;
    return true;
  });

  const results: Array<{ entity: EntityRecord; edge: EntityEdge }> = [];
  for (const item of filtered) {
    const entityResult = await db.query(
      `SELECT * FROM type::record('entities', $neighborId);`,
      { neighborId: item.neighborId },
    );
    const entities = (entityResult[0] ?? []) as EntityRecord[];
    if (entities.length > 0) {
      results.push({ entity: entities[0], edge: item.edge });
    }
  }

  return results;
}

export async function getEntityByMemory(
  db: SurrealClient,
  memoryId: string,
  memoryTable: MemoryRecordTable = "semiote",
): Promise<EntityRecord[]> {
  const result = await db.query(
    `SELECT in.* FROM entity_edges
      WHERE out = type::record('${memoryTable}', $memoryId)
      AND kind = "mentioned_in";`,
    { memoryId },
  );
  const rows = (result[0] ?? []) as Array<{ in: EntityRecord }>;
  return rows.map((r) => r.in).filter(Boolean);
}

/**
 * Builds a composable, ATOMIC transaction fragment that re-points every
 * entity_edges record touching `fromEntityId` (as `in` or `out`) onto
 * `toEntityId`. SurrealDB graph-edge endpoints are IMMUTABLE — an
 * `UPDATE SET in/out` is a silent no-op — so edges are recreated and the
 * originals deleted, otherwise they cascade-delete with the source vertex and
 * entity recall is lost (Rúnir-imaf.12). Both ids are bare entity slugs; the
 * non-`from` endpoint (which may be a memory/semiote record) is kept.
 *
 * Returns `{body, vars}` for {@link SurrealClient.queryTransaction}. Every bound
 * param is namespaced by `prefix` so the fragment can be concatenated into a
 * larger transaction (e.g. mergeEntities, prefix `"m"`) without collisions.
 *
 * Within-batch dedup is resolved in TS BEFORE composing. The previous per-edge
 * loop relied on each iteration's collision-SELECT seeing the prior iteration's
 * just-committed RELATE — a single transaction does NOT guarantee that
 * (read-your-own-writes for mid-tx-created rows is not relied upon). So loser
 * edges that remap to the same `(in, out, kind)` target are folded in memory to
 * ONE statement (max confidence, summed weight, latest lastSeenAt, first
 * non-empty contextText), and the per-target collision check against the
 * already-committed graph is a read BEFORE BEGIN. Both reads run outside the
 * transaction; only the writes are wrapped — the consolidation lock already
 * serialises writers and the prior code had the same read/write gap, so this
 * upgrades the writes from crash-safe-by-ordering to atomic without changing the
 * concurrency contract.
 */
export async function composeEdgeReassignment(
  db: SurrealClient,
  fromEntityId: string,
  toEntityId: string,
  prefix: string,
): Promise<{ body: string; vars: Record<string, unknown> }> {
  if (fromEntityId === toEntityId) return { body: "", vars: {} };
  const fromRecord = `entities:${fromEntityId}`;

  // READ 1 (before BEGIN): every edge touching the loser.
  const result = await db.query(
    `SELECT * FROM entity_edges
       WHERE in = type::record('entities', $cerFrom) OR out = type::record('entities', $cerFrom);`,
    { cerFrom: fromEntityId },
  );
  const edges = (result[0] ?? []) as Array<
    EntityEdge & { id: unknown; in: unknown; out: unknown }
  >;
  const now = new Date().toISOString();

  type TargetAgg = {
    newInStr: string;
    newOutStr: string;
    kind: EdgeKind;
    confidence: number;
    weight: number;
    lastSeenAt: string;
    observedAt: string;
    contextText?: string;
    sourceMemoryId?: string;
    sourceProject: string;
    scope: MemoryScope;
    sessionId?: string;
    provenance?: string;
    originalIds: unknown[];
  };
  const byTarget = new Map<string, TargetAgg>();
  const selfLoopIds: unknown[] = [];

  for (const edge of edges) {
    const inStr = String(edge.in);
    const outStr = String(edge.out);
    const newInStr = inStr === fromRecord ? `entities:${toEntityId}` : inStr;
    const newOutStr = outStr === fromRecord ? `entities:${toEntityId}` : outStr;

    // A from↔from edge collapses to a to↔to self-loop — just drop the original.
    if (newInStr === newOutStr) {
      selfLoopIds.push(edge.id);
      continue;
    }

    const key = JSON.stringify([newInStr, newOutStr, edge.kind]);
    const agg = byTarget.get(key);
    if (!agg) {
      byTarget.set(key, {
        newInStr,
        newOutStr,
        kind: edge.kind,
        confidence: edge.confidence ?? 0.5,
        weight: edge.weight ?? 1.0,
        lastSeenAt: edge.lastSeenAt ?? now,
        observedAt: edge.observedAt ?? now,
        contextText: edge.contextText ?? undefined,
        sourceMemoryId: edge.sourceMemoryId ?? undefined,
        sourceProject: edge.sourceProject ?? "entity-consolidation",
        scope: edge.scope ?? "user",
        sessionId: edge.sessionId ?? undefined,
        provenance: edge.provenance ?? "entity-merge",
        originalIds: [edge.id],
      });
    } else {
      // Fold a second loser edge bound for the same target (max conf, sum weight,
      // latest lastSeenAt, first non-empty contextText) — mirrors what the old
      // per-edge collision-fold produced across sequential committed writes.
      agg.confidence = Math.max(agg.confidence, edge.confidence ?? 0);
      agg.weight += edge.weight ?? 1.0;
      const seen = edge.lastSeenAt ?? now;
      if (seen > agg.lastSeenAt) agg.lastSeenAt = seen;
      if (!agg.contextText && edge.contextText) agg.contextText = edge.contextText;
      agg.originalIds.push(edge.id);
    }
  }

  const statements: string[] = [];
  const vars: Record<string, unknown> = {};

  // Self-loops: delete the originals (no replacement).
  selfLoopIds.forEach((id, j) => {
    const p = `${prefix}sl${j}`;
    statements.push(`DELETE $${p};`);
    vars[p] = id;
  });

  let i = 0;
  for (const agg of byTarget.values()) {
    const p = `${prefix}${i}_`;
    // READ 2 (before BEGIN): is there already a committed edge at this target?
    const existing = (
      (await db.query(
        `SELECT * FROM entity_edges WHERE in = $cerNewIn AND out = $cerNewOut AND kind = $cerKind LIMIT 1;`,
        {
          cerNewIn: new StringRecordId(agg.newInStr),
          cerNewOut: new StringRecordId(agg.newOutStr),
          cerKind: agg.kind,
        },
      ))[0] as Array<EntityEdge & { id: unknown }> | undefined
    )?.[0];

    if (existing) {
      // Fold the already-aggregated signal into the existing target edge.
      statements.push(
        `UPDATE $${p}existingId SET
           lastSeenAt = <datetime>$${p}lastSeenAt,
           confidence = $${p}confidence,
           weight = $${p}weight,
           contextText = $${p}contextText,
           updatedAt = <datetime>$${p}now;`,
      );
      const existingSeen = existing.lastSeenAt ?? "";
      vars[`${p}existingId`] = existing.id;
      vars[`${p}lastSeenAt`] =
        agg.lastSeenAt > existingSeen ? agg.lastSeenAt : existing.lastSeenAt;
      vars[`${p}confidence`] = Math.max(agg.confidence, existing.confidence ?? 0);
      vars[`${p}weight`] = agg.weight + (existing.weight ?? 1.0);
      // Preserve the existing edge's contextText when present, else adopt the
      // loser's (matches the old `IF contextText != NONE …` SET).
      vars[`${p}contextText`] = existing.contextText ?? agg.contextText ?? undefined;
      vars[`${p}now`] = now;
    } else {
      statements.push(
        `RELATE $${p}from -> entity_edges -> $${p}to SET
           kind = $${p}kind, confidence = $${p}confidence, weight = $${p}weight,
           sourceMemoryId = $${p}sourceMemoryId, contextText = $${p}contextText,
           observedAt = <datetime>$${p}observedAt, lastSeenAt = <datetime>$${p}lastSeenAt,
           sourceProject = $${p}sourceProject, scope = $${p}scope, sessionId = $${p}sessionId,
           provenance = $${p}provenance;`,
      );
      vars[`${p}from`] = new StringRecordId(agg.newInStr);
      vars[`${p}to`] = new StringRecordId(agg.newOutStr);
      vars[`${p}kind`] = agg.kind;
      vars[`${p}confidence`] = agg.confidence;
      vars[`${p}weight`] = agg.weight;
      vars[`${p}sourceMemoryId`] = agg.sourceMemoryId ?? undefined;
      vars[`${p}contextText`] = agg.contextText ?? undefined;
      vars[`${p}observedAt`] = agg.observedAt;
      vars[`${p}lastSeenAt`] = agg.lastSeenAt;
      vars[`${p}sourceProject`] = agg.sourceProject;
      vars[`${p}scope`] = agg.scope;
      vars[`${p}sessionId`] = agg.sessionId ?? undefined;
      vars[`${p}provenance`] = agg.provenance ?? undefined;
    }

    // Replacement is in place — delete every original that mapped to this target.
    agg.originalIds.forEach((id, k) => {
      const dp = `${p}o${k}`;
      statements.push(`DELETE $${dp};`);
      vars[dp] = id;
    });
    i += 1;
  }

  return { body: statements.join("\n"), vars };
}

/**
 * Atomic edge reassignment from `fromEntityId` to `toEntityId`. Thin wrapper
 * over {@link composeEdgeReassignment} + {@link SurrealClient.queryTransaction};
 * a no-op (no edges / self id) emits no transaction.
 */
export async function reassignEntityEdges(
  db: SurrealClient,
  fromEntityId: string,
  toEntityId: string,
): Promise<void> {
  const { body, vars } = await composeEdgeReassignment(
    db,
    fromEntityId,
    toEntityId,
    "r",
  );
  if (!body) return;
  await db.queryTransaction(body, vars);
}

export async function mergeEntities(
  db: SurrealClient,
  winnerIdRaw: string,
  loserIdRaw: string,
  winnerUpdates: Partial<
    Pick<
      EntityRecord,
      | "canonicalName"
      | "nameNorm"
      | "aliases"
      | "aliasesNorm"
      | "confidence"
      | "firstSeenAt"
      | "lastSeenAt"
      | "description"
    >
  >,
): Promise<void> {
  const now = new Date().toISOString();
  // The callers pass raw entity ids that may arrive as SurrealDB RecordId objects
  // or prefixed strings; normalize to bare slugs so every type::record('entities', …)
  // below (and the edge reassignment) keys on a single, correct form (Rúnir-imaf.12).
  const winnerId = extractId(winnerIdRaw);
  const loserId = extractId(loserIdRaw);

  // The whole merge runs as ONE atomic transaction (winner update + edge move +
  // loser-alias union + loser delete). Reads run before BEGIN; the conditional
  // loser-alias union becomes a TS decision. Param names below are plain
  // camelCase and never collide with the edge fragment's prefixed params
  // (m{n}_… / msl{n}); shared winnerId/now/loserId hold one value each.
  const statements: string[] = [];
  const vars: Record<string, unknown> = { winnerId, loserId, now };

  // Step 0: apply winnerUpdates — build the SET clause dynamically.
  const setClauses: string[] = [];
  if (winnerUpdates.canonicalName !== undefined) {
    setClauses.push("canonicalName = $canonicalName");
    vars.canonicalName = winnerUpdates.canonicalName;
  }
  if (winnerUpdates.nameNorm !== undefined) {
    setClauses.push("nameNorm = $nameNorm");
    vars.nameNorm = winnerUpdates.nameNorm;
  }
  if (winnerUpdates.confidence !== undefined) {
    setClauses.push("confidence = $confidence");
    vars.confidence = winnerUpdates.confidence;
  }
  if (winnerUpdates.firstSeenAt !== undefined) {
    setClauses.push("firstSeenAt = <datetime>$firstSeenAt");
    vars.firstSeenAt = winnerUpdates.firstSeenAt;
  }
  if (winnerUpdates.lastSeenAt !== undefined) {
    setClauses.push("lastSeenAt = <datetime>$lastSeenAt");
    vars.lastSeenAt = winnerUpdates.lastSeenAt;
  }
  if (winnerUpdates.description !== undefined) {
    setClauses.push("description = $description");
    vars.description = winnerUpdates.description;
  }
  // aliases/aliasesNorm always union
  setClauses.push("aliases = array::union(aliases ?? [], $aliases ?? [])");
  vars.aliases = winnerUpdates.aliases ?? [];
  setClauses.push("aliasesNorm = array::union(aliasesNorm ?? [], $aliasesNorm ?? [])");
  vars.aliasesNorm = winnerUpdates.aliasesNorm ?? [];
  setClauses.push("updatedAt = <datetime>$now");
  statements.push(
    `UPDATE type::record('entities', $winnerId) SET ${setClauses.join(", ")};`,
  );

  // Steps 1-2: move every edge from the loser onto the winner. Graph-edge
  // endpoints are immutable, so edges are recreated, not UPDATE-d (Rúnir-imaf.12).
  // composeEdgeReassignment does its reads now (before BEGIN); its writes join
  // this transaction so an edge move and the loser delete can never half-apply.
  const { body: edgeBody, vars: edgeVars } = await composeEdgeReassignment(
    db,
    loserId,
    winnerId,
    "m",
  );
  if (edgeBody) {
    statements.push(edgeBody);
    Object.assign(vars, edgeVars);
  }

  // Step 3: accumulate loser aliases into the winner. Read before BEGIN so the
  // union statement is emitted only when the loser still has a row.
  const loserResult = await db.query(
    `SELECT aliases, aliasesNorm FROM type::record('entities', $loserId);`,
    { loserId },
  );
  const loserRows = (loserResult[0] ?? []) as Array<{
    aliases?: string[];
    aliasesNorm?: string[];
  }>;
  if (loserRows.length > 0) {
    statements.push(
      `UPDATE type::record('entities', $winnerId) SET
        aliases = array::union(aliases ?? [], $loserAliases ?? []),
        aliasesNorm = array::union(aliasesNorm ?? [], $loserAliasesNorm ?? []),
        updatedAt = <datetime>$now;`,
    );
    vars.loserAliases = loserRows[0].aliases ?? [];
    vars.loserAliasesNorm = loserRows[0].aliasesNorm ?? [];
  }

  // Step 4: delete the loser LAST — its edges were already moved above, so the
  // vertex cascade-delete drops nothing live.
  statements.push(`DELETE type::record('entities', $loserId);`);

  await db.queryTransaction(statements.join("\n"), vars);
}
