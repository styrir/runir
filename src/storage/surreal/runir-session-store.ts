import { createHash } from "node:crypto";
import type { ProjectIdentitySource, RunirSessionRecord, RunirSessionStatus } from "../../domain/memory/types.js";
import { extractId, type SurrealClient } from "./surreal-store.js";

export type ResolveRunirSessionInput = {
  userId: string;
  projectKey?: string;
  projectIdentitySource?: ProjectIdentitySource;
  clientKind?: string;
  nativeSessionId?: string;
  nativeSessionKey?: string;
  workspacePath?: string;
  workspaceFingerprint?: string;
  hostId?: string;
  deviceLabel?: string;
  status?: RunirSessionStatus;
  closedAt?: string;
  closeReason?: string;
  now?: string;
};

type PersistedRunirSessionRow = {
  id: unknown;
  user_id: string;
  project_key: string | null;
  project_identity_source: ProjectIdentitySource | null;
  client_kind: string | null;
  native_session_id: string | null;
  native_session_key: string | null;
  native_session_aliases: string[] | null;
  workspace_path: string | null;
  workspace_fingerprint: string | null;
  host_id: string | null;
  device_label: string | null;
  status: RunirSessionStatus;
  opened_at: string;
  last_seen_at: string;
  closed_at: string | null;
  close_reason: string | null;
  last_closed_at: string | null;
  resolver_key: string;
};

function normalizeToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePath(path: string | undefined): string | undefined {
  const trimmed = normalizeToken(path);
  return trimmed?.replace(/\\/g, "/").replace(/\/+$|\/+$/g, "");
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function buildRunirSessionResolverKey(input: {
  userId: string;
  projectKey?: string;
  clientKind?: string;
  nativeSessionKey?: string;
  workspaceFingerprint?: string;
  hostId?: string;
}): string {
  const hasStableWorkspaceIdentity = Boolean(input.projectKey || input.workspaceFingerprint || input.hostId);
  return fingerprint([
    input.userId,
    input.projectKey ?? "-",
    input.clientKind ?? "-",
    hasStableWorkspaceIdentity ? "-" : input.nativeSessionKey ?? "-",
    input.workspaceFingerprint ?? "-",
    input.hostId ?? "-",
  ].join("::"));
}

function mapRow(row: PersistedRunirSessionRow): RunirSessionRecord {
  return {
    id: extractId(row.id),
    userId: row.user_id,
    projectKey: row.project_key ?? undefined,
    projectIdentitySource: row.project_identity_source ?? "absent",
    clientKind: row.client_kind ?? undefined,
    nativeSessionId: row.native_session_id ?? undefined,
    nativeSessionKey: row.native_session_key ?? undefined,
    nativeSessionAliases: row.native_session_aliases ?? [],
    workspacePath: row.workspace_path ?? undefined,
    workspaceFingerprint: row.workspace_fingerprint ?? undefined,
    hostId: row.host_id ?? undefined,
    deviceLabel: row.device_label ?? undefined,
    status: row.status,
    openedAt: row.opened_at,
    lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at ?? undefined,
    closeReason: row.close_reason ?? undefined,
    lastClosedAt: row.last_closed_at ?? undefined,
    resolverKey: row.resolver_key,
  };
}

export async function ensureRunirSessionTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS runir_session SCHEMAFULL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE runir_session TYPE string;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS project_identity_source ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS client_kind ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS native_session_id ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS native_session_key ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS native_session_aliases ON TABLE runir_session TYPE option<array<string>>;
    DEFINE FIELD IF NOT EXISTS workspace_path ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS workspace_fingerprint ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS host_id ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS device_label ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS status ON TABLE runir_session TYPE string;
    DEFINE FIELD IF NOT EXISTS opened_at ON TABLE runir_session TYPE datetime;
    DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE runir_session TYPE datetime;
    DEFINE FIELD IF NOT EXISTS closed_at ON TABLE runir_session TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS close_reason ON TABLE runir_session TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS last_closed_at ON TABLE runir_session TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS resolver_key ON TABLE runir_session TYPE string;
    DEFINE INDEX IF NOT EXISTS idx_runir_session_resolver_key ON TABLE runir_session COLUMNS resolver_key UNIQUE;
    DEFINE INDEX IF NOT EXISTS idx_runir_session_native_alias ON TABLE runir_session COLUMNS user_id, native_session_key;
    DEFINE INDEX IF NOT EXISTS idx_runir_session_project_seen ON TABLE runir_session COLUMNS user_id, project_key, last_seen_at;
    DEFINE INDEX IF NOT EXISTS idx_runir_session_user_status_closed ON TABLE runir_session COLUMNS user_id, status, closed_at;
    DEFINE INDEX IF NOT EXISTS idx_runir_session_user_last_closed ON TABLE runir_session COLUMNS user_id, last_closed_at;
    DEFINE INDEX IF NOT EXISTS idx_runir_session_user_status_seen ON TABLE runir_session COLUMNS user_id, status, last_seen_at;
  `);
}

export async function resolveRunirSession(
  db: SurrealClient,
  input: ResolveRunirSessionInput,
): Promise<RunirSessionRecord> {
  const now = input.now ?? new Date().toISOString();
  const workspacePath = normalizePath(input.workspacePath);
  const workspaceFingerprint = normalizeToken(input.workspaceFingerprint) ?? (workspacePath ? fingerprint(workspacePath) : undefined);
  const clientKind = normalizeToken(input.clientKind);
  const nativeSessionId = normalizeToken(input.nativeSessionId);
  const nativeSessionKey = normalizeToken(input.nativeSessionKey)
    ?? (nativeSessionId ? `${clientKind ?? "unknown"}::${nativeSessionId}` : undefined);
  const resolverKey = buildRunirSessionResolverKey({
    userId: input.userId,
    projectKey: input.projectKey,
    clientKind,
    nativeSessionKey,
    workspaceFingerprint,
    hostId: normalizeToken(input.hostId),
  });
  const id = `runir_session_${resolverKey}`;

  const existingResults = await db.query<PersistedRunirSessionRow>(
    `SELECT id, user_id, project_key, project_identity_source, client_kind, native_session_id, native_session_key, native_session_aliases,
            workspace_path, workspace_fingerprint, host_id, device_label, status, opened_at, last_seen_at, closed_at, close_reason, last_closed_at, resolver_key
       FROM runir_session
       WHERE id = type::record('runir_session', $id)
       LIMIT 1;`,
    { id },
  );
  const existing = (existingResults[0] ?? [])[0];
  if (existing) {
    const existingId = extractId(existing.id);
    const nextStatus = input.status ?? existing.status ?? "active";
    const nextClosedAt = nextStatus === "closed"
      ? (input.closedAt ?? now)
      : undefined;
    const nextCloseReason = nextStatus === "closed"
      ? (normalizeToken(input.closeReason) ?? existing.close_reason ?? undefined)
      : undefined;
    // Race-safe last_closed_at (Rúnir-78sy.13 F1, Codex CRITICAL #1):
    // resolveRunirSession is read-modify-write, so a concurrent non-closed
    // resolve computed from a stale read must NEVER be able to clobber a
    // newer close. A non-closed resolve therefore OMITS last_closed_at from
    // the SET clause entirely (not "write the existing value back" — the
    // field is simply absent from this statement, so it cannot regress a
    // close that landed between this call's read and its write). A closed
    // resolve advances it with a DB-side monotone guard so two interleaved
    // closes (e.g. this call and the idle janitor) can never regress each
    // other regardless of which write reaches the server first.
    const closeSetClause = nextStatus === "closed"
      ? `last_closed_at = IF last_closed_at == NONE OR <datetime>$lastClosedAt > last_closed_at
           THEN <datetime>$lastClosedAt ELSE last_closed_at END,`
      : "";
    // RETURN AFTER (existing repro-store pattern — continuity-gap-store.ts,
    // continuity-evidence-store.ts, surreal-store.ts): reads last_closed_at
    // back from the ACTUAL post-write row rather than re-deriving it in JS.
    // Re-deriving would require comparing SurrealDB's stringified datetime
    // against a JS ISO string lexicographically — a known repo hazard
    // (consolidation.ts dedup watermark comment: a datetime round-trip
    // changes fractional precision and can break a string comparison). The
    // DB-side monotone guard above operates on native `datetime` values, so
    // it is immune; reading the result back sidesteps the hazard entirely.
    const updateResults = await db.query<{ last_closed_at: unknown }>(
      `UPDATE type::record('runir_session', $id)
         SET last_seen_at = <datetime>$lastSeenAt,
             status = $status,
             closed_at = IF $closedAt != NONE THEN <datetime>$closedAt ELSE NONE END,
             close_reason = $closeReason,
             ${closeSetClause}
             native_session_aliases = $nativeSessionAliases,
             native_session_id = $nativeSessionId,
             native_session_key = $nativeSessionKey,
             workspace_path = $workspacePath,
             workspace_fingerprint = $workspaceFingerprint,
             host_id = $hostId,
             device_label = $deviceLabel
         RETURN AFTER;`,
      {
        id: existingId,
        lastSeenAt: now,
        status: nextStatus,
        closedAt: nextClosedAt,
        closeReason: nextCloseReason,
        ...(nextStatus === "closed" ? { lastClosedAt: nextClosedAt } : {}),
        nativeSessionAliases: Array.from(new Set([...(existing.native_session_aliases ?? []), ...(nativeSessionId ? [nativeSessionId] : [])])),
        nativeSessionId: nativeSessionId ?? existing.native_session_id ?? undefined,
        nativeSessionKey: nativeSessionKey ?? existing.native_session_key ?? undefined,
        workspacePath: workspacePath ?? existing.workspace_path ?? undefined,
        workspaceFingerprint: workspaceFingerprint ?? existing.workspace_fingerprint ?? undefined,
        hostId: normalizeToken(input.hostId) ?? existing.host_id ?? undefined,
        deviceLabel: normalizeToken(input.deviceLabel) ?? existing.device_label ?? undefined,
      },
    );
    const updatedRow = (updateResults[0] ?? [])[0];
    // The live SurrealDB SDK (2.0.3) returns `datetime`-typed fields from a
    // RETURN AFTER clause as a rich DateTime object, not a plain string
    // (unlike a fresh SELECT of an already-persisted row, which the driver
    // stringifies) — the SAME coercion continuity-gap-store.ts's mapGapRow
    // already applies to its own RETURN AFTER reads (firstSeenAt/lastSeenAt).
    // Caught live: an early version of this code returned the raw SDK object
    // here and `expect(...).toBe(isoString)` failed with a DateTime instance.
    const nextLastClosedAt = updatedRow?.last_closed_at != null ? String(updatedRow.last_closed_at) : undefined;
    return {
      ...mapRow(existing),
      nativeSessionAliases: Array.from(new Set([...(existing.native_session_aliases ?? []), ...(nativeSessionId ? [nativeSessionId] : [])])),
      nativeSessionId: nativeSessionId ?? existing.native_session_id ?? undefined,
      nativeSessionKey: nativeSessionKey ?? existing.native_session_key ?? undefined,
      workspacePath: workspacePath ?? existing.workspace_path ?? undefined,
      workspaceFingerprint: workspaceFingerprint ?? existing.workspace_fingerprint ?? undefined,
      hostId: normalizeToken(input.hostId) ?? existing.host_id ?? undefined,
      deviceLabel: normalizeToken(input.deviceLabel) ?? existing.device_label ?? undefined,
      lastSeenAt: now,
      status: nextStatus,
      closedAt: nextClosedAt,
      closeReason: nextCloseReason,
      lastClosedAt: nextLastClosedAt,
    };
  }

  const session: RunirSessionRecord = {
    id,
    userId: input.userId,
    projectKey: normalizeToken(input.projectKey),
    projectIdentitySource: input.projectIdentitySource ?? "absent",
    clientKind,
    nativeSessionId,
    nativeSessionKey,
    nativeSessionAliases: nativeSessionId ? [nativeSessionId] : [],
    workspacePath,
    workspaceFingerprint,
    hostId: normalizeToken(input.hostId),
    deviceLabel: normalizeToken(input.deviceLabel),
    status: input.status ?? "active",
    openedAt: now,
    lastSeenAt: now,
    closedAt: input.status === "closed" ? (input.closedAt ?? now) : undefined,
    closeReason: input.status === "closed" ? normalizeToken(input.closeReason) : undefined,
    // CREATE path (F1c): no prior row exists, so there is no race to guard
    // against — set directly, same shape as closed_at above.
    lastClosedAt: input.status === "closed" ? (input.closedAt ?? now) : undefined,
    resolverKey,
  };

  await db.query(
    `UPSERT type::record('runir_session', $id) CONTENT {
       user_id: $userId,
       project_key: $projectKey,
       project_identity_source: $projectIdentitySource,
       client_kind: $clientKind,
       native_session_id: $nativeSessionId,
       native_session_key: $nativeSessionKey,
       native_session_aliases: $nativeSessionAliases,
       workspace_path: $workspacePath,
       workspace_fingerprint: $workspaceFingerprint,
       host_id: $hostId,
       device_label: $deviceLabel,
       status: $status,
       opened_at: <datetime>$openedAt,
       last_seen_at: <datetime>$lastSeenAt,
       closed_at: IF $closedAt != NONE THEN <datetime>$closedAt ELSE NONE END,
       close_reason: $closeReason,
       last_closed_at: IF $lastClosedAt != NONE THEN <datetime>$lastClosedAt ELSE NONE END,
       resolver_key: $resolverKey
     };`,
    {
      id: session.id,
      userId: session.userId,
      projectKey: session.projectKey ?? undefined,
      projectIdentitySource: session.projectIdentitySource,
      clientKind: session.clientKind ?? undefined,
      nativeSessionId: session.nativeSessionId ?? undefined,
      nativeSessionKey: session.nativeSessionKey ?? undefined,
      nativeSessionAliases: session.nativeSessionAliases,
      workspacePath: session.workspacePath ?? undefined,
      workspaceFingerprint: session.workspaceFingerprint ?? undefined,
      hostId: session.hostId ?? undefined,
      deviceLabel: session.deviceLabel ?? undefined,
      status: session.status,
      openedAt: session.openedAt,
      lastSeenAt: session.lastSeenAt,
      closedAt: session.closedAt ?? undefined,
      closeReason: session.closeReason ?? undefined,
      lastClosedAt: session.lastClosedAt ?? undefined,
      resolverKey: session.resolverKey,
    },
  );
  return session;
}
