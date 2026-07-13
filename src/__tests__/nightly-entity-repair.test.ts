import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindEntitiesByNames = vi.fn();
const mockFindEntitiesByAliases = vi.fn();
const mockAddEntityAliases = vi.fn();
vi.mock("../entities/entity-store", () => ({
  findEntitiesByNames: (...a: unknown[]) => mockFindEntitiesByNames(...a),
  findEntitiesByAliases: (...a: unknown[]) => mockFindEntitiesByAliases(...a),
  addEntityAliases: (...a: unknown[]) => mockAddEntityAliases(...a),
}));

const mockExtractEntities = vi.fn();
vi.mock("../entities/entity-extractor", () => ({
  extractEntities: (...a: unknown[]) => mockExtractEntities(...a),
}));

const mockArbitrateEntity = vi.fn();
vi.mock("../entities/entity-arbitrator", () => ({
  arbitrateEntity: (...a: unknown[]) => mockArbitrateEntity(...a),
}));

const mockPromoteSessionEntities = vi.fn();
vi.mock("../lifecycle/semion/entity-consolidation", () => ({
  promoteSessionEntities: (...a: unknown[]) => mockPromoteSessionEntities(...a),
}));

import {
  aggregateEntityMisses,
  runNightlyEntityRepair,
} from "../lifecycle/entity-repair/nightly-entity-repair.js";

function makeDb(routes: Array<{ match: string; rows: unknown[] | (() => unknown[]) }>) {
  const calls: Array<{ sql: string; params: any }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params: any) => {
      calls.push({ sql, params });
      for (const route of routes) {
        if (sql.includes(route.match)) {
          return [typeof route.rows === "function" ? route.rows() : route.rows];
        }
      }
      return [[]];
    }),
  } as any;
}

const miss = (normalized: string, reason = "no_entity_match") => ({ mention: normalized, normalized, reason });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindEntitiesByNames.mockResolvedValue([]);
  mockFindEntitiesByAliases.mockResolvedValue([]);
  mockAddEntityAliases.mockResolvedValue(undefined);
  mockPromoteSessionEntities.mockResolvedValue({ promoted: 0, merged: 0 });
});

describe("aggregateEntityMisses", () => {
  it("flattens, counts by normalized mention, drops <3 chars, sorts by frequency", async () => {
    const db = makeDb([
      {
        match: "FROM retrieval_trace",
        rows: [
          { entity_misses: [miss("bramblefort"), miss("ok"), miss("zephyrine")] },
          { entity_misses: [miss("bramblefort"), miss("bramblefort", "no_linked_memories")] },
        ],
      },
    ]);
    const { traceCount, misses } = await aggregateEntityMisses(db, "u1", "2026-06-10T00:00:00Z");
    expect(traceCount).toBe(2);
    expect(misses[0]).toMatchObject({ mention: "bramblefort", count: 3 });
    expect(misses.map((m) => m.mention)).not.toContain("ok");
    expect([...misses[0].reasons].sort()).toEqual(["no_entity_match", "no_linked_memories"]);
  });
});

describe("runNightlyEntityRepair classification", () => {
  const baseDb = (extraRoutes: Array<{ match: string; rows: unknown[] | (() => unknown[]) }> = []) =>
    makeDb([
      { match: "FROM retrieval_trace", rows: [{ entity_misses: [miss("bramblefort"), miss("bramblefort"), miss("bramblefort")] }] },
      ...extraRoutes,
    ]);

  it("already_resolved: resolves at user scope → verify-only, resolvedAfter true", async () => {
    mockFindEntitiesByNames.mockResolvedValue([{ id: "entities:x", nameNorm: "bramblefort" }]);
    const report = await runNightlyEntityRepair({ db: baseDb(), userId: "u1", apiKey: "k" });
    expect(report.items[0]).toMatchObject({ class: "already_resolved", resolvedAfter: true });
    expect(mockPromoteSessionEntities).not.toHaveBeenCalled();
  });

  it("session_scoped: stub exists → promotion sweep runs → re-verified after", async () => {
    // user-scope lookups fail until promotion ran; session-scope finds the stub.
    let promoted = false;
    mockFindEntitiesByNames.mockImplementation(async (_db, _names, _uid, scope) => {
      if (scope === "session") return [{ id: "entities:stub", nameNorm: "bramblefort" }];
      return promoted ? [{ id: "entities:canon", nameNorm: "bramblefort" }] : [];
    });
    mockPromoteSessionEntities.mockImplementation(async () => { promoted = true; return { promoted: 1, merged: 0 }; });
    const report = await runNightlyEntityRepair({ db: baseDb(), userId: "u1", apiKey: "k" });
    expect(report.items[0].class).toBe("session_scoped");
    expect(report.promotionRan).toBe(true);
    expect(report.items[0].resolvedAfter).toBe(true);
    expect(report.resolvedAfterCount).toBe(1);
  });

  it("alias_added: exactly one prefix-relative canonical gets the mention as alias", async () => {
    const db = baseDb([
      { match: "string::starts_with", rows: [{ id: "entities:bramblefort_full", canonicalName: "Bramblefort Migration", nameNorm: "bramblefort migration" }] },
    ]);
    const report = await runNightlyEntityRepair({ db, userId: "u1", apiKey: "k" });
    expect(report.items[0]).toMatchObject({ class: "alias_added", detail: "→ Bramblefort Migration" });
    expect(mockAddEntityAliases).toHaveBeenCalledWith(expect.anything(), "bramblefort_full", ["bramblefort"]);
  });

  it("reextracted: mention found in raw turns → extractEntities + arbitrateEntity, bounded", async () => {
    const db = baseDb([
      { match: "FROM session_turn", rows: [{ session_id: "s9", turn_index: 2, content: "we shipped bramblefort yesterday" }] },
    ]);
    mockExtractEntities.mockResolvedValue([{ name: "Bramblefort", kind: "concept", confidence: 0.9, context: "", aliases: [] }]);
    mockArbitrateEntity.mockResolvedValue({ entityId: "e1", outcome: "created" });
    const report = await runNightlyEntityRepair({ db, userId: "u1", apiKey: "k" });
    expect(report.items[0].class).toBe("reextracted");
    expect(mockArbitrateEntity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "Bramblefort" }), "u1", "session", "s9", "entity-repair");
    expect(report.promotionRan).toBe(true);
  });

  it("no_evidence: absent everywhere; high-frequency ones become junk suggestions", async () => {
    const report = await runNightlyEntityRepair({ db: baseDb(), userId: "u1", apiKey: "k" });
    expect(report.items[0].class).toBe("no_evidence");
    expect(report.junkSuggestions).toEqual(["bramblefort"]);
  });

  it("links_filtered misses are reported, never repaired", async () => {
    const db = makeDb([
      { match: "FROM retrieval_trace", rows: [{ entity_misses: [miss("surrealdb", "linked_memories_filtered")] }] },
    ]);
    const report = await runNightlyEntityRepair({ db, userId: "u1", apiKey: "k" });
    expect(report.items[0].class).toBe("links_filtered");
    expect(mockAddEntityAliases).not.toHaveBeenCalled();
    expect(mockExtractEntities).not.toHaveBeenCalled();
  });

  it("persists an entity_repair_run report row", async () => {
    const db = baseDb();
    await runNightlyEntityRepair({ db, userId: "u1", apiKey: "k" });
    const reportCall = db.calls.find((call: any) => call.sql.includes("entity_repair_run"));
    expect(reportCall).toBeTruthy();
    expect(reportCall.params).toMatchObject({ userId: "u1", processed: 1 });
  });

  it("respects maxReextractions budget", async () => {
    const db = makeDb([
      { match: "FROM retrieval_trace", rows: [{ entity_misses: [miss("alpha-thing"), miss("beta-thing")] }] },
      { match: "FROM session_turn", rows: [{ session_id: "s1", turn_index: 0, content: "alpha-thing and beta-thing both appear" }] },
    ]);
    mockExtractEntities.mockResolvedValue([]);
    const report = await runNightlyEntityRepair({ db, userId: "u1", apiKey: "k", limits: { maxReextractions: 1 } });
    const classes = report.items.map((i) => i.class);
    expect(classes.filter((c) => c === "reextracted")).toHaveLength(1);
    expect(classes.filter((c) => c === "no_evidence")).toHaveLength(1);
  });
});
