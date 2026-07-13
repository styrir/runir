// Raw session-turn retention (Rúnir-b40x.3) — the Tier-2 feed.
//
// Rúnir persists EXTRACTIONS (semiotes), not transcripts; the nightly deep
// sweep (b40x.5) needs each day-session's FULL text, reassembled uniformly for
// every client (claude/codex/hermes) without per-agent transcript-file
// collectors. /hooks/session-end is the one place turns arrive with reliable
// ABSOLUTE indexing (messageOffset + watermark increments), so turns are
// recorded there — and ONLY there. Documented limitation: sessions that crash
// before session-end leave no turns (the Tier-1 entity-miss signal still
// covers them).
//
// Sensitivity: verbatim conversation text — same class as retrieval_trace
// prompt/answer. Any read surface must require an explicit userId.

import { randomUUID } from "node:crypto";
import type { SurrealClient } from "./surreal-store";

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

export type SessionTurnRow = {
  user_id: string;
  session_id: string;
  client?: string;
  turn_index: number;
  role: string;
  content: string;
  created_at: string;
};

export async function ensureSessionTurnSchema(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS session_turn SCHEMALESS;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE session_turn TYPE string;
    DEFINE FIELD IF NOT EXISTS session_id ON TABLE session_turn TYPE string;
    DEFINE FIELD IF NOT EXISTS client ON TABLE session_turn TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS turn_index ON TABLE session_turn TYPE int;
    DEFINE FIELD IF NOT EXISTS role ON TABLE session_turn TYPE string;
    DEFINE FIELD IF NOT EXISTS content ON TABLE session_turn TYPE string;
    DEFINE FIELD IF NOT EXISTS created_at ON TABLE session_turn TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_unique ON TABLE session_turn COLUMNS user_id, session_id, turn_index UNIQUE;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_user_created ON TABLE session_turn COLUMNS user_id, created_at;
    DEFINE INDEX IF NOT EXISTS idx_session_turn_user_session ON TABLE session_turn COLUMNS user_id, session_id;
  `);
}

/**
 * Records a batch of turns. Idempotent across watermark overlaps and hook
 * retries: the (user_id, session_id, turn_index) UNIQUE index rejects
 * duplicates and the per-row INSERT swallows that rejection — re-delivered
 * batches are no-ops, never errors. Callers treat the whole function as
 * fire-and-forget; it must never throw into the session-end path.
 */
export async function recordSessionTurns(
  db: SurrealClient,
  input: SessionTurnInput,
  warn?: (msg: string) => void,
): Promise<number> {
  if (input.turns.length === 0) return 0;
  const createdAt = new Date().toISOString();
  let written = 0;
  for (const turn of input.turns) {
    try {
      await db.query(
        `CREATE type::record('session_turn', $id) CONTENT {
           user_id: $userId,
           session_id: $sessionId,
           client: $client,
           turn_index: $turnIndex,
           role: $role,
           content: $content,
           created_at: <datetime>$createdAt
         };`,
        {
          id: randomUUID(),
          userId: input.userId,
          sessionId: input.sessionId,
          client: input.client ?? undefined,
          turnIndex: turn.turnIndex,
          role: turn.role,
          content: turn.content,
          createdAt,
        },
      );
      written += 1;
    } catch (err) {
      const msg = String(err);
      // UNIQUE-index rejection = already recorded (watermark overlap / retry).
      if (!msg.includes("idx_session_turn_unique") && !msg.includes("already contains")) {
        warn?.(`session-turn: write failed (turn ${turn.turnIndex}): ${msg.slice(0, 160)}`);
      }
    }
  }
  return written;
}

/** Turns for one user since an ISO cutoff, ordered for session reassembly. */
export async function listSessionTurnsSince(
  db: SurrealClient,
  userId: string,
  sinceIso: string,
): Promise<SessionTurnRow[]> {
  const result = await db.query<any>(
    `SELECT user_id, session_id, client, turn_index, role, content, created_at
       FROM session_turn
      WHERE user_id = $userId AND created_at >= <datetime>$sinceIso
      ORDER BY session_id, turn_index;`,
    { userId, sinceIso },
  );
  return (result[0] ?? []) as SessionTurnRow[];
}

/**
 * Retention sweep — turns are an operational feed, not the memory of record;
 * everything durable about them lives in semiotes/noemata/entities. Runs on
 * the scheduler tick; the (user_id, created_at) index keeps it cheap.
 */
export async function deleteExpiredSessionTurns(
  db: SurrealClient,
  retentionDays: number,
): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
  await db.query(
    "DELETE session_turn WHERE created_at < <datetime>$cutoff;",
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
