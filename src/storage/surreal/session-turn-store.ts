// Redacted, retained source turns for Rúnir-277.2. New header content is empty;
// text lives only in ordered chunks. Legacy raw rows remain isolated until the
// separately approved Slice 3 scrub. All reads and writes constrain user ID.

import type { SurrealClient } from "./surreal-store";
import { chunkSourceTurn, type SourceTurn } from "../../capture/source-turn-identity.js";

export type SessionTurnInput = {
  userId: string;
  sessionId: string;
  client?: string;
  turns: Array<{
    turnIndex: number;
    role: string;
    content: string;
  }>;
};

export async function ensureSessionTurnSchema(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS session_turn SCHEMALESS;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE session_turn TYPE string;
    DEFINE FIELD IF NOT EXISTS session_id ON TABLE session_turn TYPE string;
    DEFINE FIELD IF NOT EXISTS client ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS turn_index ON TABLE session_turn TYPE int;
    DEFINE FIELD OVERWRITE turn_index ON TABLE session_turn TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS role ON TABLE session_turn TYPE string;
    DEFINE FIELD IF NOT EXISTS content ON TABLE session_turn TYPE string;
    DEFINE FIELD IF NOT EXISTS created_at ON TABLE session_turn TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_user_created ON TABLE session_turn COLUMNS user_id, created_at;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_user_session ON TABLE session_turn COLUMNS user_id, session_id;
  `);
  // Inventory is count-only. Missing new-key fields on old rows remain NONE;
  // SurrealDB does not index those tuples as unique. No old content is copied.
  await db.query("SELECT count() AS total FROM session_turn GROUP ALL;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS session_epoch ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS turn_key ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS content_hmac ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS key_fingerprint ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS redaction_version ON TABLE session_turn TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS source_format ON TABLE session_turn TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE session_turn TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE session_turn TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS identity_quality ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS scope ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS team_id ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS project_key ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS path ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS retention_class ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS retain_until ON TABLE session_turn TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS content_length ON TABLE session_turn TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS original_bytes ON TABLE session_turn TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS chunk_count ON TABLE session_turn TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS truncated ON TABLE session_turn TYPE option<bool>;
    DEFINE TABLE IF NOT EXISTS session_turn_chunk SCHEMALESS;
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE session_turn_chunk TYPE string;
    DEFINE FIELD IF NOT EXISTS turn_id ON TABLE session_turn_chunk TYPE string;
    DEFINE FIELD IF NOT EXISTS chunk_index ON TABLE session_turn_chunk TYPE int;
    DEFINE FIELD IF NOT EXISTS content ON TABLE session_turn_chunk TYPE string;
    DEFINE FIELD IF NOT EXISTS text_norm ON TABLE session_turn_chunk TYPE string;
  `);
  // This SurrealDB build supports transactional DDL and permits multiple
  // legacy NONE tuples in a UNIQUE index. Install the new key before removing
  // the fork-hostile old key, atomically across bootstrap retries.
  await db.query(`
    BEGIN TRANSACTION;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_key ON TABLE session_turn
      COLUMNS user_id, client, session_id, session_epoch, turn_key UNIQUE;
    REMOVE INDEX IF EXISTS idx_session_turn_unique ON TABLE session_turn;
    COMMIT TRANSACTION;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_user_occurred ON TABLE session_turn COLUMNS user_id, occurred_at;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_retention ON TABLE session_turn COLUMNS retention_class, retain_until;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_chunk_unique ON TABLE session_turn_chunk COLUMNS turn_id, chunk_index UNIQUE;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_chunk_lookup ON TABLE session_turn_chunk COLUMNS user_id, turn_id, chunk_index;
  `);
}

export class SourceTurnConflictError extends Error {
  constructor() { super("source turn identity conflict"); }
}

export class SourceKeyMismatchError extends Error {
  constructor(readonly configured: string, readonly recorded: string) {
    super("source HMAC key fingerprint mismatch");
  }
}

/** Fail source writes closed. Old raw rows have no content_hmac and are outside this guard.
 * Key rotation/reconciliation of legacy IDs and links is a separate operator tool. */
export async function assertSourceKeyFingerprint(db: SurrealClient, configured: string): Promise<void> {
  const rows = await db.query<any>(
    "SELECT VALUE key_fingerprint FROM session_turn WHERE content_hmac != NONE GROUP BY key_fingerprint;",
  );
  for (const recorded of (rows[0] ?? []) as Array<string | undefined>) {
    if (recorded !== configured) throw new SourceKeyMismatchError(configured, recorded ?? "missing");
  }
  const links = await db.query<any>(
    "SELECT VALUE source_turn_key_fingerprint FROM semiote WHERE source_turn_id != NONE GROUP BY source_turn_key_fingerprint;",
  );
  for (const recorded of (links[0] ?? []) as Array<string | undefined>) {
    if (recorded !== configured) throw new SourceKeyMismatchError(configured, recorded ?? "missing");
  }
  const evidence = await db.query<any>(
    "SELECT VALUE key_fingerprint FROM source_turn_evidence GROUP BY key_fingerprint;",
  );
  for (const recorded of (evidence[0] ?? []) as Array<string | undefined>) {
    if (recorded !== configured) throw new SourceKeyMismatchError(configured, recorded ?? "missing");
  }
}

/** The only retained-turn writer. Header content is always empty. */
export async function upsertSourceTurn(db: SurrealClient, turn: SourceTurn): Promise<"created" | "seen"> {
  await assertSourceKeyFingerprint(db, turn.keyFingerprint);
  const existing = await db.query<any>(
    "SELECT user_id, content_hmac, key_fingerprint FROM type::record('session_turn', $id);", { id: turn.id },
  );
  const row = existing[0]?.[0] as { user_id?: string; content_hmac?: string; key_fingerprint?: string } | undefined;
  if (row) {
    if (row.key_fingerprint !== turn.keyFingerprint) throw new SourceKeyMismatchError(turn.keyFingerprint, row.key_fingerprint ?? "missing");
    if (row.user_id !== turn.userId || row.content_hmac !== turn.contentHmac) throw new SourceTurnConflictError();
    await db.query(
      "UPDATE type::record('session_turn', $id) SET last_seen_at = time::now() WHERE user_id = $userId AND content_hmac = $hmac;",
      { id: turn.id, userId: turn.userId, hmac: turn.contentHmac },
    );
    return "seen";
  }
  const chunks = chunkSourceTurn(turn.content);
  const retainUntil = new Date(Date.parse(turn.occurredAt) + 365 * 24 * 3600 * 1000).toISOString();
  try {
    await db.query(
      `BEGIN TRANSACTION;
       CREATE type::record('session_turn', $id) CONTENT {
         user_id: $userId, client: $client, session_id: $sessionId,
         session_epoch: $sessionEpoch, turn_key: $turnKey,
         ${turn.turnIndex === undefined ? "" : "turn_index: $turnIndex,"}
         role: $role, content: '', content_hmac: $hmac, key_fingerprint: $keyFingerprint,
         redaction_version: $redactionVersion, source_format: $sourceFormat,
         occurred_at: <datetime>$occurredAt, created_at: time::now(), last_seen_at: time::now(),
         identity_quality: $identityQuality, scope: $scope, team_id: $teamId,
         project_key: $projectKey, path: $path, retention_class: 'unlinked',
         retain_until: <datetime>$retainUntil, content_length: $contentLength,
         original_bytes: $originalBytes, chunk_count: $chunkCount, truncated: $truncated
       };
       FOR $item IN $chunks {
         CREATE type::record('session_turn_chunk', $item.id) CONTENT {
           user_id: $userId, turn_id: $id, chunk_index: $item.index,
           content: $item.content, text_norm: $item.norm
         };
       };
       COMMIT TRANSACTION;`,
      {
        id: turn.id, userId: turn.userId, client: turn.client, sessionId: turn.sessionId,
        sessionEpoch: turn.sessionEpoch, turnKey: turn.turnKey, turnIndex: turn.turnIndex,
        role: turn.role, hmac: turn.contentHmac, keyFingerprint: turn.keyFingerprint, redactionVersion: turn.redactionVersion,
        sourceFormat: turn.sourceFormat, occurredAt: turn.occurredAt, identityQuality: turn.identityQuality,
        scope: turn.scope, teamId: turn.teamId, projectKey: turn.projectKey, path: turn.path,
        retainUntil, contentLength: turn.content.length, originalBytes: turn.originalBytes,
        chunkCount: chunks.length, truncated: turn.truncated,
        chunks: chunks.map((content, index) => ({
          id: `${turn.id}_${index}`, index, content, norm: content.toLowerCase(),
        })),
      },
    );
    return "created";
  } catch {
    const retry = await db.query<any>(
      "SELECT user_id, content_hmac FROM type::record('session_turn', $id);", { id: turn.id },
    );
    const retryRow = retry[0]?.[0] as { user_id?: string; content_hmac?: string } | undefined;
    if (retryRow?.user_id === turn.userId && retryRow.content_hmac === turn.contentHmac) return "seen";
    if (retryRow) throw new SourceTurnConflictError();
    throw new Error("source turn storage failed");
  }
}

/** Retired raw session-end writer. The only retained write path is
 * upsertSourceTurn, which accepts a redacted SourceTurn from the spool. */
export async function recordSessionTurns(
  _db: SurrealClient,
  _input: SessionTurnInput,
  _warn?: (msg: string) => void,
): Promise<number> {
  return 0;
}

/** Expire only unlinked retained turns. Legacy rows have no retain_until and stay
 * isolated for the Slice 3 scrub; a rollback must keep this sweep in place. */
export async function deleteExpiredSessionTurns(
  db: SurrealClient,
  _retentionDays: number,
): Promise<void> {
  const cutoff = new Date().toISOString();
  await db.query(
    `BEGIN TRANSACTION;
     DELETE session_turn_chunk WHERE turn_id IN
       (SELECT VALUE record::id(id) FROM session_turn WHERE retention_class = 'unlinked'
        AND retain_until != NONE AND retain_until < <datetime>$cutoff);
     DELETE session_turn WHERE retention_class = 'unlinked'
       AND retain_until != NONE AND retain_until < <datetime>$cutoff;
     COMMIT TRANSACTION;`,
    { cutoff },
  );
}

export function resolveTurnRetentionDays(): number {
  const raw = process.env.RUNIR_TURN_RETENTION_DAYS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 30;
}
