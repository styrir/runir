/**
 * Overlay-leg post-supersede phantom prevention — Rúnir-yod0.3.16.
 *
 * Pins ADR 0009 §Phantom-prevention rules row 1: a superseded entry MUST
 * NOT be returned by the overlay leg. The merge layer's two defenses are:
 *
 *   - Co-eviction at write time: the supersede branch in
 *     `src/storage/writes/write-arbitrator.ts` (yod0.3.13) deletes the
 *     prior overlay entry before put.
 *   - Active-filter step at read time: even if the prior entry survives
 *     (force-reinjected here to simulate a co-evict bug), the merge's
 *     hash-join + batched fallback against `semiote.active` drops it.
 *
 * This test exercises the read-side defense (force-reinjects the prior
 * memoryId into overlay, returns the durable batched fallback as
 * `active=false`, verifies the prior memoryId is absent from the merged
 * result).
 */

import { describe, it, expect, vi } from "vitest";
import type { SearchHit } from "../../../domain/memory/types.js";
import type { SurrealClient } from "../../../storage/surreal/surreal-store.js";
import type { OverlayLockKey } from "../../../storage/writes/overlay-supersession.js";
import { createOverlayRegistry } from "../../../storage/overlay/overlay-store.js";
import { mergeOverlayLeg } from "../overlay-merge.js";

const FIXED_NOW_MS = 1_700_000_000_000;

describe("mergeOverlayLeg — post-supersede phantom prevention (Rúnir-yod0.3.16)", () => {
  it("superseded entry not returned by overlay leg", async () => {
    const registry = createOverlayRegistry({
      perTenantCap: 256,
      ttlMs: 120_000,
      globalAggregateCap: 5_000,
      now: () => FIXED_NOW_MS,
    });
    const lockKey: OverlayLockKey = {
      factKey: "project:auth-token-ttl",
      continuitySubjectKey: "project:auth-service",
    };

    // Force-reinject the SUPERSEDED memoryId (M1) — simulates a co-evict
    // bug where overlay.delete(prior) was missed at supersede time.
    // Overlay's local `active` field reflects the value at write time
    // (still true, because at write time the entry was active).
    registry.forUser("user-a").put(lockKey, {
      memoryId: "M1",
      text: "JWT_EXPIRY: 3600",
      lockKey,
      userId: "user-a",
      score: 0.9,
      committedAtMs: FIXED_NOW_MS - 5_000,
      expiresAtMs: FIXED_NOW_MS + 115_000,
      lastAccessedAtMs: FIXED_NOW_MS - 5_000,
      active: true,
      outcome: "create",
    });

    // Durable RRF returns M2 (the new active memory) as a top hit.
    // M1 is NOT in durableHits because the durable ACTIVE_MEMORY_FILTER
    // strips inactive rows at the SQL level. M1 therefore lands in the
    // residual bucket and goes through the batched fallback read.
    const durableHits: SearchHit[] = [
      {
        id: "M2",
        text: "JWT_EXPIRY: 900",
        score: 0.7,
        active: true,
      },
    ];

    // Batched fallback returns M1 with active=false (durable supersede
    // flipped the bit). The merge MUST drop M1 from the overlay leg.
    const dbQuery = vi.fn().mockResolvedValueOnce([
      [{ id: "M1", active: false }],
    ]);
    const db = { query: dbQuery } as unknown as SurrealClient;

    const merged = await mergeOverlayLeg({
      db,
      userId: "user-a",
      overlay: { registry },
      durableHits,
      tableName: "semiote",
    });

    // M1 must NOT appear; M2 must remain.
    expect(merged.find((h) => h.id === "M1")).toBeUndefined();
    expect(merged.find((h) => h.id === "M2")).toBeDefined();

    // Exactly one batched read for the residual id set.
    expect(dbQuery).toHaveBeenCalledTimes(1);
    const [, params] = dbQuery.mock.calls[0];
    expect(params).toEqual({ ids: ["M1"] });
  });
});
