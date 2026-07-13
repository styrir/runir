import type { MemoryScope, RecentWrite, WriteSource } from "../../domain/memory/types.js";
import {
  buildArbitrationPartitionRef,
  resolveCanonicalContextIdentity,
} from "../../identity/canonical-context.js";
import { normalizeText } from "./text-normalize.js";

export function getRecentWriteKey(userId: string, scope: MemoryScope, sessionId?: string): string {
  return buildArbitrationPartitionRef(
    resolveCanonicalContextIdentity({ userId, sessionId }),
    scope,
  ).partitionKey;
}

/**
 * Rúnir-h435.1 PIN-9 (R2-1): PURE pruned VIEW of the recent-writes cache.
 * Filters expired entries without mutating the map — decision inputs consume this
 * so a pre-boundary failure leaves the physical map untouched (incl. stale entries).
 * Physical mutation stays in `pruneRecentWrites` (side-effect phase after attempt boundary).
 */
export function prunedRecentWritesView(
  recentWrites: Map<string, RecentWrite[]>,
  ttlMs: number,
  nowMs?: number,
): Map<string, RecentWrite[]> {
  const cutoffMs = (nowMs ?? Date.now()) - ttlMs;
  const view = new Map<string, RecentWrite[]>();
  for (const [key, entries] of recentWrites.entries()) {
    const retained = entries.filter((entry) => entry.writtenAtMs >= cutoffMs);
    if (retained.length > 0) {
      view.set(key, retained);
    }
  }
  return view;
}

export function pruneRecentWrites(
  recentWrites: Map<string, RecentWrite[]>,
  ttlMs: number,
  // Rúnir-pn1l Q4 U2: optional injected clock. Omitted ⇒ `Date.now()` (byte-identical
  // prod path). Under fast chronological replay the wall clock would over-populate the
  // 5-min recent-write TTL window vs. simulated pacing, distorting the exact-dup/recent-
  // near-dup skip band; the seeder passes the replay event time so the cache is pruned
  // against simulated time.
  nowMs?: number,
): void {
  const cutoffMs = (nowMs ?? Date.now()) - ttlMs;

  for (const [key, entries] of recentWrites.entries()) {
    const retained = entries.filter((entry) => entry.writtenAtMs >= cutoffMs);
    if (retained.length > 0) {
      recentWrites.set(key, retained);
    } else {
      recentWrites.delete(key);
    }
  }
}

export function rememberWrite(
  recentWrites: Map<string, RecentWrite[]>,
  text: string,
  embedding: number[],
  userId: string,
  scope: MemoryScope,
  sessionId: string | undefined,
  source: WriteSource,
  // Rúnir-pn1l Q4 U2: optional injected clock for the in-memory recent-write cache
  // entry timestamp. Omitted ⇒ `Date.now()` (byte-identical prod path). The seeder
  // passes the replay event time so `pruneRecentWrites` (also clock-injected) ages
  // these entries against simulated pacing rather than fast wall-clock replay time.
  nowMs?: number,
): void {
  const key = getRecentWriteKey(userId, scope, sessionId);
  const entries = recentWrites.get(key) ?? [];
  entries.unshift({
    text,
    normalizedText: normalizeText(text),
    embedding,
    userId,
    scope,
    sessionId,
    source,
    writtenAtMs: nowMs ?? Date.now(),
  });
  recentWrites.set(key, entries.slice(0, 20));
}
