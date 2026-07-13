import type { SurrealClient } from "./surreal-client.js";
import { DEFAULT_FINGERPRINT_TTL_MS, _fingerprintCache } from "./surreal-client.js";

export async function ensureEmbeddingMetadataTable(db: SurrealClient): Promise<void> {
  await db.query(
    "DEFINE FIELD IF NOT EXISTS fingerprint ON TABLE embedding_metadata TYPE string;",
  );
  await db.query(
    "DEFINE FIELD IF NOT EXISTS set_at ON TABLE embedding_metadata TYPE datetime;",
  );
}

/** Reads the stored embedding fingerprint, or null if none is set.
 *  Result is cached per-client for DEFAULT_FINGERPRINT_TTL_MS to avoid a DB
 *  round-trip on every recall.  setEmbeddingFingerprint invalidates immediately.
 */
export async function getEmbeddingFingerprint(db: SurrealClient): Promise<string | null> {
  const now = Date.now();
  const cached = _fingerprintCache.get(db);
  if (cached !== undefined && now < cached.expiresAt) {
    return cached.fingerprint;
  }

  const results = await db.query<any>(
    "SELECT fingerprint FROM embedding_metadata:current;",
  );
  const rows = results[0] ?? [];
  const fingerprint = rows.length === 0 ? null : (rows[0]?.fingerprint ?? null);

  _fingerprintCache.set(db, { fingerprint, expiresAt: now + DEFAULT_FINGERPRINT_TTL_MS });
  return fingerprint;
}

/** Upserts the embedding fingerprint with the current timestamp.
 *  Synchronously invalidates the in-process cache for this client so the very
 *  next recall sees the new fingerprint without waiting for TTL expiry.
 */
export async function setEmbeddingFingerprint(db: SurrealClient, fp: string): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `UPSERT embedding_metadata:current CONTENT {
       fingerprint: $fp,
       set_at: <datetime>$now
     };`,
    { fp, now },
  );
  // Invalidate after the UPSERT resolves so the next read re-queries (or we
  // could prime the cache directly — delete is simpler and equally correct).
  _fingerprintCache.delete(db);
}

