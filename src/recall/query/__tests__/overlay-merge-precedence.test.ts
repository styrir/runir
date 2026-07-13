/**
 * Overlay-leg dedupe-precedence — Rúnir-yod0.3.16.
 *
 * Pins ADR 0009 §Dedupe-precedence rule: on a memoryId collision between
 * the durable RRF leg and the overlay snapshot (common under merge-update
 * per the merge-update overlay put in `arbitrateWrite`), the overlay row
 * wins on text + score. The durable hit is dropped, NOT RRF-fused.
 */

import { describe, it, expect, vi } from "vitest";
import type { SearchHit } from "../../../domain/memory/types.js";
import type { SurrealClient } from "../../../storage/surreal/surreal-store.js";
import type { OverlayLockKey } from "../../../storage/writes/overlay-supersession.js";
import { createOverlayRegistry } from "../../../storage/overlay/overlay-store.js";
import { mergeOverlayLeg } from "../overlay-merge.js";

const FIXED_NOW_MS = 1_700_000_000_000;

function makeRegistry() {
  return createOverlayRegistry({
    perTenantCap: 256,
    ttlMs: 120_000,
    globalAggregateCap: 5_000,
    now: () => FIXED_NOW_MS,
  });
}

describe("mergeOverlayLeg — dedupe-precedence (Rúnir-yod0.3.16)", () => {
  it("merge-update collision: overlay wins on text+score", async () => {
    const registry = makeRegistry();
    const lockKey: OverlayLockKey = {
      factKey: "preference:indentation",
      continuitySubjectKey: "user:user-a",
    };

    // Seed overlay with the post-merge-update value.
    registry.forUser("user-a").put(lockKey, {
      memoryId: "M1",
      text: "user prefers tabs over spaces with width 4",
      lockKey,
      userId: "user-a",
      score: 0.95,
      committedAtMs: FIXED_NOW_MS,
      expiresAtMs: FIXED_NOW_MS + 120_000,
      lastAccessedAtMs: FIXED_NOW_MS,
      active: true,
      outcome: "merge-update",
    });

    // Durable RRF leg returned the same memoryId with the pre-merge text and
    // a different RRF score. Active=true makes the hash-join hit.
    const durableHits: SearchHit[] = [
      {
        id: "M1",
        text: "user prefers tabs",
        score: 0.42,
        active: true,
      },
    ];

    const dbQuery = vi.fn();
    const db = { query: dbQuery } as unknown as SurrealClient;

    const merged = await mergeOverlayLeg({
      db,
      userId: "user-a",
      overlay: { registry },
      durableHits,
      tableName: "semiote",
    });

    // Single hit (deduped). Overlay text + score win.
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("M1");
    expect(merged[0].text).toBe("user prefers tabs over spaces with width 4");
    expect(merged[0].score).toBe(0.95);
    // continuitySubjectKey lifted from overlay's lock key.
    expect(merged[0].continuitySubjectKey).toBe("user:user-a");
    // Hash-join handled the active filter; no DB call.
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
