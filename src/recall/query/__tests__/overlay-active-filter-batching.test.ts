/**
 * Overlay-leg active-filter batching — Rúnir-yod0.3.16.
 *
 * Pins ADR 0009 §Active-filter batching: the overlay leg MUST avoid
 * per-row reads. When all overlay memoryIds are present in the durable
 * RRF projection, the in-memory hash-join handles the active filter with
 * ZERO DB calls. When residual ids exist (overlay entries absent from the
 * durable result), the merge falls through to AT MOST ONE batched
 * `SELECT id, active FROM <table> WHERE id IN $ids` — never a per-id
 * loop.
 */

import { describe, it, expect, vi } from "vitest";
import type { SearchHit } from "../../../domain/memory/types.js";
import type { SurrealClient } from "../../../storage/surreal/surreal-store.js";
import type { OverlayLockKey } from "../../../storage/writes/overlay-supersession.js";
import {
  createOverlayRegistry,
  type OverlayEntry,
} from "../../../storage/overlay/overlay-store.js";
import { mergeOverlayLeg } from "../overlay-merge.js";

const FIXED_NOW_MS = 1_700_000_000_000;

function seedEntry(memoryId: string, factKey: string): OverlayEntry {
  const lockKey: OverlayLockKey = {
    factKey,
    continuitySubjectKey: "user:user-a",
  };
  return {
    memoryId,
    text: `text-${memoryId}`,
    lockKey,
    userId: "user-a",
    score: 0.5,
    committedAtMs: FIXED_NOW_MS,
    expiresAtMs: FIXED_NOW_MS + 120_000,
    lastAccessedAtMs: FIXED_NOW_MS,
    active: true,
    outcome: "create",
  };
}

describe("mergeOverlayLeg — active-filter batching (Rúnir-yod0.3.16)", () => {
  it("zero per-row reads when all overlay ids appear in durable RRF projection", async () => {
    const registry = createOverlayRegistry({
      perTenantCap: 256,
      ttlMs: 120_000,
      globalAggregateCap: 5_000,
      now: () => FIXED_NOW_MS,
    });
    // Two overlay entries; both also appear in durable RRF hits below.
    for (const id of ["M1", "M2"]) {
      const entry = seedEntry(id, `fact-${id}`);
      registry.forUser("user-a").put(entry.lockKey, entry);
    }

    const durableHits: SearchHit[] = [
      { id: "M1", text: "durable-M1", score: 0.4, active: true },
      { id: "M2", text: "durable-M2", score: 0.3, active: true },
      { id: "M3", text: "durable-M3", score: 0.2, active: true },
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

    // ZERO DB calls — hash-join alone resolved every overlay id.
    expect(dbQuery).not.toHaveBeenCalled();
    // M1 and M2 won via overlay; M3 stayed durable.
    expect(merged).toHaveLength(3);
    expect(merged.find((h) => h.id === "M1")?.text).toBe("text-M1");
    expect(merged.find((h) => h.id === "M2")?.text).toBe("text-M2");
    expect(merged.find((h) => h.id === "M3")?.text).toBe("durable-M3");
  });

  it("≤1 batched fallback read when residual ids exist", async () => {
    const registry = createOverlayRegistry({
      perTenantCap: 256,
      ttlMs: 120_000,
      globalAggregateCap: 5_000,
      now: () => FIXED_NOW_MS,
    });
    // Three overlay entries: M1 hits durable; M2, M3 are residual.
    for (const id of ["M1", "M2", "M3"]) {
      const entry = seedEntry(id, `fact-${id}`);
      registry.forUser("user-a").put(entry.lockKey, entry);
    }

    const durableHits: SearchHit[] = [
      { id: "M1", text: "durable-M1", score: 0.4, active: true },
    ];

    // Batched fallback: M2 active=true, M3 active=false (so M3 is dropped).
    const dbQuery = vi.fn().mockResolvedValueOnce([
      [
        { id: "M2", active: true },
        { id: "M3", active: false },
      ],
    ]);
    const db = { query: dbQuery } as unknown as SurrealClient;

    const merged = await mergeOverlayLeg({
      db,
      userId: "user-a",
      overlay: { registry },
      durableHits,
      tableName: "semiote",
    });

    // EXACTLY ONE batched fallback call — never per-id.
    expect(dbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(typeof sql).toBe("string");
    // The bound parameter is the residual id ARRAY (no per-id loop).
    expect(params).toEqual({ ids: ["M2", "M3"] });

    // M1 (overlay-wins on durable hit), M2 (residual + active) kept;
    // M3 (residual + inactive) dropped.
    expect(merged.find((h) => h.id === "M1")?.text).toBe("text-M1");
    expect(merged.find((h) => h.id === "M2")?.text).toBe("text-M2");
    expect(merged.find((h) => h.id === "M3")).toBeUndefined();
  });
});
