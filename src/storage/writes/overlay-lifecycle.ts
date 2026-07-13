import type {
  TraceLifecycleEvent,
  TraceMemoryCommittedEvent,
  TraceMemoryIndexedEvent,
} from "../../recall/selection/retrieval-trace.js";
import {
  type OverlayEntry,
  type OverlayRegistry,
} from "../overlay/overlay-store.js";
import { buildOverlayKey } from "./overlay-supersession.js";

/** Optional overlay handle. When supplied, successful writes synchronously
 *  populate the per-userId overlay so retrieval can satisfy read-your-writes
 *  before the durable index catches up. The handle is read on the same
 *  microtask as the durable-write resolution; see Rúnir-yod0.3.13 wiring and
 *  Rúnir-yod0.3.15 synchrony pinning. */
export interface OverlayHandle {
  registry: OverlayRegistry;
  ttlMs: number;
  now?: () => number;
  /** Optional trace emit — fires `memory_committed` on the same microtask as
   *  the overlay-put, before `arbitrateWrite` returns. ADR 0009 §Synchrony
   *  pins this on the durable-resolve continuation; the synchrony test pair
   *  at `src/storage/writes/__tests__/overlay-put-synchrony.test.ts` enforces
   *  the contract. `memory_indexed` emit is async and decoupled from this
   *  call site (see `recordMemoryIndexed` in `src/obs/counters.ts`). */
  traceEmit?: (event: TraceLifecycleEvent) => void;
}

export function buildOverlayEntry(
  overlay: OverlayHandle,
  userId: string,
  memoryId: string,
  text: string,
  factKey: string,
  continuitySubjectKey: string,
  outcome: OverlayEntry["outcome"],
): OverlayEntry {
  const nowMs = overlay.now ? overlay.now() : Date.now();
  return {
    memoryId,
    text,
    lockKey: { factKey, continuitySubjectKey },
    userId,
    score: 1,
    committedAtMs: nowMs,
    expiresAtMs: nowMs + overlay.ttlMs,
    lastAccessedAtMs: nowMs,
    active: true,
    outcome,
  };
}

/** Emit `memory_committed` on the same microtask as the overlay-put.
 *  Caller is the synchronous return path of `arbitrateWrite`; ADR 0009
 *  §Synchrony forbids any deferral (`await`, `.then`, `queueMicrotask`,
 *  `setImmediate`) between durable-resolve and this call. */
export function emitMemoryCommitted(
  overlay: OverlayHandle,
  entry: OverlayEntry,
): void {
  if (!overlay.traceEmit) return;
  const event: TraceMemoryCommittedEvent = {
    type: "memory_committed",
    memoryId: entry.memoryId,
    lockKey: entry.lockKey,
    outcome: entry.outcome,
    committedAtMs: entry.committedAtMs,
  };
  overlay.traceEmit(event);
}

/** Emit `memory_indexed` after the durable write resolves and the index is
 *  visible. In today's codebase SurrealDB upserts maintain vector + FTS
 *  indexes synchronously within the same transaction, so this co-fires
 *  with `memory_committed`; the drift contract `committedCount >=
 *  indexedCount` (committedIndexedDrift in src/obs/counters.ts) is
 *  trivially satisfied. The seam stays in place so a future async-index
 *  topology can fire `memory_indexed` from a separate visibility hook
 *  without touching call-sites that consume the trace surface. ADR 0009
 *  §Phantom-prevention rules row 2 documents the drift detector. */
export function emitMemoryIndexed(
  overlay: OverlayHandle,
  entry: OverlayEntry,
): void {
  if (!overlay.traceEmit) return;
  const event: TraceMemoryIndexedEvent = {
    type: "memory_indexed",
    memoryId: entry.memoryId,
    indexedAtMs: entry.committedAtMs,
  };
  overlay.traceEmit(event);
}

export function lockKeyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): { factKey: string; continuitySubjectKey: string } | null {
  if (!metadata) return null;
  const factKey = metadata.factKey;
  const continuitySubjectKey = metadata.continuitySubjectKey;
  return buildOverlayKey(
    typeof factKey === "string" ? factKey : null,
    typeof continuitySubjectKey === "string" ? continuitySubjectKey : null,
  );
}
