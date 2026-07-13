import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../entities/entity-arbitrator.js", () => ({
  entityIdSlug: vi.fn(
    (nameNorm: string, kind: string, userId: string, scope: string, sessionId?: string) =>
      scope === "user"
        ? `${nameNorm}_${kind}_${userId}`
        : `${nameNorm}_${kind}_${userId}_${scope}_${sessionId ?? "unknown"}`,
  ),
}));

import { upsertEntity } from "../entities/entity-store.js";

const mockDb = { query: vi.fn() } as any;

describe("upsertEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new entity and returns its record ID", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    const id = await upsertEntity(mockDb, {
      kind: "person",
      canonicalName: "Alice",
      nameNorm: "alice",
      aliases: ["Al"],
      aliasesNorm: ["al"],
      sourceProject: "test-project",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      confidence: 0.9,
      scope: "user",
      userId: "user-1",
    });

    expect(typeof id).toBe("string");
    expect(id).toBe("alice_person_user-1");
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls[0][0]).toContain("UPSERT");
  });

  it("second upsert with same key preserves firstSeenAt via SurrealQL logic", async () => {
    mockDb.query.mockResolvedValue([[]]);

    const entity = {
      kind: "person" as const,
      canonicalName: "Alice",
      nameNorm: "alice",
      aliases: ["Al"],
      aliasesNorm: ["al"],
      sourceProject: "test-project",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      confidence: 0.8,
      scope: "user" as const,
      userId: "user-1",
    };

    const id1 = await upsertEntity(mockDb, entity);
    const id2 = await upsertEntity(mockDb, { ...entity, confidence: 0.95, lastSeenAt: "2026-02-01T00:00:00.000Z" });

    expect(id1).toBe(id2);
    // The SurrealQL handles firstSeenAt preservation and confidence max-win;
    // we verify the query was sent with correct params
    const secondParams = mockDb.query.mock.calls[1][1];
    expect(secondParams.confidence).toBe(0.95);
    expect(secondParams.lastSeenAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("aliases union: different aliases each call both appear in params", async () => {
    mockDb.query.mockResolvedValue([[]]);

    const base = {
      kind: "person" as const,
      canonicalName: "Alice",
      nameNorm: "alice",
      sourceProject: "test-project",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      confidence: 0.9,
      scope: "user" as const,
      userId: "user-1",
      aliases: [] as string[],
      aliasesNorm: [] as string[],
    };

    await upsertEntity(mockDb, { ...base, aliases: ["Al"], aliasesNorm: ["al"] });
    await upsertEntity(mockDb, { ...base, aliases: ["Ally"], aliasesNorm: ["ally"] });

    // First call sends ["Al"], second sends ["Ally"]
    // SurrealQL array::union handles the union server-side
    expect(mockDb.query.mock.calls[0][1].aliases).toEqual(["Al"]);
    expect(mockDb.query.mock.calls[1][1].aliases).toEqual(["Ally"]);
    // The UPSERT query uses array::union(aliases ?? [], $aliases)
    expect(mockDb.query.mock.calls[0][0]).toContain("array::union");
  });
});
