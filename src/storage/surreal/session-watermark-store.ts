import type { SessionWatermark } from "../../domain/memory/types";
import type { SurrealClient } from "./surreal-client.js";

export async function ensureSessionWatermarksTable(db: SurrealClient): Promise<void> {
  await db.query(
    "DEFINE FIELD IF NOT EXISTS session_key ON TABLE session_watermarks TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS user_id ON TABLE session_watermarks TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS captured_at ON TABLE session_watermarks TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS message_count ON TABLE session_watermarks TYPE int;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_sw_key_user ON TABLE session_watermarks COLUMNS session_key, user_id;",
  );
}

/** Retrieves the most recent watermark for a session+user pair. */
export async function getLastWatermark(
  db: SurrealClient,
  sessionKey: string,
  userId: string,
): Promise<SessionWatermark | null> {
  const results = await db.query<any>(
    `SELECT * FROM session_watermarks WHERE session_key = $sk AND user_id = $uid ORDER BY captured_at DESC LIMIT 1;`,
    { sk: sessionKey, uid: userId },
  );
  const rows = results[0] ?? [];
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    session_key: r.session_key,
    user_id: r.user_id,
    captured_at: typeof r.captured_at === "string" ? r.captured_at : new Date(r.captured_at).toISOString(),
    message_count: Number(r.message_count ?? 0),
  };
}

/** Creates (or replaces) the watermark record for a session+user pair.
 *  Uses DELETE + CREATE to ensure at most one row per session+user. */
export async function createWatermark(
  db: SurrealClient,
  sessionKey: string,
  userId: string,
  messageCount: number,
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `DELETE session_watermarks WHERE session_key = $sk AND user_id = $uid;`,
    { sk: sessionKey, uid: userId },
  );
  await db.query(
    `CREATE session_watermarks CONTENT {
       session_key: $sk,
       user_id: $uid,
       captured_at: <datetime>$now,
       message_count: $mc
     };`,
    { sk: sessionKey, uid: userId, now, mc: messageCount },
  );
}
