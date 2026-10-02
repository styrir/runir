import { extractId, type SurrealClient } from "../../storage/surreal/surreal-store.js";
import { ensureProcessingLineageSchema } from "../../storage/surreal/processing-lineage-schema.js";
import {
  classifyProcessingLineage,
  conservativeJoinProcessingLineage,
  type ProcessingLineageV1,
} from "../../domain/memory/processing-lineage.js";
import {
  runWithMintedProcessingLineage,
  type MintedProcessingLineage,
  type ProducerAuthority,
  type ProducerOperation,
} from "../../app/processing-policy/authority.js";

/**
 * Attempts to acquire a TTL lease lock for a userId/scope pair.
 * Uses the unique index as the contention arbiter.
 */
export async function acquireLock(
  db: SurrealClient,
  key: string,
  ttlSeconds: number,
): Promise<string | null> {
  const holder = crypto.randomUUID();
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  try {
    await db.query(
      `DELETE consolidation_locks WHERE lock_key = $key AND expires_at <= time::now();
       CREATE consolidation_locks SET lock_key = $key, holder = $holder, expires_at = time::now() + ${ttl}s, acquired_at = time::now();`,
      { key, holder },
    );
    return holder;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("idx_cl_key") || (msg.includes("already contains") && msg.includes("consolidation_locks"))) {
      return null;
    }
    throw err;
  }
}

export async function extendLock(
  db: SurrealClient,
  key: string,
  holder: string,
  ttlSeconds: number,
): Promise<boolean> {
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  const results = await db.query<unknown[]>(
    `UPDATE consolidation_locks SET expires_at = time::now() + ${ttl}s
     WHERE lock_key = $key AND holder = $holder;`,
    { key, holder },
  );
  const rows = Array.isArray(results) ? results[0] : undefined;
  return Array.isArray(rows) && rows.length > 0;
}

export async function releaseLock(
  db: SurrealClient,
  key: string,
  holder: string,
): Promise<void> {
  await db.query(
    "DELETE consolidation_locks WHERE lock_key = $key AND holder = $holder;",
    { key, holder },
  );
}

/** Legacy lock-contention writer. Its caller contract is intentionally unchanged. */
export async function writeStalenessBacklog(
  db: SurrealClient,
  userId: string,
  scope: string,
  sessionId: string | undefined,
  facts: Array<{
    text: string;
    confidence: number;
    replacementMemoryId: string;
  }>,
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `CREATE staleness_backlog SET
       user_id = $userId,
       scope = $scope,
       session_id = $sessionId,
       triggered_at = <datetime>$now,
       facts = $facts,
       status = 'pending';`,
    { userId, scope, sessionId: sessionId ?? null, now, facts },
  );
}

export type StalenessBacklogReplacementIdCarrier = Readonly<{
  replacementMemoryId: string;
}>;

export type CurrentSnapshotBacklogResult = Readonly<
  | { status: "committed"; backlogId: string }
  | { status: "rolled_back"; backlogId: string; reason: "transaction_rolled_back"; contentFree: true }
  | { status: "indeterminate"; backlogId: string; reason: "transaction_indeterminate"; contentFree: true }
  | { status: "refused"; reason: CurrentSnapshotBacklogRefusalReason; contentFree: true }
>;

export type CurrentSnapshotBacklogRefusalReason =
  | "invalid_input"
  | "duplicate_replacement"
  | "source_missing"
  | "source_user_mismatch"
  | "source_scope_mismatch"
  | "source_session_mismatch"
  | "source_status_mismatch"
  | "source_branch_mismatch"
  | "source_lineage_present"
  | "source_lineage_invalid"
  | "source_supports_malformed"
  | "support_missing"
  | "support_user_mismatch"
  | "support_scope_mismatch"
  | "support_session_mismatch"
  | "support_status_mismatch"
  | "support_branch_mismatch"
  | "support_lineage_present"
  | "support_lineage_invalid"
  | "stored_fact_missing"
  | "stored_fact_invalid"
  | "backlog_collision"
  | "producer_policy_refused";

type BacklogSnapshot = Readonly<Record<string, unknown>>;
type BacklogFactSnapshot = Readonly<{
  payload_l2: unknown;
  payload_data: unknown;
  payload_confidence: unknown;
  confidence: unknown;
}>;
type BacklogSourceBundle = Readonly<{
  source: BacklogSnapshot;
  supportIds: readonly string[];
  fact: {
    text: string;
    confidence: number;
    replacementMemoryId: string;
  };
  factSnapshot: BacklogFactSnapshot;
}>;

type BacklogSupportBundle = Readonly<{
  snapshot: BacklogSnapshot;
  factSnapshot: BacklogFactSnapshot;
}>;

const BACKLOG_SNAPSHOT_FIELDS: readonly [string, string][] = [
  ["user_id", "user_id"],
  ["payload.userId", "payload_user_id"],
  ["scope", "scope"],
  ["payload.scope", "payload_scope"],
  ["session_id", "session_id"],
  ["payload.sessionId", "payload_session_id"],
  ["active", "active"],
  ["inactive_at", "inactive_at"],
  ["inactive_reason", "inactive_reason"],
  ["superseded_by", "superseded_by"],
  ["lineage_root_id", "lineage_root_id"],
  ["valid_at", "valid_at"],
  ["invalid_at", "invalid_at"],
  ["created_at", "created_at"],
  ["updated_at", "updated_at"],
  ["status", "status"],
  ["payload.active", "payload_active"],
  ["payload.inactiveAt", "payload_inactive_at"],
  ["payload.inactiveReason", "payload_inactive_reason"],
  ["payload.supersededById", "payload_superseded_by_id"],
  ["payload.lineageRootId", "payload_lineage_root_id"],
  ["payload.validAt", "payload_valid_at"],
  ["payload.invalidAt", "payload_invalid_at"],
  ["payload.createdAt", "payload_created_at"],
  ["payload.updatedAt", "payload_updated_at"],
  ["payload.writeSource", "payload_write_source"],
  ["payload.arbitrationOutcome", "payload_arbitration_outcome"],
  ["payload.isStale", "payload_is_stale"],
  ["payload.staleSince", "payload_stale_since"],
  ["payload.contradictedBy", "payload_contradicted_by"],
  ["payload.noemaStatus", "payload_noema_status"],
  ["payload.noemaSupportSemioteIds", "support_semiote_ids"],
  ["processing_lineage", "processing_lineage"],
];

const BACKLOG_FACT_FIELDS: readonly [string, string][] = [
  ["payload.l2", "payload_l2"],
  ["payload.data", "payload_data"],
  ["payload.confidence", "payload_confidence"],
  ["confidence", "confidence"],
];

const BACKLOG_SNAPSHOT_SELECT = BACKLOG_SNAPSHOT_FIELDS
  .map(([field, alias]) => `${field} AS ${alias}`)
  .join(",\n            ");
const BACKLOG_FACT_SELECT = BACKLOG_FACT_FIELDS
  .map(([field, alias]) => `${field} AS ${alias}`)
  .join(",\n            ");

function backlogRefusal(reason: CurrentSnapshotBacklogRefusalReason): CurrentSnapshotBacklogResult {
  return { status: "refused", reason, contentFree: true };
}

function normalizeBacklogRecordId(value: unknown): string | undefined {
  if (typeof value !== "string" && (value === null || typeof value !== "object")) return undefined;
  const normalized = extractId(value).trim();
  if (!normalized || normalized.length > 256 || /\s/.test(normalized)) return undefined;
  return normalized;
}

function readCarrierId(carrier: unknown): string | undefined {
  if (carrier === null || typeof carrier !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(carrier, "replacementMemoryId");
  if (!descriptor || !("value" in descriptor)) return undefined;
  if (typeof descriptor.value !== "string") return undefined;
  return normalizeBacklogRecordId(descriptor.value);
}

function snapshotValue(value: unknown, ancestors: Set<object> = new Set()): string | undefined {
  if (value === undefined) return "<NONE>";
  if (value === null) return "<NULL>";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value !== "object") return undefined;
  if (ancestors.has(value)) return undefined;
  ancestors.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    const record = value as Record<string, unknown>;
    if ("toJSON" in record) {
      if (typeof record.toJSON !== "function") return undefined;
      return snapshotValue(record.toJSON.call(value), ancestors);
    }
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) return undefined;
        const entry = snapshotValue(value[index], ancestors);
        if (entry === undefined) return undefined;
        entries.push(entry);
      }
      return JSON.stringify(entries);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const entries: Array<[string, string]> = [];
    for (const key of Object.keys(record).sort()) {
      const entry = snapshotValue(record[key], ancestors);
      if (entry === undefined) return undefined;
      entries.push([key, entry]);
    }
    return JSON.stringify(entries);
  } catch {
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function sameSnapshotValue(left: unknown, right: unknown): boolean {
  const leftValue = snapshotValue(left);
  const rightValue = snapshotValue(right);
  return leftValue !== undefined && rightValue !== undefined && leftValue === rightValue;
}

function nonEmptyBacklogString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function strictDualString(
  snapshot: BacklogSnapshot,
  topLevelKey: string,
  payloadKey: string,
): string | undefined {
  const topLevel = snapshot[topLevelKey];
  const payload = snapshot[payloadKey];
  if (!nonEmptyBacklogString(topLevel) || !nonEmptyBacklogString(payload)) return undefined;
  return sameSnapshotValue(topLevel, payload) ? topLevel : undefined;
}

function strictOptionalDualString(
  snapshot: BacklogSnapshot,
  topLevelKey: string,
  payloadKey: string,
): string | null | undefined {
  const topLevel = snapshot[topLevelKey];
  const payload = snapshot[payloadKey];
  const topAbsent = topLevel === undefined || topLevel === null;
  const payloadAbsent = payload === undefined || payload === null;
  if (topAbsent || payloadAbsent) return topAbsent && payloadAbsent ? undefined : null;
  if (!nonEmptyBacklogString(topLevel) || !nonEmptyBacklogString(payload)) return null;
  return sameSnapshotValue(topLevel, payload) ? topLevel : null;
}

function snapshotOwnerUserId(snapshot: BacklogSnapshot): string | undefined {
  return strictDualString(snapshot, "user_id", "payload_user_id");
}

function snapshotScope(snapshot: BacklogSnapshot): string | undefined {
  return strictDualString(snapshot, "scope", "payload_scope");
}

function snapshotSessionId(snapshot: BacklogSnapshot): string | undefined {
  const value = strictOptionalDualString(snapshot, "session_id", "payload_session_id");
  return value === null ? undefined : value;
}

function hasStrictDualBinding(snapshot: BacklogSnapshot): boolean {
  return snapshotOwnerUserId(snapshot) !== undefined && snapshotScope(snapshot) !== undefined
    && strictOptionalDualString(snapshot, "session_id", "payload_session_id") !== null;
}

function normalizeBacklogSupportIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return value === undefined ? [] : undefined;
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    const id = normalizeBacklogRecordId(item);
    if (!id) return undefined;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function validateLegacyBranch(snapshot: BacklogSnapshot, support: boolean): CurrentSnapshotBacklogResult | undefined {
  const prefix = support ? "support" : "source";
  if (snapshot.active !== true || snapshot.payload_active !== true) {
    return backlogRefusal(`${prefix}_status_mismatch` as CurrentSnapshotBacklogRefusalReason);
  }
  const status = snapshot.status;
  if (!isAbsent(status) && status !== "active" && status !== "pending") {
    return backlogRefusal(`${prefix}_status_mismatch` as CurrentSnapshotBacklogRefusalReason);
  }
  const branchFields = [
    snapshot.inactive_at,
    snapshot.inactive_reason,
    snapshot.superseded_by,
    snapshot.lineage_root_id,
    snapshot.payload_inactive_at,
    snapshot.payload_inactive_reason,
    snapshot.payload_superseded_by_id,
    snapshot.payload_lineage_root_id,
  ];
  if (branchFields.some((value) => !isAbsent(value))) {
    return backlogRefusal(`${prefix}_branch_mismatch` as CurrentSnapshotBacklogRefusalReason);
  }
  return undefined;
}

function validateLineageAbsence(snapshot: BacklogSnapshot, support: boolean): CurrentSnapshotBacklogResult | undefined {
  const classified = classifyProcessingLineage(snapshot.processing_lineage);
  if (classified.state === "legacy_unknown") return undefined;
  return backlogRefusal(
    classified.state === "invalid"
      ? (support ? "support_lineage_invalid" : "source_lineage_invalid")
      : (support ? "support_lineage_present" : "source_lineage_present"),
  );
}

async function readBacklogSnapshot(
  db: SurrealClient,
  id: string,
  includeFacts: boolean,
  expectedSnapshot?: BacklogSnapshot,
): Promise<BacklogSnapshot | undefined> {
  const predicates: string[] = [];
  const variables: Record<string, unknown> = { id };
  if (expectedSnapshot) appendSnapshotGuard(predicates, variables, expectedSnapshot, "expected");
  const result = await db.query<Record<string, unknown>>(
    `SELECT id,
            ${BACKLOG_SNAPSHOT_SELECT}${includeFacts ? `,\n            ${BACKLOG_FACT_SELECT}` : ""}
     FROM type::record('semiote', $id)${predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : ""} LIMIT 1;`,
    variables,
  );
  const row = result[0]?.[0];
  return row && typeof row === "object" ? row : undefined;
}

function appendSnapshotGuard(
  predicates: string[],
  variables: Record<string, unknown>,
  snapshot: BacklogSnapshot,
  prefix: string,
): void {
  for (const [field, alias] of BACKLOG_SNAPSHOT_FIELDS) {
    if (alias === "processing_lineage") {
      predicates.push(`${field} = NONE`);
      continue;
    }
    const value = snapshot[alias];
    if (value === undefined) predicates.push(`${field} = NONE`);
    else if (value === null) predicates.push(`${field} = NULL`);
    else {
      const parameter = `${prefix}${alias.replace(/(^|_)([a-z])/g, (_match, _separator, character: string) => character.toUpperCase())}`;
      predicates.push(`${field} = $${parameter}`);
      variables[parameter] = value;
    }
  }
}

function appendFactGuard(
  predicates: string[],
  variables: Record<string, unknown>,
  fact: BacklogFactSnapshot,
  prefix: string,
): void {
  for (const [field, alias] of BACKLOG_FACT_FIELDS) {
    const value = fact[alias as keyof BacklogFactSnapshot];
    if (value === undefined) predicates.push(`${field} = NONE`);
    else if (value === null) predicates.push(`${field} = NULL`);
    else {
      const parameter = `${prefix}${alias.replace(/(^|_)([a-z])/g, (_match, _separator, character: string) => character.toUpperCase())}`;
      predicates.push(`${field} = $${parameter}`);
      variables[parameter] = value;
    }
  }
}

async function readBacklogSourceMetadata(
  db: SurrealClient,
  id: string,
  userId: string,
  scope: string,
  sessionId: string | undefined,
): Promise<BacklogSourceBundle | CurrentSnapshotBacklogResult> {
  const source = await readBacklogSnapshot(db, id, false);
  if (!source || normalizeBacklogRecordId(source.id) !== id) return backlogRefusal("source_missing");
  if (!hasStrictDualBinding(source)) {
    const user = strictDualString(source, "user_id", "payload_user_id");
    const scopeValue = strictDualString(source, "scope", "payload_scope");
    if (user === undefined) return backlogRefusal("source_user_mismatch");
    if (scopeValue === undefined) return backlogRefusal("source_scope_mismatch");
    return backlogRefusal("source_session_mismatch");
  }
  if (snapshotOwnerUserId(source) !== userId) return backlogRefusal("source_user_mismatch");
  if (snapshotScope(source) !== scope) return backlogRefusal("source_scope_mismatch");
  if (snapshotSessionId(source) !== sessionId) return backlogRefusal("source_session_mismatch");
  const branchRefusal = validateLegacyBranch(source, false);
  if (branchRefusal) return branchRefusal;
  const lineageRefusal = validateLineageAbsence(source, false);
  if (lineageRefusal) return lineageRefusal;
  const supportIds = normalizeBacklogSupportIds(source.support_semiote_ids);
  if (!supportIds) return backlogRefusal("source_supports_malformed");
  return {
    source,
    supportIds,
    fact: { text: "", confidence: 0, replacementMemoryId: id },
    factSnapshot: { payload_l2: undefined, payload_data: undefined, payload_confidence: undefined, confidence: undefined },
  };
}

function validateSupportMetadata(
  snapshot: BacklogSnapshot,
  userId: string,
  scope: string,
  sessionId: string | undefined,
): CurrentSnapshotBacklogResult | undefined {
  if (!hasStrictDualBinding(snapshot)) {
    const user = strictDualString(snapshot, "user_id", "payload_user_id");
    const scopeValue = strictDualString(snapshot, "scope", "payload_scope");
    if (user === undefined) return backlogRefusal("support_user_mismatch");
    if (scopeValue === undefined) return backlogRefusal("support_scope_mismatch");
    return backlogRefusal("support_session_mismatch");
  }
  if (snapshotOwnerUserId(snapshot) !== userId) return backlogRefusal("support_user_mismatch");
  if (snapshotScope(snapshot) !== scope) return backlogRefusal("support_scope_mismatch");
  if (snapshotSessionId(snapshot) !== sessionId) return backlogRefusal("support_session_mismatch");
  const branchRefusal = validateLegacyBranch(snapshot, true);
  if (branchRefusal) return branchRefusal;
  return validateLineageAbsence(snapshot, true);
}

async function readStoredFact(
  db: SurrealClient,
  bundle: BacklogSourceBundle,
): Promise<BacklogSourceBundle | CurrentSnapshotBacklogResult> {
  const id = normalizeBacklogRecordId(bundle.source.id);
  if (!id) return backlogRefusal("stored_fact_missing");
  const content = await readBacklogSnapshot(db, id, true, bundle.source);
  if (!content || normalizeBacklogRecordId(content.id) !== id) return backlogRefusal("stored_fact_missing");
  const factText = typeof content.payload_l2 === "string" && content.payload_l2.length > 0
    ? content.payload_l2
    : typeof content.payload_data === "string" && content.payload_data.length > 0
      ? content.payload_data
      : undefined;
  const factConfidence = typeof content.payload_confidence === "number" && Number.isFinite(content.payload_confidence)
    ? content.payload_confidence
    : typeof content.confidence === "number" && Number.isFinite(content.confidence)
      ? content.confidence
      : undefined;
  if (factText === undefined || factConfidence === undefined) return backlogRefusal("stored_fact_invalid");
  return {
    ...bundle,
    fact: { text: factText, confidence: factConfidence, replacementMemoryId: id },
    factSnapshot: {
      payload_l2: content.payload_l2,
      payload_data: content.payload_data,
      payload_confidence: content.payload_confidence,
      confidence: content.confidence,
    },
  };
}

type BacklogTransactionWitness = Readonly<{
  backlogExact: boolean;
  backlogAbsent: boolean;
  sourcesExact: boolean;
  supportsExact: boolean;
}>;

function appendExactOptionalPredicate(
  predicates: string[],
  variables: Record<string, unknown>,
  field: string,
  value: unknown,
  parameter: string,
): void {
  if (value === undefined) predicates.push(`${field} = NONE`);
  else if (value === null) predicates.push(`${field} = NULL`);
  else {
    predicates.push(`${field} = $${parameter}`);
    variables[parameter] = value;
  }
}

function resultHasExactlyOne(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length === 1;
}

/**
 * Reconciles a failed transaction with one bounded, content-free DB witness.
 * Only row counts/ids are returned.  The guards include every source/support
 * metadata and stored-fact field, so a body-only race cannot be mistaken for
 * rollback and an old/unrelated backlog row cannot prove this attempt.
 */
async function readBacklogTransactionWitness(
  db: SurrealClient,
  backlogId: string,
  userId: string,
  scope: string,
  sessionId: string | undefined,
  now: string,
  facts: readonly BacklogSourceBundle["fact"][],
  sources: readonly BacklogSourceBundle[],
  supports: readonly BacklogSupportBundle[],
): Promise<BacklogTransactionWitness> {
  const variables: Record<string, unknown> = { backlogId, userId, scope, now, facts };
  const statements: string[] = [];
  const sourceResultIndexes: number[] = [];
  const supportResultIndexes: number[] = [];
  for (const [index, bundle] of sources.entries()) {
    const predicates: string[] = [];
    appendSnapshotGuard(predicates, variables, bundle.source, `witnessSource${index}`);
    appendFactGuard(predicates, variables, bundle.factSnapshot, `witnessSource${index}Fact`);
    variables[`witnessSource${index}Id`] = normalizeBacklogRecordId(bundle.source.id);
    sourceResultIndexes.push(statements.length);
    statements.push(`SELECT VALUE id FROM type::record('semiote', $witnessSource${index}Id) WHERE ${predicates.join(" AND ")} LIMIT 2;`);
  }
  for (const [index, bundle] of supports.entries()) {
    const predicates: string[] = [];
    appendSnapshotGuard(predicates, variables, bundle.snapshot, `witnessSupport${index}`);
    appendFactGuard(predicates, variables, bundle.factSnapshot, `witnessSupport${index}Fact`);
    variables[`witnessSupport${index}Id`] = normalizeBacklogRecordId(bundle.snapshot.id);
    supportResultIndexes.push(statements.length);
    statements.push(`SELECT VALUE id FROM type::record('semiote', $witnessSupport${index}Id) WHERE ${predicates.join(" AND ")} LIMIT 2;`);
  }
  const backlogPredicates = [
    "user_id = $userId",
    "scope = $scope",
    "status = 'pending'",
    "processing_lineage = NONE",
    "triggered_at = <datetime>$now",
    "facts = $facts",
  ];
  appendExactOptionalPredicate(backlogPredicates, variables, "session_id", sessionId, "witnessSessionId");
  const backlogExactIndex = statements.length;
  statements.push(`SELECT VALUE id FROM type::record('staleness_backlog', $backlogId) WHERE ${backlogPredicates.join(" AND ")} LIMIT 2;`);
  const backlogAnyIndex = statements.length;
  statements.push("SELECT VALUE id FROM type::record('staleness_backlog', $backlogId) LIMIT 2;");
  const results = await db.query<unknown>(statements.join("\n"), variables);
  return {
    backlogExact: resultHasExactlyOne(results[backlogExactIndex]),
    backlogAbsent: Array.isArray(results[backlogAnyIndex]) && results[backlogAnyIndex].length === 0,
    sourcesExact: sourceResultIndexes.every((index) => resultHasExactlyOne(results[index])),
    supportsExact: supportResultIndexes.every((index) => resultHasExactlyOne(results[index])),
  };
}

type ProtectedBacklogBundle = Readonly<{
  snapshot: BacklogSnapshot;
  supportIds: readonly string[];
  lineage: ProcessingLineageV1;
}>;

type SyntheticStalenessBacklogOperation = Extract<ProducerOperation, "scheduled_maintenance" | "forced_maintenance">;

type SyntheticStalenessBacklogPlan = Readonly<{
  authority: ProducerAuthority;
  db: SurrealClient;
  table: "staleness_backlog";
  operation: SyntheticStalenessBacklogOperation;
  expectedTargetUserId: string;
  scope: string;
  sessionId: undefined;
  replacementIds: readonly string[];
  sources: readonly ProtectedBacklogBundle[];
  supports: readonly ProtectedBacklogBundle[];
  joinedLineage: ProcessingLineageV1;
  facts: readonly { text: string; confidence: number; replacementMemoryId: string }[];
  backlogId: string;
  now: string;
}>;

type SyntheticStalenessBacklogWitness = Readonly<{
  backlogExact: boolean;
  backlogAbsent: boolean;
  sourcesExact: boolean;
  supportsExact: boolean;
}>;

/** Private identity for a source-owned plan.  It is never exported or serialized. */
const syntheticStalenessBacklogPlanIdentity = new WeakMap<object, SyntheticStalenessBacklogPlan>();

function protectedPolicyRefusal(): CurrentSnapshotBacklogResult {
  return backlogRefusal("producer_policy_refused");
}

function protectedLineageRefusal(support: boolean): CurrentSnapshotBacklogResult {
  return backlogRefusal(support ? "support_lineage_invalid" : "source_lineage_invalid");
}

function classifyProtectedCaptureLineage(
  snapshot: BacklogSnapshot,
  expectedTargetUserId: string,
  support: boolean,
): ProcessingLineageV1 | CurrentSnapshotBacklogResult {
  let classified: ReturnType<typeof classifyProcessingLineage>;
  try {
    classified = classifyProcessingLineage(snapshot.processing_lineage);
  } catch {
    return protectedLineageRefusal(support);
  }
  if (classified.state !== "minni_verified") return protectedLineageRefusal(support);
  if (classified.lineage.admitted_operation !== "capture_ingest"
    || classified.lineage.target_user_id !== expectedTargetUserId) {
    return protectedLineageRefusal(support);
  }
  return classified.lineage;
}

async function readProtectedBacklogMetadata(
  db: SurrealClient,
  id: string,
  expectedTargetUserId: string,
  scope: string,
  sessionId: undefined,
  support: boolean,
): Promise<ProtectedBacklogBundle | CurrentSnapshotBacklogResult> {
  try {
    const snapshot = await readBacklogSnapshot(db, id, false);
    const prefix = support ? "support" : "source";
    if (!snapshot || normalizeBacklogRecordId(snapshot.id) !== id) {
      return backlogRefusal(support ? "support_missing" : "source_missing");
    }
    if (!hasStrictDualBinding(snapshot)) {
      const user = strictDualString(snapshot, "user_id", "payload_user_id");
      const scopeValue = strictDualString(snapshot, "scope", "payload_scope");
      if (user === undefined) return backlogRefusal(`${prefix}_user_mismatch` as CurrentSnapshotBacklogRefusalReason);
      if (scopeValue === undefined) return backlogRefusal(`${prefix}_scope_mismatch` as CurrentSnapshotBacklogRefusalReason);
      return backlogRefusal(`${prefix}_session_mismatch` as CurrentSnapshotBacklogRefusalReason);
    }
    if (snapshotOwnerUserId(snapshot) !== expectedTargetUserId) {
      return backlogRefusal(`${prefix}_user_mismatch` as CurrentSnapshotBacklogRefusalReason);
    }
    if (snapshotScope(snapshot) !== scope) {
      return backlogRefusal(`${prefix}_scope_mismatch` as CurrentSnapshotBacklogRefusalReason);
    }
    if (snapshotSessionId(snapshot) !== sessionId) {
      return backlogRefusal(`${prefix}_session_mismatch` as CurrentSnapshotBacklogRefusalReason);
    }
    const branchRefusal = validateLegacyBranch(snapshot, support);
    if (branchRefusal) return branchRefusal;
    const lineage = classifyProtectedCaptureLineage(snapshot, expectedTargetUserId, support);
    if ("status" in lineage) return lineage;
    const supportIds = normalizeBacklogSupportIds(snapshot.support_semiote_ids);
    if (!supportIds) return backlogRefusal(support ? "support_lineage_invalid" : "source_supports_malformed");
    return { snapshot, supportIds, lineage };
  } catch {
    return protectedLineageRefusal(support);
  }
}

function joinProtectedStoredLineages(
  bundles: readonly ProtectedBacklogBundle[],
): ProcessingLineageV1 | CurrentSnapshotBacklogResult {
  const first = bundles[0];
  if (!first) return protectedLineageRefusal(false);
  let joined = first.lineage;
  for (const bundle of bundles.slice(1)) {
    const result = conservativeJoinProcessingLineage(
      classifyProcessingLineage(joined),
      classifyProcessingLineage(bundle.lineage),
    );
    if (!result.ok) return protectedLineageRefusal(false);
    joined = result.lineage;
  }
  return joined;
}

function appendProtectedSnapshotGuard(
  predicates: string[],
  variables: Record<string, unknown>,
  snapshot: BacklogSnapshot,
  prefix: string,
): void {
  for (const [field, alias] of BACKLOG_SNAPSHOT_FIELDS) {
    const value = snapshot[alias];
    const parameter = `${prefix}${alias.replace(/(^|_)([a-z])/g, (_match, _separator, character: string) => character.toUpperCase())}`;
    if (value === undefined) predicates.push(`${field} = NONE`);
    else if (value === null) predicates.push(`${field} = NULL`);
    else {
      predicates.push(`${field} = $${parameter}`);
      variables[parameter] = value;
    }
  }
}

async function readSyntheticStalenessBacklogWitness(
  db: SurrealClient,
  plan: SyntheticStalenessBacklogPlan,
): Promise<SyntheticStalenessBacklogWitness> {
  const variables: Record<string, unknown> = {
    backlogId: plan.backlogId,
    userId: plan.expectedTargetUserId,
    scope: plan.scope,
    now: plan.now,
    facts: plan.facts,
  };
  const statements: string[] = [];
  const sourceIndexes: number[] = [];
  const supportIndexes: number[] = [];
  const appendBundle = (bundle: ProtectedBacklogBundle, prefix: string, indexes: number[]): void => {
    const predicates: string[] = [];
    appendProtectedSnapshotGuard(predicates, variables, bundle.snapshot, prefix);
    variables[`${prefix}Id`] = normalizeBacklogRecordId(bundle.snapshot.id);
    indexes.push(statements.length);
    statements.push(`SELECT VALUE id FROM type::record('semiote', $${prefix}Id) WHERE ${predicates.join(" AND ")} LIMIT 2;`);
  };
  plan.sources.forEach((bundle, index) => appendBundle(bundle, `witnessSource${index}`, sourceIndexes));
  plan.supports.forEach((bundle, index) => appendBundle(bundle, `witnessSupport${index}`, supportIndexes));
  const backlogPredicates = [
    "user_id = $userId",
    "scope = $scope",
    "status = 'pending'",
    "processing_lineage = NONE",
    "triggered_at = <datetime>$now",
    "facts = $facts",
  ];
  backlogPredicates.push("session_id = NONE");
  const backlogExactIndex = statements.length;
  statements.push(`SELECT VALUE id FROM type::record('staleness_backlog', $backlogId) WHERE ${backlogPredicates.join(" AND ")} LIMIT 2;`);
  const backlogAnyIndex = statements.length;
  statements.push("SELECT VALUE id FROM type::record('staleness_backlog', $backlogId) LIMIT 2;");
  const results = await db.query<unknown>(statements.join("\n"), variables);
  return {
    backlogExact: resultHasExactlyOne(results[backlogExactIndex]),
    backlogAbsent: Array.isArray(results[backlogAnyIndex]) && results[backlogAnyIndex].length === 0,
    sourcesExact: sourceIndexes.every((index) => resultHasExactlyOne(results[index])),
    supportsExact: supportIndexes.every((index) => resultHasExactlyOne(results[index])),
  };
}

async function backlogRecordExists(db: SurrealClient, id: string): Promise<boolean> {
  const result = await db.query<unknown>(
    "SELECT VALUE id FROM type::record('staleness_backlog', $id) LIMIT 1;",
    { id },
  );
  return resultHasExactlyOne(result[0]);
}

function requireSyntheticTargetUser(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return undefined;
  return value;
}

function syntheticMaintenanceText(operation: SyntheticStalenessBacklogOperation): string {
  return operation === "scheduled_maintenance"
    ? "Synthetic scheduled maintenance proof content."
    : "Synthetic forced maintenance proof content.";
}

async function prepareSyntheticStalenessBacklogPlan(
  db: SurrealClient,
  authority: ProducerAuthority,
  operation: SyntheticStalenessBacklogOperation,
  expectedTargetUserId: string,
  replacementIds: readonly string[],
): Promise<SyntheticStalenessBacklogPlan | CurrentSnapshotBacklogResult> {
  const scope = "user";
  const sessionId = undefined;
  const sourceBundles: ProtectedBacklogBundle[] = [];
  for (const id of replacementIds) {
    const source = await readProtectedBacklogMetadata(db, id, expectedTargetUserId, scope, sessionId, false);
    if ("status" in source) return source;
    sourceBundles.push(source);
  }

  const supportById = new Map<string, ProtectedBacklogBundle>();
  for (const source of sourceBundles) {
    for (const supportId of source.supportIds) {
      if (supportById.has(supportId)) continue;
      const support = await readProtectedBacklogMetadata(db, supportId, expectedTargetUserId, scope, sessionId, true);
      if ("status" in support) return support;
      supportById.set(supportId, support);
    }
  }

  const joined = joinProtectedStoredLineages([...sourceBundles, ...supportById.values()]);
  if ("status" in joined) return joined;

  const backlogId = crypto.randomUUID();
  if (await backlogRecordExists(db, backlogId)) return backlogRefusal("backlog_collision");
  const factText = syntheticMaintenanceText(operation);
  const facts = Object.freeze(replacementIds.map((replacementMemoryId) => Object.freeze({
    text: factText,
    confidence: 0.5,
    replacementMemoryId,
  })));
  const plan = Object.freeze({
    authority,
    db,
    table: "staleness_backlog" as const,
    operation,
    expectedTargetUserId,
    scope,
    sessionId,
    replacementIds: Object.freeze([...replacementIds]),
    sources: Object.freeze([...sourceBundles]),
    supports: Object.freeze([...supportById.values()]),
    joinedLineage: joined,
    facts,
    backlogId,
    now: new Date().toISOString(),
  }) as SyntheticStalenessBacklogPlan;
  syntheticStalenessBacklogPlanIdentity.set(plan, plan);
  return plan;
}

function appendSyntheticStalenessBacklogStatements(
  plan: SyntheticStalenessBacklogPlan,
): { statements: readonly string[]; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {
    backlogId: plan.backlogId,
    userId: plan.expectedTargetUserId,
    scope: plan.scope,
    sessionId: plan.sessionId,
    now: plan.now,
    facts: plan.facts,
  };
  const statements: string[] = [];
  const appendGuard = (bundle: ProtectedBacklogBundle, prefix: string, kind: "source" | "support"): void => {
    const predicates: string[] = [];
    appendProtectedSnapshotGuard(predicates, variables, bundle.snapshot, prefix);
    variables[`${prefix}Id`] = normalizeBacklogRecordId(bundle.snapshot.id);
    statements.push(`
      LET $${kind}Rows${prefix.replace(/[^0-9]/g, "")} = (
        SELECT VALUE id FROM type::record('semiote', $${prefix}Id)
        WHERE ${predicates.join(" AND ")}
      );
      IF array::len($${kind}Rows${prefix.replace(/[^0-9]/g, "")}) != 1 {
        THROW "synthetic staleness backlog ${kind} snapshot guard failed";
      };
    `);
  };
  plan.sources.forEach((bundle, index) => appendGuard(bundle, `source${index}`, "source"));
  plan.supports.forEach((bundle, index) => appendGuard(bundle, `support${index}`, "support"));
  statements.push(`
    LET $backlogRows = (
      CREATE ONLY type::record('staleness_backlog', $backlogId) CONTENT {
        user_id: $userId,
        scope: $scope,
        session_id: $sessionId,
        triggered_at: <datetime>$now,
        facts: $facts,
        status: 'pending'
      } RETURN VALUE [id]
    );
    IF array::len($backlogRows) != 1 {
      THROW "synthetic staleness backlog create affected unexpected rows";
    };
  `);
  return { statements, variables };
}

async function writeSyntheticStalenessBacklog(
  db: SurrealClient,
  authority: ProducerAuthority,
  minted: MintedProcessingLineage | unknown,
  expectedTargetUserId: string,
  operation: SyntheticStalenessBacklogOperation,
  carriers: readonly StalenessBacklogReplacementIdCarrier[],
): Promise<CurrentSnapshotBacklogResult> {
  const copiedExpectedUserId = requireSyntheticTargetUser(expectedTargetUserId);
  if (!copiedExpectedUserId || !Array.isArray(carriers) || carriers.length === 0) return backlogRefusal("invalid_input");
  const replacementIds: string[] = [];
  for (const carrier of carriers) {
    const id = readCarrierId(carrier);
    if (!id) return backlogRefusal("invalid_input");
    if (replacementIds.includes(id)) return backlogRefusal("duplicate_replacement");
    replacementIds.push(id);
  }

  const preflight = await runWithMintedProcessingLineage(
    authority,
    minted,
    async () => prepareSyntheticStalenessBacklogPlan(
      db,
      authority,
      operation,
      copiedExpectedUserId,
      replacementIds,
    ),
    { operation, targetUserId: copiedExpectedUserId },
  );
  if (!preflight.ok) return protectedPolicyRefusal();
  if ("status" in preflight.value) return preflight.value;
  const plan = preflight.value;
  if (syntheticStalenessBacklogPlanIdentity.get(plan) !== plan
    || plan.authority !== authority
    || plan.db !== db
    || plan.table !== "staleness_backlog"
    || plan.operation !== operation
    || plan.expectedTargetUserId !== copiedExpectedUserId) {
    return protectedPolicyRefusal();
  }
  let statements: readonly string[];
  let variables: Record<string, unknown>;
  try {
    ({ statements, variables } = appendSyntheticStalenessBacklogStatements(plan));
  } catch {
    return protectedPolicyRefusal();
  }
  try {
    const transactionGate = await runWithMintedProcessingLineage(
      authority,
      minted,
      async () => db.queryTransaction(statements.join("\n"), variables),
      { operation, targetUserId: plan.expectedTargetUserId },
    );
    if (!transactionGate.ok) return protectedPolicyRefusal();
    return { status: "committed", backlogId: plan.backlogId };
  } catch {
    try {
      const witness = await readSyntheticStalenessBacklogWitness(db, plan);
      if (witness.backlogExact && witness.sourcesExact && witness.supportsExact) {
        return { status: "committed", backlogId: plan.backlogId };
      }
      if (witness.backlogAbsent && witness.sourcesExact && witness.supportsExact) {
        return { status: "rolled_back", backlogId: plan.backlogId, reason: "transaction_rolled_back", contentFree: true };
      }
    } catch {
      // Metadata-only reconciliation cannot turn an unknown outcome into a retry.
    }
    return { status: "indeterminate", backlogId: plan.backlogId, reason: "transaction_indeterminate", contentFree: true };
  }
}

/** Fixed source-owned proof seam; it does not activate scheduled processing. */
export async function writeSyntheticScheduledStalenessBacklog(
  db: SurrealClient,
  authority: ProducerAuthority,
  minted: MintedProcessingLineage | unknown,
  expectedTargetUserId: string,
  carriers: readonly StalenessBacklogReplacementIdCarrier[],
): Promise<CurrentSnapshotBacklogResult> {
  return writeSyntheticStalenessBacklog(db, authority, minted, expectedTargetUserId, "scheduled_maintenance", carriers);
}

/** Fixed source-owned proof seam; it does not activate forced processing. */
export async function writeSyntheticForcedStalenessBacklog(
  db: SurrealClient,
  authority: ProducerAuthority,
  minted: MintedProcessingLineage | unknown,
  expectedTargetUserId: string,
  carriers: readonly StalenessBacklogReplacementIdCarrier[],
): Promise<CurrentSnapshotBacklogResult> {
  return writeSyntheticStalenessBacklog(db, authority, minted, expectedTargetUserId, "forced_maintenance", carriers);
}

async function writeCurrentSnapshotBacklog(
  db: SurrealClient,
  userId: string,
  scope: string,
  sessionId: string | undefined,
  carriers: readonly StalenessBacklogReplacementIdCarrier[],
): Promise<CurrentSnapshotBacklogResult> {
  if (!nonEmptyBacklogString(userId) || !nonEmptyBacklogString(scope) || !Array.isArray(carriers)) return backlogRefusal("invalid_input");
  const replacementIds: string[] = [];
  for (const carrier of carriers) {
    const id = readCarrierId(carrier);
    if (!id) return backlogRefusal("invalid_input");
    if (replacementIds.includes(id)) return backlogRefusal("duplicate_replacement");
    replacementIds.push(id);
  }
  if (replacementIds.length === 0) return backlogRefusal("invalid_input");

  const metadataBundles: BacklogSourceBundle[] = [];
  for (const id of replacementIds) {
    const result = await readBacklogSourceMetadata(db, id, userId, scope, sessionId);
    if ("status" in result) return result;
    metadataBundles.push(result);
  }

  const supportMetadata = new Map<string, BacklogSnapshot>();
  for (const bundle of metadataBundles) {
    for (const supportId of bundle.supportIds) {
      if (supportMetadata.has(supportId)) continue;
      const support = await readBacklogSnapshot(db, supportId, false);
      if (!support) return backlogRefusal("support_missing");
      const refusal = validateSupportMetadata(support, userId, scope, sessionId);
      if (refusal) return refusal;
      supportMetadata.set(supportId, support);
    }
  }

  const supportSnapshots = new Map<string, BacklogSupportBundle>();
  for (const [supportId, support] of supportMetadata) {
      const supportBundle = await readBacklogSnapshot(db, supportId, true, support);
      if (!supportBundle || normalizeBacklogRecordId(supportBundle.id) !== supportId) {
        return backlogRefusal("stored_fact_missing");
      }
      supportSnapshots.set(supportId, {
        snapshot: support,
        factSnapshot: {
          payload_l2: supportBundle.payload_l2,
          payload_data: supportBundle.payload_data,
          payload_confidence: supportBundle.payload_confidence,
          confidence: supportBundle.confidence,
        },
      });
  }

  const sourceBundles: BacklogSourceBundle[] = [];
  for (const bundle of metadataBundles) {
    const result = await readStoredFact(db, bundle);
    if ("status" in result) return result;
    sourceBundles.push(result);
  }

  const backlogId = crypto.randomUUID();
  if (await backlogRecordExists(db, backlogId)) return backlogRefusal("backlog_collision");
  const now = new Date().toISOString();
  const variables: Record<string, unknown> = {
    backlogId,
    userId,
    scope,
    sessionId: sessionId ?? undefined,
    now,
    facts: sourceBundles.map(({ fact }) => fact),
  };
  const statements: string[] = [];
  sourceBundles.forEach(({ source, factSnapshot }, index) => {
    const predicates: string[] = [];
    appendSnapshotGuard(predicates, variables, source, `source${index}`);
    appendFactGuard(predicates, variables, factSnapshot, `source${index}Fact`);
    variables[`source${index}Id`] = normalizeBacklogRecordId(source.id);
    statements.push(`
      LET $sourceRows${index} = (
        SELECT VALUE id FROM type::record('semiote', $source${index}Id)
        WHERE ${predicates.join(" AND ")}
      );
      IF array::len($sourceRows${index}) != 1 {
        THROW "staleness backlog source snapshot guard failed";
      };
    `);
  });
  Array.from(supportSnapshots.values()).forEach(({ snapshot, factSnapshot }, index) => {
    const predicates: string[] = [];
    appendSnapshotGuard(predicates, variables, snapshot, `support${index}`);
    appendFactGuard(predicates, variables, factSnapshot, `support${index}Fact`);
    variables[`support${index}Id`] = normalizeBacklogRecordId(snapshot.id);
    statements.push(`
      LET $supportRows${index} = (
        SELECT VALUE id FROM type::record('semiote', $support${index}Id)
        WHERE ${predicates.join(" AND ")}
      );
      IF array::len($supportRows${index}) != 1 {
        THROW "staleness backlog support snapshot guard failed";
      };
    `);
  });
  statements.push(`
    LET $backlogRows = (
      CREATE ONLY type::record('staleness_backlog', $backlogId) CONTENT {
        user_id: $userId,
        scope: $scope,
        session_id: $sessionId,
        triggered_at: <datetime>$now,
        facts: $facts,
        status: 'pending'
      } RETURN VALUE [id]
    );
    IF array::len($backlogRows) != 1 {
      THROW "staleness backlog create affected unexpected rows";
    };
  `);

  try {
    await db.queryTransaction(statements.join("\n"), variables);
    return { status: "committed", backlogId };
  } catch {
    try {
      const witness = await readBacklogTransactionWitness(
        db,
        backlogId,
        userId,
        scope,
        sessionId,
        now,
        sourceBundles.map(({ fact }) => fact),
        sourceBundles,
        Array.from(supportSnapshots.values()),
      );
      if (witness.backlogExact && witness.sourcesExact && witness.supportsExact) {
        return { status: "committed", backlogId };
      }
      if (witness.backlogAbsent && witness.sourcesExact && witness.supportsExact) {
        return { status: "rolled_back", backlogId, reason: "transaction_rolled_back", contentFree: true };
      }
    } catch {
      // Readback remains metadata-only and cannot turn an unknown outcome into a retry.
    }
    return { status: "indeterminate", backlogId, reason: "transaction_indeterminate", contentFree: true };
  }
}

/**
 * Current-snapshot generic backlog creation. The caller supplies only stable
 * replacement-id data properties; text and confidence come from guarded rows.
 */
export async function writeCurrentSnapshotStalenessBacklog(
  db: SurrealClient,
  userId: string,
  scope: string,
  sessionId: string | undefined,
  carriers: readonly StalenessBacklogReplacementIdCarrier[],
): Promise<CurrentSnapshotBacklogResult> {
  return writeCurrentSnapshotBacklog(db, userId, scope, sessionId, carriers);
}

export async function ensureConsolidationLockTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS consolidation_locks SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS lock_key ON TABLE consolidation_locks TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS holder ON TABLE consolidation_locks TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS acquired_at ON TABLE consolidation_locks TYPE datetime;");
  await db.query("DEFINE FIELD IF NOT EXISTS expires_at ON TABLE consolidation_locks TYPE datetime;");
  await db.query("DEFINE INDEX IF NOT EXISTS idx_cl_key ON TABLE consolidation_locks COLUMNS lock_key UNIQUE;");
}

type BacklogFactsSchemaAssessment = Readonly<
  | { kind: "absent" }
  | { kind: "parent_only" }
  | { kind: "complete" }
  | { kind: "partial"; missing: readonly string[] }
  | { kind: "incompatible"; fields: readonly string[] }
  | { kind: "extra"; fields: readonly string[] }
>;

const BACKLOG_FACT_SCHEMA: readonly { name: string; type: RegExp; statement: string }[] = [
  { name: "facts", type: /\btype\s+array(?:\s+permissions\b|\s*;?\s*$)/i, statement: "DEFINE FIELD IF NOT EXISTS facts ON TABLE staleness_backlog TYPE array;" },
  { name: "facts.*.text", type: /\btype\s+string(?:\s+permissions\b|\s*;?\s*$)/i, statement: "DEFINE FIELD IF NOT EXISTS facts.*.text ON TABLE staleness_backlog TYPE string;" },
  { name: "facts.*.confidence", type: /\btype\s+float(?:\s+permissions\b|\s*;?\s*$)/i, statement: "DEFINE FIELD IF NOT EXISTS facts.*.confidence ON TABLE staleness_backlog TYPE float;" },
  { name: "facts.*.replacementMemoryId", type: /\btype\s+string(?:\s+permissions\b|\s*;?\s*$)/i, statement: "DEFINE FIELD IF NOT EXISTS facts.*.replacementMemoryId ON TABLE staleness_backlog TYPE string;" },
] as const;
const BACKLOG_FACT_NAMES = new Set(BACKLOG_FACT_SCHEMA.map((field) => field.name));

export class StalenessBacklogFactsSchemaError extends Error {
  readonly assessment: Exclude<BacklogFactsSchemaAssessment, { kind: "absent" } | { kind: "parent_only" } | { kind: "complete" }>;
  constructor(assessment: Exclude<BacklogFactsSchemaAssessment, { kind: "absent" } | { kind: "parent_only" } | { kind: "complete" }>) {
    super(`staleness backlog facts schema refused: ${assessment.kind}`);
    this.name = "StalenessBacklogFactsSchemaError";
    this.assessment = assessment;
  }
}

function infoObject(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const first = raw[0];
  if (Array.isArray(first)) return first[0] ?? undefined;
  return first;
}

function normalizeInfoFields(raw: unknown): Record<string, string> {
  const value = infoObject(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const fields = (value as { fields?: unknown }).fields;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return {};
  const entries: Array<[string, string]> = Object.entries(fields as Record<string, unknown>)
    .filter(([name, definition]) => typeof name === "string" && typeof definition === "string")
    .map(([name, definition]) => [name, definition as string]);
  return Object.fromEntries(entries);
}

function assessBacklogFactsSchema(raw: unknown): BacklogFactsSchemaAssessment {
  const fields = normalizeInfoFields(raw);
  const names = Object.keys(fields).filter((name) => name === "facts" || name.startsWith("facts."));
  if (names.length === 0) return { kind: "absent" };
  const extras = names.filter((name) => !BACKLOG_FACT_NAMES.has(name)).sort();
  if (extras.length > 0) return { kind: "extra", fields: extras };
  const incompatible = BACKLOG_FACT_SCHEMA.filter((field) => fields[field.name] !== undefined && !field.type.test(fields[field.name])).map((field) => field.name);
  if (incompatible.length > 0) return { kind: "incompatible", fields: incompatible };
  const present = BACKLOG_FACT_SCHEMA.filter((field) => fields[field.name] !== undefined).map((field) => field.name);
  if (present.length === 1 && present[0] === "facts") return { kind: "parent_only" };
  const missing = BACKLOG_FACT_SCHEMA.filter((field) => fields[field.name] === undefined).map((field) => field.name);
  if (missing.length > 0) return { kind: "partial", missing };
  return { kind: "complete" };
}

async function ensureBacklogFactsSchema(db: SurrealClient): Promise<void> {
  const beforeRaw = await db.query("INFO FOR TABLE staleness_backlog;");
  const before = assessBacklogFactsSchema(beforeRaw);
  if (before.kind === "incompatible" || before.kind === "partial" || before.kind === "extra") throw new StalenessBacklogFactsSchemaError(before);
  if (before.kind === "complete") return;
  const missing = before.kind === "absent" ? BACKLOG_FACT_SCHEMA : BACKLOG_FACT_SCHEMA.filter((field) => field.name !== "facts");
  await db.query(missing.map((field) => field.statement).join("\n"));
  const after = assessBacklogFactsSchema(await db.query("INFO FOR TABLE staleness_backlog;"));
  if (after.kind !== "complete") {
    if (after.kind === "incompatible" || after.kind === "partial" || after.kind === "extra") throw new StalenessBacklogFactsSchemaError(after);
    throw new Error("staleness backlog facts schema was not completed");
  }
}

export async function ensureStalenessBacklogTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS staleness_backlog SCHEMAFULL;");
  await ensureProcessingLineageSchema(db, "staleness_backlog");
  await ensureBacklogFactsSchema(db);
  await db.query("DEFINE FIELD IF NOT EXISTS user_id ON TABLE staleness_backlog TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS scope ON TABLE staleness_backlog TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS session_id ON TABLE staleness_backlog TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS triggered_at ON TABLE staleness_backlog TYPE datetime;");
  await db.query("DEFINE FIELD IF NOT EXISTS status ON TABLE staleness_backlog TYPE string;");
  await db.query("DEFINE INDEX IF NOT EXISTS idx_sb_status ON TABLE staleness_backlog COLUMNS status, user_id;");
}
