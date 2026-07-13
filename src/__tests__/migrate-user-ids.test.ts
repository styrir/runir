import { describe, expect, it, vi } from "vitest";
import {
  applyUserIdMigrationPlan,
  buildUserIdMigrationPlan,
  collectUserIdInventory,
  type MigrationDb,
} from "../../scripts/migrate-user-ids.js";

function makeDb(responses: any[][]): MigrationDb {
  let index = 0;
  return {
    query: vi.fn().mockImplementation(async () => [responses[index++] ?? []]),
  };
}

describe("collectUserIdInventory", () => {
  it("collects grouped counts across tracked user-bearing tables", async () => {
    const db = makeDb([
      [{ userId: "owner", count: 10 }, { userId: "agent-hermes", count: 4 }],
      [{ userId: "owner", count: 2 }],
      [{ userId: "owner", count: 1 }],
      [],
      [],
      [],
      [],
      [{ userId: "owner", count: 3 }],
    ]);

    const inventory = await collectUserIdInventory(db);

    expect(inventory.tables).toHaveLength(8);
    expect(inventory.tables[0]?.table).toBe("memories");
    expect(inventory.tables[0]?.counts).toEqual([
      { userId: "owner", count: 10 },
      { userId: "agent-hermes", count: 4 },
    ]);
    expect(inventory.tables[7]?.table).toBe("entities");
    expect(inventory.tables[7]?.counts).toEqual([{ userId: "owner", count: 3 }]);
  });
});

describe("buildUserIdMigrationPlan", () => {
  it("builds migrate and purge operations with expected row counts and warnings", () => {
    const inventory = {
      capturedAt: "2026-04-02T00:00:00.000Z",
      tables: [
        { table: "memories", counts: [{ userId: "agent-hermes", count: 4 }, { userId: "brooks", count: 6 }] },
        { table: "project_state", counts: [{ userId: "agent-hermes", count: 1 }] },
        { table: "session_watermarks", counts: [] },
        { table: "rejection_log", counts: [{ userId: "default-user", count: 2 }] },
        { table: "consolidation_state", counts: [] },
        { table: "consolidation_log", counts: [] },
        { table: "staleness_backlog", counts: [] },
        { table: "entities", counts: [{ userId: "agent-hermes", count: 2 }] },
      ],
    };

    const plan = buildUserIdMigrationPlan(inventory, {
      mappings: [{ from: "agent-hermes", to: "brooks" }],
      purge: ["default-user"],
    });

    expect(plan.operations).toHaveLength(2);
    expect(plan.operations[0]).toEqual(expect.objectContaining({
      kind: "migrate",
      from: "agent-hermes",
      to: "brooks",
      expectedTotal: 7,
    }));
    expect(plan.operations[1]).toEqual(expect.objectContaining({
      kind: "purge",
      from: "default-user",
      expectedTotal: 2,
    }));
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Target userId brooks already exists"),
    ]));
  });
});

describe("applyUserIdMigrationPlan", () => {
  it("does not execute writes in dry-run mode", async () => {
    const db = { query: vi.fn() } as unknown as MigrationDb;
    const result = await applyUserIdMigrationPlan(db, {
      inventory: { capturedAt: "", tables: [] },
      warnings: [],
      operations: [{
        kind: "migrate",
        from: "agent-hermes",
        to: "brooks",
        expectedTotal: 1,
        tableOperations: [{
          table: "memories",
          mode: "migrate",
          from: "agent-hermes",
          to: "brooks",
          expectedCount: 1,
          sql: "UPDATE memories ...",
          vars: { fromUserId: "agent-hermes", toUserId: "brooks" },
        }],
      }],
    }, { apply: false });

    expect(result).toEqual({ executedStatements: 0, dryRun: true });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("executes planned writes in apply mode", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) } as unknown as MigrationDb;
    const result = await applyUserIdMigrationPlan(db, {
      inventory: { capturedAt: "", tables: [] },
      warnings: [],
      operations: [{
        kind: "migrate",
        from: "agent-hermes",
        to: "brooks",
        expectedTotal: 3,
        tableOperations: [
          {
            table: "memories",
            mode: "migrate",
            from: "agent-hermes",
            to: "brooks",
            expectedCount: 2,
            sql: "UPDATE memories SET payload.userId = $toUserId, user_id = $toUserId WHERE payload.userId = $fromUserId;",
            vars: { fromUserId: "agent-hermes", toUserId: "brooks" },
          },
          {
            table: "project_state",
            mode: "migrate",
            from: "agent-hermes",
            to: "brooks",
            expectedCount: 1,
            sql: "UPDATE project_state SET user_id = $toUserId WHERE user_id = $fromUserId;",
            vars: { fromUserId: "agent-hermes", toUserId: "brooks" },
          },
        ],
      }],
    }, { apply: true });

    expect(result).toEqual({ executedStatements: 2, dryRun: false });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenNthCalledWith(1,
      "UPDATE memories SET payload.userId = $toUserId, user_id = $toUserId WHERE payload.userId = $fromUserId;",
      { fromUserId: "agent-hermes", toUserId: "brooks" },
    );
  });
});
