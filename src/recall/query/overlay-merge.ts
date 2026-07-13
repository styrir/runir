/**
 * Retrieval-side overlay merge — Rúnir-yod0.3.16.
 *
 * Inserts the in-memory overlay leg between durable RRF fusion and the rest
 * of the retrieval pipeline. ADR 0009 §Read semantics, §Active-filter
 * batching, and §Dedupe-precedence rule pin the contract:
 *
 *   1. Snapshot the overlay for the current `userId` (frozen view).
 *   2. Filter the overlay snapshot by active status via in-memory hash-join
 *      against the durable RRF leg's existing `{memoryId, active}`
 *      projection (`src/storage/surreal/phase2-store.ts:261`).
 *   3. For residual ids (overlay entries whose memoryId is absent from the
 *      durable result), AT MOST ONE batched read:
 *      `SELECT id, active FROM <table> WHERE id IN $ids`. Per-row reads
 *      are forbidden by the `≤1 batched fallback` invariant.
 *   4. Dedupe-merge by `memoryId` with overlay-wins precedence. `memoryId`
 *      remains the compatibility field here until the overlay/read-model seam
 *      has an explicit discriminator design. Under
 *      merge-update collisions (the merge-update overlay put in `arbitrateWrite`),
 *      the overlay row's text + score replaces the durable hit's.
 *
 * Canonical anchor: `~/Documents/Obsidian Vault/1. Projects/Styrir/Runir/
 * Rúnir architectural improvement plan.md` §Priority 1 step 3.
 */

import type { MemoryRecordTable, SearchHit } from "../../domain/memory/types.js";
import {
  extractId,
  type SurrealClient,
} from "../../storage/surreal/surreal-store.js";
import type {
  OverlayEntry,
  OverlayRegistry,
} from "../../storage/overlay/overlay-store.js";

/** Optional retrieval-side handle. When supplied to `nativeRrfSearch`/
 *  `runHybridQuery`, the durable RRF result is merged with the overlay
 *  leg under the contract documented above. */
export interface OverlayRetrievalHandle {
  readonly registry: OverlayRegistry;
}

interface MergeOverlayLegInput {
  readonly db: SurrealClient;
  readonly userId: string;
  readonly overlay: OverlayRetrievalHandle;
  readonly durableHits: SearchHit[];
  readonly tableName: MemoryRecordTable;
}

export async function mergeOverlayLeg(
  input: MergeOverlayLegInput,
): Promise<SearchHit[]> {
  const tableName = input.tableName;
  const snapshot = input.overlay.registry.forUser(input.userId).snapshot();
  if (snapshot.length === 0) {
    return input.durableHits;
  }

  // Step 2 — hash-join active status from the durable RRF projection.
  const durableActiveByMemId = new Map<string, boolean>();
  for (const hit of input.durableHits) {
    if (typeof hit.active === "boolean") {
      durableActiveByMemId.set(hit.id, hit.active);
    }
  }

  const filteredOverlay: OverlayEntry[] = [];
  const residualIds: string[] = [];
  const tentativeKeepers: OverlayEntry[] = [];
  for (const entry of snapshot) {
    const fromDurable = durableActiveByMemId.get(entry.memoryId);
    if (fromDurable !== undefined) {
      if (fromDurable) {
        filteredOverlay.push(entry);
      }
      // else: durable says inactive — drop the overlay entry.
      continue;
    }
    residualIds.push(entry.memoryId);
    tentativeKeepers.push(entry);
  }

  // Step 3 — AT MOST ONE batched fallback read for residuals.
  if (residualIds.length > 0) {
    const rows = await input.db.query<{ id: unknown; active: unknown }>(
      `SELECT id, active FROM ${tableName} WHERE id IN $ids`,
      { ids: residualIds },
    );
    const residualActive = new Map<string, boolean>();
    for (const row of rows[0] ?? []) {
      residualActive.set(extractId(row.id), Boolean(row.active));
    }
    for (const entry of tentativeKeepers) {
      if (residualActive.get(entry.memoryId) === true) {
        filteredOverlay.push(entry);
      }
    }
  }

  // Step 4 — dedupe-merge with overlay-wins precedence.
  const fused = new Map<string, SearchHit>();
  for (const hit of input.durableHits) {
    fused.set(hit.id, hit);
  }
  for (const entry of filteredOverlay) {
    fused.set(
      entry.memoryId,
      overlayEntryToSearchHit(entry, fused.get(entry.memoryId)),
    );
  }
  return Array.from(fused.values());
}

function overlayEntryToSearchHit(
  entry: OverlayEntry,
  prior: SearchHit | undefined,
): SearchHit {
  const committedIso = new Date(entry.committedAtMs).toISOString();
  return {
    id: entry.memoryId,
    text: entry.text,
    score: entry.score,
    createdAt: prior?.createdAt ?? committedIso,
    updatedAt: committedIso,
    tags: prior?.tags,
    category: prior?.category,
    tier: prior?.tier,
    confidence: prior?.confidence,
    l0: prior?.l0,
    l1: prior?.l1,
    path: prior?.path,
    client: prior?.client,
    isStale: prior?.isStale,
    staleSince: prior?.staleSince,
    contradictedBy: prior?.contradictedBy,
    active: entry.active,
    inactiveReason: prior?.inactiveReason,
    supersededById: prior?.supersededById,
    lineageRootId: prior?.lineageRootId,
    memoryRole: prior?.memoryRole,
    validAt: prior?.validAt,
    invalidAt: prior?.invalidAt,
    continuitySubjectKey: entry.lockKey.continuitySubjectKey,
    scoreStages: prior?.scoreStages,
  };
}
