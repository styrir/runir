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
 *      durable result), AT MOST ONE batched read with typed current-table
 *      RecordIds and both current-user predicates. Per-row reads are forbidden
 *      by the `≤1 batched fallback` invariant.
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
import { RecordId } from "surrealdb";
import { attachSelectedSearchHitLineage } from "../../domain/memory/search-hit-lineage.js";
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

type OverlayDurableRow = {
  id: unknown;
  user_id: unknown;
  payload_user_id: unknown;
  active: unknown;
  processing_lineage?: unknown;
};

function isNonEmptyUserIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validatedDurableRow(
  row: OverlayDurableRow,
  requestedIds: ReadonlySet<string>,
  userId: string,
): OverlayDurableRow | undefined {
  // Membership and both stored tenant identities are checked before touching
  // selected lineage. Invalid rows must not get a classification callback or
  // a getter trap opportunity through the lineage carrier.
  let id: string;
  try {
    id = extractId(row.id);
  } catch {
    return undefined;
  }
  if (!requestedIds.has(id)) return undefined;
  let rootUser: unknown;
  let payloadUser: unknown;
  let active: unknown;
  try {
    rootUser = row.user_id;
    payloadUser = row.payload_user_id;
    active = row.active;
  } catch {
    return undefined;
  }
  if (!isNonEmptyUserIdentity(rootUser) || !isNonEmptyUserIdentity(payloadUser)) return undefined;
  if (rootUser !== userId || payloadUser !== userId || active !== true) return undefined;

  // A selected row is now authorized for lineage inspection. A malformed
  // getter is still fail-closed; it cannot turn a residual overlay into an
  // apparently valid hit.
  try {
    return { ...row, id, processing_lineage: row.processing_lineage };
  } catch {
    return undefined;
  }
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
    if (entry.userId !== input.userId) continue;
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

  // Step 3 — AT MOST ONE batched fallback read for residuals. The projection
  // includes both current tenant identities and the selected top-level
  // lineage field; typed RecordIds and the requested-user predicates are the
  // query boundary, while overlay flags and payload copies are never storage
  // authority.
  const durableRowsById = new Map<string, OverlayDurableRow>();
  if (residualIds.length > 0) {
    const requestedIds = new Set(residualIds);
    const boundIds = [...requestedIds].map((id) => new RecordId(tableName, id));
    const rows = await input.db.query<OverlayDurableRow>(
      `SELECT id, user_id, payload.userId AS payload_user_id, active, processing_lineage
       FROM ${tableName}
       WHERE id IN $ids
         AND user_id = $requestedUser
         AND payload.userId = $requestedUser`,
      { ids: boundIds, requestedUser: input.userId },
    );
    for (const row of rows[0] ?? []) {
      const validated = validatedDurableRow(row, requestedIds, input.userId);
      if (!validated) continue;
      durableRowsById.set(extractId(validated.id), validated);
    }
    for (const entry of tentativeKeepers) {
      if (durableRowsById.has(entry.memoryId)) {
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
    const durableRow = durableRowsById.get(entry.memoryId);
    fused.set(
      entry.memoryId,
      overlayEntryToSearchHit(
        entry,
        fused.get(entry.memoryId),
        durableRow?.processing_lineage,
        durableRow !== undefined,
      ),
    );
  }
  return Array.from(fused.values());
}

function overlayEntryToSearchHit(
  entry: OverlayEntry,
  prior: SearchHit | undefined,
  selectedProcessingLineage?: unknown,
  lineageSelectionEstablished = false,
): SearchHit {
  const committedIso = new Date(entry.committedAtMs).toISOString();
  // Start with the current durable hit so R2's private carrier and any other
  // neutral retrieval metadata survive overlay-wins text/score replacement.
  // The string-keyed field is never read authority and is stripped even if a
  // foreign/mock durable hit supplied one.
  const replacement = {
    ...prior,
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
    // The overlay's active bit is advisory. A row survived the current
    // durable active join (or the selected fallback row), so retain that
    // durable state even when a caller supplied a conflicting overlay value.
    active: prior?.active ?? (lineageSelectionEstablished ? true : undefined),
    inactiveReason: prior?.inactiveReason,
    supersededById: prior?.supersededById,
    lineageRootId: prior?.lineageRootId,
    memoryRole: prior?.memoryRole,
    validAt: prior?.validAt,
    invalidAt: prior?.invalidAt,
    continuitySubjectKey: entry.lockKey.continuitySubjectKey,
    scoreStages: prior?.scoreStages,
  } as SearchHit & Record<string, unknown>;
  delete replacement.processing_lineage;

  // This row came from the owned SELECT projection above, so an absent field
  // is an observed legacy row. Do not classify an arbitrary overlay or mock
  // property as selected storage evidence.
  return lineageSelectionEstablished
    ? attachSelectedSearchHitLineage(replacement, selectedProcessingLineage)
    : replacement;
}
