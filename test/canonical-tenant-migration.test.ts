import { describe, expect, it, vi } from "vitest";
import {
  applyTenantUpdateStatements,
  buildTenantUpdateStatements,
  mergeEntityForCanonicalTenant,
  mergeProjectStateForCanonicalTenant,
  type TenantMigrationDb,
} from "../src/maintenance/canonical-tenant-migration.js";
import {
  buildSemioteDedupeGroups,
} from "../src/maintenance/semiote-tenant-dedupe.js";

describe("canonical tenant migration", () => {
  it("keeps the newest fact-key row active across tenant collisions", () => {
    const groups = buildSemioteDedupeGroups(
      [
        {
          id: "semiote:brooks-old",
          user_id: "brooks",
          factKey: "shared",
          updatedAt: "2026-07-31T17:21:00.000Z",
        },
        {
          id: "semiote:brooks-older",
          user_id: "brooks",
          factKey: "shared",
          updatedAt: "2026-07-31T17:20:00.000Z",
        },
        {
          id: "semiote:owner-new",
          user_id: "owner",
          factKey: "shared",
          updatedAt: "2026-07-31T20:36:00.000Z",
        },
      ],
      "owner",
      "brooks",
    );

    expect(groups).toEqual([
      {
        factKey: "shared",
        winnerId: "owner-new",
        loserIds: ["brooks-old", "brooks-older"],
      },
    ]);
  });

  it("updates only authoritative tenant tables", () => {
    const statements = buildTenantUpdateStatements({
      from: "owner",
      to: "brooks",
      nonCollidingEntityIds: ["entity-a"],
      nonCollidingProjectStateIds: ["state-a"],
    });

    expect(statements.map(({ label }) => label)).toEqual([
      "semiote",
      "noema",
      "entities",
      "project_state",
    ]);
    expect(statements[0]?.sql).toContain("payload.userId = $toUserId");
    expect(statements.map(({ sql }) => sql).join(" ")).not.toMatch(
      /retrieval_trace|rejection_log|supersede_shadow|runir_session/,
    );
  });

  it("merges entity aliases and lifecycle without replacing the canonical key", () => {
    const merged = mergeEntityForCanonicalTenant(
      {
        canonicalName: "Rúnir",
        nameNorm: "runir",
        aliases: ["Runir memory"],
        aliasesNorm: ["runir memory"],
        confidence: 0.95,
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-09T00:00:00.000Z",
        description: "Newer legacy description",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      {
        canonicalName: "Rúnir",
        nameNorm: "runir",
        aliases: ["Runir"],
        aliasesNorm: ["runir"],
        confidence: 1,
        firstSeenAt: "2026-07-01T00:00:00.000Z",
        lastSeenAt: "2026-08-05T00:00:00.000Z",
        description: "Canonical description",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
    );

    expect(merged).toEqual({
      canonicalName: "Rúnir",
      nameNorm: "runir",
      aliases: ["Runir", "Runir memory"],
      aliasesNorm: ["runir", "runir memory"],
      confidence: 1,
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-08-09T00:00:00.000Z",
      description: "Canonical description",
    });
  });

  it("keeps the canonical project-state id while selecting newer content", () => {
    const merged = mergeProjectStateForCanonicalTenant(
      {
        id: "project_state:owner",
        user_id: "owner",
        updated_at: {
          toString: () => "2026-08-10T00:00:00.000Z",
        },
        version: 2,
        summary: "newer",
        supporting_memory_ids: ["memory-a"],
      },
      {
        id: "project_state:brooks",
        user_id: "brooks",
        updated_at: "2026-08-01T00:00:00.000Z",
        version: 1,
        summary: "older",
        supporting_memory_ids: ["memory-b"],
      },
      "brooks",
    );

    expect(merged.targetId).toBe("project_state:brooks");
    expect(merged.content).toMatchObject({
      user_id: "brooks",
      version: 2,
      summary: "newer",
      supporting_memory_ids: ["memory-a", "memory-b"],
    });
    expect(merged.content).not.toHaveProperty("id");
  });

  it("is dry-run by default and applies one transaction explicitly", async () => {
    const db: TenantMigrationDb = {
      queryTransaction: vi.fn().mockResolvedValue([]),
    };
    const statements = buildTenantUpdateStatements({
      from: "owner",
      to: "brooks",
      nonCollidingEntityIds: [],
      nonCollidingProjectStateIds: [],
    });

    await expect(applyTenantUpdateStatements(db, statements)).resolves.toEqual({
      dryRun: true,
      executedStatements: 0,
    });
    expect(db.queryTransaction).not.toHaveBeenCalled();

    await expect(
      applyTenantUpdateStatements(db, statements, { apply: true }),
    ).resolves.toEqual({
      dryRun: false,
      executedStatements: 4,
    });
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
  });
});
