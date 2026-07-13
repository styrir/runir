import type { SurrealClient } from "../../storage/surreal/surreal-store.js";

/**
 * Attempts to acquire a TTL lease lock for a userId/scope pair.
 * Uses a SurrealDB transaction to atomically check-and-create.
 *
 * Returns holder ID (UUID string) on success.
 * Returns null if the lock is already held.
 */
export async function acquireLock(
  db: SurrealClient,
  key: string,
  ttlSeconds: number,
): Promise<string | null> {
  const holder = crypto.randomUUID();
  const ttl = Math.max(1, Math.floor(ttlSeconds));

  // The UNIQUE index on lock_key is the arbiter: reap any expired lease, then
  // CREATE the new one — a live lease makes the CREATE throw an idx_cl_key
  // rejection, which IS the contention signal. The previous transaction-based
  // `RETURN $existing` pattern was unparseable through normalizeResults (every
  // null statement result normalizes to [], so the "last array wins" heuristic
  // always read COMMIT's empty array) — acquire NEVER reported contention.
  // Empirically confirmed 2026-06-11 (Rúnir-x46j): zero skipped_lock rows in
  // the table's entire history; two concurrent acquires both "succeeded".
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
      return null; // live lease held by someone else
    }
    throw err; // real DB failure — stay loud, do not masquerade as contention
  }
}

/**
 * Extends the TTL lease of a held lock (heartbeat). Only matches when both
 * key and holder match, so it can never steal another holder's lock.
 *
 * Returns true when the lease was extended, false when no matching row exists
 * (lease already expired and was reaped by a competing acquireLock). Callers
 * treat false as advisory — the run continues, but overlap protection is gone
 * for the remainder of that run (Rúnir-x46j: the fixed 300s TTL expired during
 * multi-hour consolidation runs and the hourly tick started overlapping passes
 * on the same tenant).
 */
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

/**
 * Releases a previously acquired lock.
 * Only deletes if both key and holder match — prevents accidental release of another holder's lock.
 */
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

/**
 * Writes a staleness backlog entry when the staleness pass is skipped due to lock contention.
 * Stores the full fact-level inputs so they can be replayed by the consolidation sweep.
 */
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

/**
 * Ensures the consolidation_locks table schema exists.
 * Safe to call on every startup — uses IF NOT EXISTS.
 */
export async function ensureConsolidationLockTable(
  db: SurrealClient,
): Promise<void> {
  await db.query(
    "DEFINE TABLE IF NOT EXISTS consolidation_locks SCHEMAFULL;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS lock_key ON TABLE consolidation_locks TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS holder ON TABLE consolidation_locks TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS acquired_at ON TABLE consolidation_locks TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS expires_at ON TABLE consolidation_locks TYPE datetime;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_cl_key ON TABLE consolidation_locks COLUMNS lock_key UNIQUE;",
  );
}

/**
 * Ensures the staleness_backlog table schema exists.
 */
export async function ensureStalenessBacklogTable(
  db: SurrealClient,
): Promise<void> {
  await db.query(
    "DEFINE TABLE IF NOT EXISTS staleness_backlog SCHEMAFULL;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS user_id ON TABLE staleness_backlog TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS scope ON TABLE staleness_backlog TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS session_id ON TABLE staleness_backlog TYPE option<string>;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS triggered_at ON TABLE staleness_backlog TYPE datetime;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS facts ON TABLE staleness_backlog TYPE array;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS status ON TABLE staleness_backlog TYPE string;",
  );
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_sb_status ON TABLE staleness_backlog COLUMNS status, user_id;",
  );
}
