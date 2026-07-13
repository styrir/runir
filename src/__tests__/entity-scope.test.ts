import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../entities/entity-arbitrator.js", () => ({
  entityIdSlug: vi.fn(() => "mock-slug"),
}));

import { findEntityByName, findEntityByAlias, findEntitiesByNames, findEntitiesByAliases } from "../entities/entity-store.js";

const mockDb = { query: vi.fn() } as any;

describe("findEntityByName scope behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no scope arg → query includes scope = 'user'", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    await findEntityByName(mockDb, "alice");

    const sql = mockDb.query.mock.calls[0][0];
    const params = mockDb.query.mock.calls[0][1];
    expect(sql).toContain("scope = $scope");
    expect(params.scope).toBe("user");
  });

  it('scope: "session" → query includes scope = "session"', async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    await findEntityByName(mockDb, "alice", undefined, undefined, "session");

    const params = mockDb.query.mock.calls[0][1];
    expect(params.scope).toBe("session");
  });

  it("session stubs NOT returned by default query", async () => {
    const sessionEntity = { id: "e1", scope: "session", nameNorm: "alice" };
    const userEntity = { id: "e2", scope: "user", nameNorm: "alice" };

    // Default call (no scope) → scope = "user"
    mockDb.query.mockResolvedValueOnce([[userEntity]]);
    const defaultResults = await findEntityByName(mockDb, "alice");
    expect(defaultResults).toEqual([userEntity]);

    // Explicit session scope → different result set
    mockDb.query.mockResolvedValueOnce([[sessionEntity]]);
    const sessionResults = await findEntityByName(mockDb, "alice", undefined, undefined, "session");
    expect(sessionResults).toEqual([sessionEntity]);
  });
});

describe("batched lookups (findEntitiesByNames / findEntitiesByAliases)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("findEntitiesByNames: one IN query, scope defaults to 'user', userId clause when given", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    await findEntitiesByNames(mockDb, ["alice", "acme"], "brooks");

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const sql = mockDb.query.mock.calls[0][0];
    const params = mockDb.query.mock.calls[0][1];
    expect(sql).toContain("nameNorm IN $nameNorms");
    expect(sql).toContain("userId = $userId");
    expect(params).toMatchObject({ nameNorms: ["alice", "acme"], scope: "user", userId: "brooks" });
  });

  it("findEntitiesByAliases: one CONTAINSANY query over all candidates", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    await findEntitiesByAliases(mockDb, ["js", "ts"], "brooks", "session");

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const sql = mockDb.query.mock.calls[0][0];
    expect(sql).toContain("aliasesNorm CONTAINSANY $aliasNorms");
    expect(mockDb.query.mock.calls[0][1]).toMatchObject({ aliasNorms: ["js", "ts"], scope: "session" });
  });

  it("empty candidate list short-circuits without a DB call", async () => {
    expect(await findEntitiesByNames(mockDb, [])).toEqual([]);
    expect(await findEntitiesByAliases(mockDb, [])).toEqual([]);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("findEntityByAlias scope behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no scope arg → defaults to user", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    await findEntityByAlias(mockDb, "al");

    const params = mockDb.query.mock.calls[0][1];
    expect(params.scope).toBe("user");
  });

  it('explicit scope: "session" → passes session scope', async () => {
    mockDb.query.mockResolvedValueOnce([[]]);

    await findEntityByAlias(mockDb, "al", undefined, "session");

    const params = mockDb.query.mock.calls[0][1];
    expect(params.scope).toBe("session");
  });
});
