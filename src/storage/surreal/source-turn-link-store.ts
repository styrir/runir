import { createHash } from "node:crypto";
import type { SurrealClient } from "./surreal-store.js";
import type { SourceTurn } from "../../capture/source-turn-identity.js";
import { assertSourceKeyFingerprint } from "./session-turn-store.js";
import type { SourceTurnSpool } from "../../capture/source-turn-spool.js";

export type SourceLinkState = "pending" | "linked" | "unavailable" | "legacy";

export async function ensureSourceTurnLinkSchema(db: SurrealClient): Promise<void> {
  await db.query(`
    DEFINE FIELD IF NOT EXISTS source_turn_id ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_turn_link_state ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_turn_redaction_version ON TABLE semiote TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS source_turn_hmac ON TABLE semiote TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_turn_key_fingerprint ON TABLE semiote TYPE option<string>;
    DEFINE INDEX IF NOT EXISTS idx_semiote_user_source_turn ON TABLE semiote COLUMNS user_id, source_turn_id;
    DEFINE TABLE IF NOT EXISTS source_turn_evidence SCHEMALESS;
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE source_turn_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS fact_id ON TABLE source_turn_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS turn_id ON TABLE source_turn_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS scope ON TABLE source_turn_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS content_hmac ON TABLE source_turn_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS key_fingerprint ON TABLE source_turn_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS link_state ON TABLE source_turn_evidence TYPE string;
    DEFINE FIELD IF NOT EXISTS non_equivalent ON TABLE source_turn_evidence TYPE bool;
    DEFINE FIELD IF NOT EXISTS source_chunk_index ON TABLE source_turn_evidence TYPE option<int>;
    DEFINE INDEX IF NOT EXISTS idx_source_evidence_user_turn ON TABLE source_turn_evidence COLUMNS user_id, turn_id;
    DEFINE INDEX IF NOT EXISTS idx_source_evidence_user_fact ON TABLE source_turn_evidence COLUMNS user_id, fact_id;
  `);
}

export async function markFactSourceLink(
  db: SurrealClient, factId: string, userId: string, turn: SourceTurn | undefined,
  state: "pending" | "unavailable", evidenceOnly = false,
): Promise<void> {
  if (turn) await assertSourceKeyFingerprint(db, turn.keyFingerprint);
  const simpleFactId = factId.replace(/^semiote:/, "");
  if (evidenceOnly) {
    if (!turn || state === "unavailable") return;
    const id = createHash("sha256").update(JSON.stringify([userId, simpleFactId, turn.id])).digest("hex");
    await db.query(
      `UPSERT type::record('source_turn_evidence', $id) CONTENT {
        user_id: $userId, fact_id: $factId, turn_id: $turnId, scope: $scope,
        content_hmac: $hmac, key_fingerprint: $keyFingerprint,
        link_state: 'pending', non_equivalent: true
      };`,
      { id, userId, factId: simpleFactId, turnId: turn.id, scope: turn.scope,
        hmac: turn.contentHmac, keyFingerprint: turn.keyFingerprint },
    );
    return;
  }
  await db.query(
    `UPDATE type::record('semiote', $factId) SET
       source_turn_id = $turnId, source_turn_hmac = $hmac,
       source_turn_key_fingerprint = $keyFingerprint,
       source_turn_link_state = $state,
       source_turn_redaction_version = $redactionVersion
     WHERE user_id = $userId;`,
    { factId: simpleFactId, userId, turnId: turn?.id,
      hmac: turn?.contentHmac, keyFingerprint: turn?.keyFingerprint,
      state, redactionVersion: turn?.redactionVersion },
  );
}

/** Pending links carry no source text. Promote only exact tenant, scope and HMAC matches. */
export async function reconcileSourceTurnLinks(db: SurrealClient, turn: SourceTurn): Promise<void> {
  await assertSourceKeyFingerprint(db, turn.keyFingerprint);
  const stored = await db.query<any>(
    `SELECT user_id, scope, content_hmac FROM type::record('session_turn', $turnId)
       WHERE user_id = $userId AND scope = $scope AND content_hmac = $hmac
         AND key_fingerprint = $keyFingerprint;`,
    { userId: turn.userId, turnId: turn.id, scope: turn.scope,
      hmac: turn.contentHmac, keyFingerprint: turn.keyFingerprint },
  );
  if (!stored[0]?.length) return;
  await db.query(
    `BEGIN TRANSACTION;
     UPDATE semiote SET source_turn_link_state = 'linked'
       WHERE user_id = $userId AND source_turn_id = $turnId
         AND source_turn_hmac = $hmac AND source_turn_link_state = 'pending'
         AND source_turn_key_fingerprint = $keyFingerprint
         AND scope = $scope;
     UPDATE source_turn_evidence SET link_state = 'linked'
       WHERE user_id = $userId AND turn_id = $turnId
         AND content_hmac = $hmac AND key_fingerprint = $keyFingerprint
         AND scope = $scope AND link_state = 'pending';
     LET $facts = SELECT VALUE id FROM semiote WHERE user_id = $userId
       AND source_turn_id = $turnId AND source_turn_link_state = 'linked';
     LET $evidence = SELECT VALUE id FROM source_turn_evidence WHERE user_id = $userId
       AND turn_id = $turnId AND link_state = 'linked';
     IF array::len($facts) > 0 OR array::len($evidence) > 0 {
       UPDATE type::record('session_turn', $turnId) SET retention_class = 'linked', retain_until = NONE
         WHERE user_id = $userId AND content_hmac = $hmac
           AND key_fingerprint = $keyFingerprint;
     };
     COMMIT TRANSACTION;`,
    { userId: turn.userId, turnId: turn.id, hmac: turn.contentHmac,
      keyFingerprint: turn.keyFingerprint, scope: turn.scope },
  );
}

export async function unlinkFactSource(db: SurrealClient, userId: string, factId: string, nowIso = new Date().toISOString()): Promise<void> {
  const id = factId.replace(/^semiote:/, "");
  const rows = await db.query<any>(
    "SELECT source_turn_id FROM type::record('semiote', $id) WHERE user_id = $userId;", { id, userId },
  );
  const turnId = rows[0]?.[0]?.source_turn_id as string | undefined;
  const evidenceRows = await db.query<any>(
    "SELECT VALUE turn_id FROM source_turn_evidence WHERE user_id = $userId AND fact_id = $factId;",
    { userId, factId: id },
  );
  const affectedTurnIds = new Set<string>([
    ...(turnId ? [turnId] : []), ...((evidenceRows[0] ?? []) as string[]),
  ]);
  const retainUntil = new Date(Date.parse(nowIso) + 365 * 24 * 3600 * 1000).toISOString();
  await db.query(
    `BEGIN TRANSACTION;
     UPDATE type::record('semiote', $id) SET source_turn_id = NONE,
       source_turn_hmac = NONE, source_turn_link_state = 'unavailable'
       WHERE user_id = $userId;
     DELETE source_turn_evidence WHERE user_id = $userId AND fact_id = $factId;
     FOR $turnId IN $affectedTurnIds {
       LET $facts = SELECT VALUE id FROM semiote WHERE user_id = $userId
         AND source_turn_id = $turnId AND source_turn_link_state = 'linked';
       LET $evidence = SELECT VALUE id FROM source_turn_evidence WHERE user_id = $userId
         AND turn_id = $turnId AND link_state = 'linked';
       IF array::len($facts) = 0 AND array::len($evidence) = 0 {
         UPDATE type::record('session_turn', $turnId) SET retention_class = 'unlinked',
           retain_until = <datetime>$retainUntil WHERE user_id = $userId;
       };
     };
     COMMIT TRANSACTION;`,
    { id, userId, factId: id, affectedTurnIds: [...affectedTurnIds], retainUntil },
  );
}

/** Erase bypasses both retention clocks. Tombstone the local spool first so
 * a queued replay cannot recreate a forgotten turn after the DB deletion. */
export async function forgetSourceSession(
  db: SurrealClient, userId: string, sessionId: string,
  spool: Pick<SourceTurnSpool, "forgetSession" | "forget">,
): Promise<void> {
  await spool.forgetSession(userId, sessionId);
  const rows = await db.query<any>(
    "SELECT VALUE record::id(id) FROM session_turn WHERE user_id = $userId AND session_id = $sessionId;",
    { userId, sessionId },
  );
  const ids = (rows[0] ?? []) as string[];
  await spool.forget(ids);
  if (!ids.length) return;
  await db.query(
    `BEGIN TRANSACTION;
     UPDATE semiote SET source_turn_id = NONE, source_turn_hmac = NONE,
       source_turn_link_state = 'unavailable'
       WHERE user_id = $userId AND source_turn_id IN $ids;
     DELETE source_turn_evidence WHERE user_id = $userId AND turn_id IN $ids;
     DELETE session_turn_chunk WHERE user_id = $userId AND turn_id IN $ids;
     DELETE session_turn WHERE user_id = $userId AND record::id(id) IN $ids;
     COMMIT TRANSACTION;`,
    { userId, ids },
  );
}

export async function forgetSourceUser(
  db: SurrealClient, userId: string, spool: Pick<SourceTurnSpool, "forgetUser" | "forget">,
): Promise<void> {
  await spool.forgetUser(userId);
  const rows = await db.query<any>(
    "SELECT VALUE record::id(id) FROM session_turn WHERE user_id = $userId;", { userId },
  );
  const ids = (rows[0] ?? []) as string[];
  await spool.forget(ids);
  await db.query(
    `BEGIN TRANSACTION;
     UPDATE semiote SET source_turn_id = NONE, source_turn_hmac = NONE,
       source_turn_link_state = 'unavailable' WHERE user_id = $userId AND source_turn_id != NONE;
     DELETE source_turn_evidence WHERE user_id = $userId;
     DELETE session_turn_chunk WHERE user_id = $userId;
     DELETE session_turn WHERE user_id = $userId;
     COMMIT TRANSACTION;`, { userId },
  );
}
