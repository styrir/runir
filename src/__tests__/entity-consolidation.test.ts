import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EntityKind, MemoryScope } from "../domain/memory/types.js";

vi.mock("../entities/entity-store.js", () => ({
  findEntityByName: vi.fn(),
  mergeEntities: vi.fn().mockResolvedValue(undefined),
  composeUpsertEntity: vi.fn().mockReturnValue({
    statement: "UPSERT type::record('entities', $pu_recordId) SET …;",
    vars: {},
    recordId: "canonical-slug",
  }),
  composeEdgeReassignment: vi.fn().mockResolvedValue({ body: "DELETE $pe0_o0;", vars: {} }),
}));

vi.mock("../entities/entity-arbitrator.js", () => ({
  entityIdSlug: vi.fn().mockReturnValue("canonical-slug"),
}));

import { promoteSessionEntities } from "../lifecycle/semion/entity-consolidation.js";
import { findEntityByName, mergeEntities, composeUpsertEntity, composeEdgeReassignment } from "../entities/entity-store.js";

const mockFindByName = vi.mocked(findEntityByName);
const mockMergeEntities = vi.mocked(mergeEntities);
const mockComposeUpsertEntity = vi.mocked(composeUpsertEntity);
const mockComposeEdgeReassignment = vi.mocked(composeEdgeReassignment);

const mockDb = { query: vi.fn(), queryTransaction: vi.fn().mockResolvedValue(undefined) } as any;

function makeStub(overrides: Record<string, any> = {}) {
  return {
    id: "entities:stub-1",
    kind: "person" as EntityKind,
    canonicalName: "Alice",
    nameNorm: "alice",
    aliases: [],
    aliasesNorm: [],
    sourceProject: "test",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
    confidence: 0.8,
    scope: "session" as MemoryScope,
    sessionId: "sess-1",
    userId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("promoteSessionEntities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain the mockResolvedValueOnce queue — reset the db
    // mock fully so unconsumed per-test responses can't leak into the next test.
    mockDb.query.mockReset();
    mockDb.queryTransaction.mockResolvedValue(undefined);
    mockComposeUpsertEntity.mockReturnValue({
      statement: "UPSERT type::record('entities', $pu_recordId) SET …;",
      vars: {},
      recordId: "canonical-slug",
    });
    mockComposeEdgeReassignment.mockResolvedValue({ body: "DELETE $pe0_o0;", vars: {} });
  });

  it("promotes stub with no canonical — rekeys to canonical user-scope ID", async () => {
    const stub = makeStub();
    mockDb.query.mockResolvedValueOnce([[stub]]); // SELECT session stubs only — DELETE is now inside queryTransaction

    mockFindByName.mockResolvedValueOnce([]); // no canonical found

    const result = await promoteSessionEntities(mockDb, "user-1");
    expect(result.promoted).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.failed).toBe(0);
    // composeUpsertEntity called with user-scope entity (no sessionId)
    expect(mockComposeUpsertEntity).toHaveBeenCalledOnce();
    expect(mockComposeUpsertEntity.mock.calls[0][0]).toMatchObject({ scope: "user", sessionId: undefined });
    // composeEdgeReassignment called with correct ids and "pe" prefix
    expect(mockComposeEdgeReassignment).toHaveBeenCalledWith(mockDb, "stub-1", "canonical-slug", "pe");
    // All three writes assembled into ONE queryTransaction call
    expect(mockDb.queryTransaction).toHaveBeenCalledTimes(1);
    const [body, vars] = mockDb.queryTransaction.mock.calls[0];
    expect(body).toContain("DELETE");
    expect(vars).toMatchObject({ pdelStubId: "stub-1" });
  });

  it("promotes stubs whose id is returned as an object record wrapper", async () => {
    const stub = makeStub({ id: { id: "entities:stub-obj" } });
    mockDb.query.mockResolvedValueOnce([[stub]]); // SELECT session stubs only

    mockFindByName.mockResolvedValueOnce([]);

    const result = await promoteSessionEntities(mockDb, "user-1");
    expect(result.promoted).toBe(1);
    expect(result.failed).toBe(0);
    // stubId extracted correctly from the object wrapper
    expect(mockComposeEdgeReassignment).toHaveBeenCalledWith(mockDb, "stub-obj", "canonical-slug", "pe");
    // DELETE stub id threaded into queryTransaction vars
    expect(mockDb.queryTransaction).toHaveBeenCalledTimes(1);
    const [body, vars] = mockDb.queryTransaction.mock.calls[0];
    expect(body).toContain("DELETE");
    expect(vars).toMatchObject({ pdelStubId: "stub-obj" });
  });

  it("merges stub with existing canonical — mergeEntities called", async () => {
    const stub = makeStub();
    const canonical = {
      ...makeStub({
        id: "entities:canonical-1",
        scope: "user" as MemoryScope,
        sessionId: undefined,
        confidence: 0.85,
      }),
    };

    mockDb.query.mockResolvedValueOnce([[stub]]); // SELECT session stubs
    mockFindByName.mockResolvedValueOnce([canonical]);

    const result = await promoteSessionEntities(mockDb, "user-1");
    expect(result.merged).toBe(1);
    expect(result.promoted).toBe(0);
    expect(mockMergeEntities).toHaveBeenCalledOnce();
    expect(mockMergeEntities.mock.calls[0][1]).toBe("entities:canonical-1"); // winnerId
    expect(mockMergeEntities.mock.calls[0][2]).toBe("entities:stub-1");      // loserId
  });

  it("stub with higher confidence → stub's canonicalName used in winnerUpdates", async () => {
    const stub = makeStub({ confidence: 0.95, canonicalName: "Alice Smith" });
    const canonical = makeStub({
      id: "entities:canonical-1",
      scope: "user" as MemoryScope,
      sessionId: undefined,
      confidence: 0.7,
      canonicalName: "Alice",
    });

    mockDb.query.mockResolvedValueOnce([[stub]]);
    mockFindByName.mockResolvedValueOnce([canonical]);

    await promoteSessionEntities(mockDb, "user-1");

    const winnerUpdates = mockMergeEntities.mock.calls[0][3];
    expect(winnerUpdates.canonicalName).toBe("Alice Smith");
    expect(winnerUpdates.confidence).toBe(0.95);
  });

  it("handles query returning null — uses empty array fallback", async () => {
    mockDb.query.mockResolvedValueOnce([null]); // query result[0] is null
    const result = await promoteSessionEntities(mockDb, "user-1");
    expect(result.promoted).toBe(0);
    expect(result.merged).toBe(0);
  });

  it("merge: canonical has earlier firstSeenAt and later lastSeenAt — canonical dates win", async () => {
    const stub = makeStub({
      confidence: 0.7,
      firstSeenAt: "2026-01-05T00:00:00.000Z",
      lastSeenAt: "2026-01-06T00:00:00.000Z",
    });
    const canonical = makeStub({
      id: "entities:canonical-1",
      scope: "user" as MemoryScope,
      sessionId: undefined,
      confidence: 0.9,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-10T00:00:00.000Z",
    });

    mockDb.query.mockResolvedValueOnce([[stub]]);
    mockFindByName.mockResolvedValueOnce([canonical]);

    await promoteSessionEntities(mockDb, "user-1");

    const winnerUpdates = mockMergeEntities.mock.calls[0][3];
    // canonical dates should win since canonical.firstSeenAt < stub.firstSeenAt
    // and canonical.lastSeenAt > stub.lastSeenAt
    expect(winnerUpdates.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(winnerUpdates.lastSeenAt).toBe("2026-01-10T00:00:00.000Z");
  });

  it("merge with stub winning: canonical dates win when canonical is earlier/later", async () => {
    const stub = makeStub({
      confidence: 0.95,
      firstSeenAt: "2026-01-05T00:00:00.000Z",
      lastSeenAt: "2026-01-06T00:00:00.000Z",
    });
    const canonical = makeStub({
      id: "entities:canonical-1",
      scope: "user" as MemoryScope,
      sessionId: undefined,
      confidence: 0.7,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-10T00:00:00.000Z",
    });

    mockDb.query.mockResolvedValueOnce([[stub]]);
    mockFindByName.mockResolvedValueOnce([canonical]);

    await promoteSessionEntities(mockDb, "user-1");

    const winnerUpdates = mockMergeEntities.mock.calls[0][3];
    expect(winnerUpdates.canonicalName).toBe("Alice"); // stub name
    expect(winnerUpdates.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(winnerUpdates.lastSeenAt).toBe("2026-01-10T00:00:00.000Z");
  });

  it("merge handles undefined aliases — ?? [] fallback paths", async () => {
    const stub = makeStub({
      confidence: 0.7,
      aliases: undefined,
      aliasesNorm: undefined,
    });
    const canonical = makeStub({
      id: "entities:canonical-1",
      scope: "user" as MemoryScope,
      sessionId: undefined,
      confidence: 0.9,
      aliases: undefined,
      aliasesNorm: undefined,
    });

    mockDb.query.mockResolvedValueOnce([[stub]]);
    mockFindByName.mockResolvedValueOnce([canonical]);

    await promoteSessionEntities(mockDb, "user-1");

    const winnerUpdates = mockMergeEntities.mock.calls[0][3];
    // Should still produce valid arrays from the ?? [] fallbacks
    expect(Array.isArray(winnerUpdates.aliases)).toBe(true);
    expect(Array.isArray(winnerUpdates.aliasesNorm)).toBe(true);
  });

  it("merge with stub winning + undefined aliases on both sides", async () => {
    const stub = makeStub({
      confidence: 0.95,
      aliases: undefined,
      aliasesNorm: undefined,
    });
    const canonical = makeStub({
      id: "entities:canonical-1",
      scope: "user" as MemoryScope,
      sessionId: undefined,
      confidence: 0.7,
      aliases: undefined,
      aliasesNorm: undefined,
    });

    mockDb.query.mockResolvedValueOnce([[stub]]);
    mockFindByName.mockResolvedValueOnce([canonical]);

    await promoteSessionEntities(mockDb, "user-1");

    const winnerUpdates = mockMergeEntities.mock.calls[0][3];
    expect(Array.isArray(winnerUpdates.aliases)).toBe(true);
    expect(winnerUpdates.aliases).toContain("Alice"); // canonical.canonicalName displaced
  });

  it("calls logger when provided", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);
    const logger = vi.fn();
    await promoteSessionEntities(mockDb, "user-1", logger);
    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("promoted=0");
    expect(logger.mock.calls[0][0]).toContain("merged=0");
  });

  it("returns correct promoted/merged counts", async () => {
    const stub1 = makeStub({ id: "entities:stub-1" });
    const stub2 = makeStub({ id: "entities:stub-2", canonicalName: "Bob", nameNorm: "bob" });

    // Only the initial SELECT remains in db.query — the promote-branch DELETE
    // and edge moves are now inside queryTransaction.
    mockDb.query.mockResolvedValueOnce([[stub1, stub2]]); // SELECT session stubs

    mockFindByName
      .mockResolvedValueOnce([makeStub({ id: "entities:canonical-1", scope: "user" as MemoryScope, confidence: 0.85 })]) // stub1 has canonical → merge
      .mockResolvedValueOnce([]); // stub2 no canonical → promote

    const result = await promoteSessionEntities(mockDb, "user-1");
    expect(result.promoted).toBe(1);
    expect(result.merged).toBe(1);
    expect(result.failed).toBe(0);
    // Merge branch still uses mergeEntities (unchanged)
    expect(mockMergeEntities).toHaveBeenCalledTimes(1);
    // Promote branch issued one queryTransaction
    expect(mockDb.queryTransaction).toHaveBeenCalledTimes(1);
  });
});
