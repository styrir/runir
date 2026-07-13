import type { SurrealClient } from "./surreal-client.js";

export async function ensureRejectionLogTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS rejection_log SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS reason ON TABLE rejection_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS candidate_text ON TABLE rejection_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS confidence ON TABLE rejection_log TYPE option<float>;");
  await db.query("DEFINE FIELD IF NOT EXISTS session_id ON TABLE rejection_log TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS user_id ON TABLE rejection_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS rejected_at ON TABLE rejection_log TYPE datetime;");
}

export async function logRejection(db: SurrealClient, params: {
  reason: string;
  candidateText: string;
  confidence?: number;
  sessionId?: string;
  userId: string;
}): Promise<void> {
  await db.query(
    `CREATE rejection_log SET reason=$reason, candidate_text=$text, confidence=$conf, session_id=$sid, user_id=$uid, rejected_at=time::now();`,
    { reason: params.reason, text: params.candidateText.slice(0, 200), conf: params.confidence, sid: params.sessionId, uid: params.userId }
  ).catch(() => {}); // fire-and-forget, never block capture on rejection logging
}
