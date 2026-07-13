import { describe, it, expect, vi } from "vitest";
import {
  backfillL2FromData,
  softInactivateNoDataRecords,
  verify,
  type MigrationDb,
} from "../../scripts/migration-mim64";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb(responses: unknown[][][]): MigrationDb & { callCount: number } {
  let callCount = 0;
  const db = {
    get callCount() {
      return callCount;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: vi.fn(async (_sql: string): Promise<any[][]> => {
      const result = responses[callCount] ?? [[]];
      callCount++;
      return result as unknown[][];
    }),
  };
  return db as MigrationDb & { callCount: number };
}

// ---------------------------------------------------------------------------
// Phase 1: backfillL2FromData
// ---------------------------------------------------------------------------

describe("backfillL2FromData", () => {
  it("loops until rows_affected = 0 and returns total migrated", async () => {
    // New pattern: SELECT ids (call 1) → UPDATE (call 2) → SELECT ids returns 0 (call 3 = done)
    const db = makeMockDb([
      [[{ id: "memories:1" }, { id: "memories:2" }]], // SELECT: 2 ids
      [[{ id: "memories:1" }, { id: "memories:2" }]], // UPDATE: 2 rows updated
      [[]], // SELECT: 0 ids — loop ends
    ]);

    const total = await backfillL2FromData(db);

    expect(total).toBe(2);
  });

  it("stops immediately when first call returns 0 rows", async () => {
    // SELECT returns 0 ids immediately — no UPDATE call made
    const db = makeMockDb([[[]]]); // single SELECT returning empty

    const total = await backfillL2FromData(db);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: softInactivateNoDataRecords
// ---------------------------------------------------------------------------

describe("softInactivateNoDataRecords", () => {
  it("loops until rows_affected = 0 and returns total inactivated", async () => {
    // SELECT 3 ids → UPDATE → SELECT 1 id → UPDATE → SELECT 0 → done
    const db = makeMockDb([
      [[{ id: "memories:1" }, { id: "memories:2" }, { id: "memories:3" }]], // SELECT: 3
      [[{ id: "memories:1" }, { id: "memories:2" }, { id: "memories:3" }]], // UPDATE: 3
      [[{ id: "memories:4" }]],   // SELECT: 1
      [[{ id: "memories:4" }]],   // UPDATE: 1
      [[]],                        // SELECT: 0 — done
    ]);

    const total = await softInactivateNoDataRecords(db);

    expect(total).toBe(4);
  });

  it("stops immediately when first call returns 0 rows", async () => {
    const db = makeMockDb([[[]]]); // single call returning empty

    const total = await softInactivateNoDataRecords(db);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe("verify", () => {
  it("logs PASS when count = 0", async () => {
    const consoleSpy = vi.spyOn(console, "log");

    const db = makeMockDb([[[{ cnt: 0 }]]]);

    await expect(verify(db)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("PASS")
    );

    consoleSpy.mockRestore();
  });

  it("throws when count > 0", async () => {
    const db1 = makeMockDb([[[{ cnt: 5 }]]]);
    await expect(verify(db1)).rejects.toThrow(/FAIL/);

    const db2 = makeMockDb([[[{ cnt: 5 }]]]);
    await expect(verify(db2)).rejects.toThrow(/5/);
  });
});
