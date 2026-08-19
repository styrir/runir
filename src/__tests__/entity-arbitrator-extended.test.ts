import { describe, it, expect, vi, beforeEach } from "vitest";
import { arbitrateEntity } from "../entities/entity-arbitrator.js";

vi.mock("../entities/entity-store.js", () => ({
  findEntityByName: vi.fn(),
  findEntityByAlias: vi.fn(),
  upsertEntity: vi.fn().mockResolvedValue("new-slug"),
}));

import { findEntityByName, findEntityByAlias, upsertEntity } from "../entities/entity-store.js";

const mockDb = { query: vi.fn() } as any;
const mockFindByName = vi.mocked(findEntityByName);
const mockFindByAlias = vi.mocked(findEntityByAlias);
const mockUpsertEntity = vi.mocked(upsertEntity);

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: "entities:existing_person_user-1",
    kind: "person" as const,
    canonicalName: "Existing",
    nameNorm: "existing",
    aliases: [],
    aliasesNorm: [],
    sourceProject: "test",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    confidence: 0.7,
    scope: "user" as const,
    userId: "user-1",
    sessionId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("arbitrateEntity extended coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Line 166-175: session-scope stub match (STEP 4)
  it("updates session stub when found in same session", async () => {
    mockFindByName
      .mockResolvedValueOnce([])  // no user canonical
      .mockResolvedValueOnce([    // session stub found
        makeEntity({
          id: "entities:bob_person_user-1_session_sess-1",
          canonicalName: "Bob",
          nameNorm: "bob",
          scope: "session",
          sessionId: "sess-1",
          confidence: 0.6,
        }),
      ]);
    mockFindByAlias.mockResolvedValueOnce([]); // no alias match

    const result = await arbitrateEntity(
      mockDb,
      { name: "Bob", kind: "person", context: "mentioned", confidence: 0.9 },
      "user-1", "session", "sess-1", "test",
    );

    expect(result.outcome).toBe("update");
    expect(result.reason).toContain("session stub");
    expect(mockUpsertEntity).toHaveBeenCalledTimes(1);
    const upsertArg = mockUpsertEntity.mock.calls[0][1];
    expect(upsertArg.confidence).toBe(0.9); // Math.max(0.6, 0.9)
  });

  // Line 186: create with aliases (aliasesNorm mapped)
  it("creates session stub with aliases normalized", async () => {
    mockFindByName
      .mockResolvedValueOnce([])  // no user canonical
      .mockResolvedValueOnce([]); // no session stub
    mockFindByAlias.mockResolvedValueOnce([]); // no alias match

    const result = await arbitrateEntity(
      mockDb,
      {
        name: "Robert",
        kind: "person",
        context: "mentioned",
        confidence: 0.8,
        aliases: ["Bob", "Bobby"],
      },
      "user-1", "session", "sess-1", "test",
    );

    expect(result.outcome).toBe("create");
    const upsertArg = mockUpsertEntity.mock.calls[0][1];
    expect(upsertArg.aliases).toEqual(["Bob", "Bobby"]);
    expect(upsertArg.aliasesNorm).toEqual(["bob", "bobby"]);
  });

  // Line 141: alias match branch with mention.aliases present
  it("merge with mention aliases normalizes them into aliasesNorm", async () => {
    mockFindByName.mockResolvedValueOnce([]); // no name match
    mockFindByAlias.mockResolvedValueOnce([
      makeEntity({
        id: "entities:al_person_user-1",
        canonicalName: "Al",
        nameNorm: "al",
        kind: "person",
        aliases: ["albert"],
        aliasesNorm: ["albert"],
        confidence: 0.5,
      }),
    ]);

    const result = await arbitrateEntity(
      mockDb,
      {
        name: "Alice",
        kind: "person",
        context: "mentioned",
        confidence: 0.9,
        aliases: ["Ally", "Allie"],
      },
      "user-1", "session", "sess-1", "test",
    );

    expect(result.outcome).toBe("merge");
    const upsertArg = mockUpsertEntity.mock.calls[0][1];
    // Higher confidence → canonical name promoted to mention.name
    expect(upsertArg.canonicalName).toBe("Alice");
    expect(upsertArg.nameNorm).toBe("alice");
    // Aliases should include old canonical as alias
    expect(upsertArg.aliases).toContain("Al");
    // aliasesNorm should include normalized mention aliases
    expect(upsertArg.aliasesNorm).toContain("ally");
    expect(upsertArg.aliasesNorm).toContain("allie");
  });

  it("keeps similar unaliased people separate and merges only on an exact alias", async () => {
    mockFindByName
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindByAlias.mockResolvedValueOnce([]);

    const aliceSmith = await arbitrateEntity(
      mockDb,
      { name: "Alice Smith", kind: "person", context: "mentioned", confidence: 0.9 },
      "user-1", "session", "sess-1", "test",
    );
    expect(aliceSmith.outcome).toBe("create");
    expect(mockUpsertEntity.mock.calls[0][1]).toMatchObject({
      canonicalName: "Alice Smith",
      nameNorm: "alice smith",
    });

    vi.clearAllMocks();
    mockFindByName
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindByAlias.mockResolvedValueOnce([]);
    const alice = await arbitrateEntity(
      mockDb,
      { name: "Alice", kind: "person", context: "mentioned", confidence: 0.9 },
      "user-1", "session", "sess-1", "test",
    );

    expect(alice).toMatchObject({
      outcome: "create",
      reason: "new session stub created",
    });
    expect(mockUpsertEntity.mock.calls[0][1]).toMatchObject({
      canonicalName: "Alice",
      nameNorm: "alice",
    });

    vi.clearAllMocks();
    mockFindByName.mockResolvedValueOnce([]);
    mockFindByAlias.mockResolvedValueOnce([
      makeEntity({
        id: "entities:al_person_user-1",
        canonicalName: "Al",
        nameNorm: "al",
        aliases: ["Alice"],
        aliasesNorm: ["alice"],
        confidence: 0.7,
      }),
    ]);

    const exactAlias = await arbitrateEntity(
      mockDb,
      { name: "Alice", kind: "person", context: "mentioned", confidence: 0.9 },
      "user-1", "session", "sess-1", "test",
    );

    expect(exactAlias).toMatchObject({
      outcome: "merge",
      entityId: "al_person_user-1",
      reason: "user canonical alias match",
    });
    expect(await mockUpsertEntity.mock.results[0]?.value).toBe("new-slug");
    expect(exactAlias.entityId).not.toBe("new-slug");
  });

  // Session stub: different session → not matched, falls to create
  it("does not match session stub from different session", async () => {
    mockFindByName
      .mockResolvedValueOnce([])  // no user canonical
      .mockResolvedValueOnce([    // session stubs found but wrong session
        makeEntity({
          scope: "session",
          sessionId: "sess-other",
          canonicalName: "Charlie",
          nameNorm: "charlie",
        }),
      ]);
    mockFindByAlias.mockResolvedValueOnce([]);

    const result = await arbitrateEntity(
      mockDb,
      { name: "Charlie", kind: "person", context: "ctx", confidence: 0.8 },
      "user-1", "session", "sess-1", "test",
    );

    expect(result.outcome).toBe("create");
  });

  // No sessionId → skips STEP 4 entirely
  it("skips session stub lookup when sessionId is undefined", async () => {
    mockFindByName.mockResolvedValueOnce([]); // no user canonical
    mockFindByAlias.mockResolvedValueOnce([]); // no alias

    const result = await arbitrateEntity(
      mockDb,
      { name: "Dave", kind: "person", context: "ctx", confidence: 0.8 },
      "user-1", "user", undefined, "test",
    );

    expect(result.outcome).toBe("create");
    // findEntityByName should only be called once (for user canonical), not for session stub
    expect(mockFindByName).toHaveBeenCalledTimes(1);
  });

  // Line 140: alias merge when mention has NO aliases (triggers ?? [] fallback)
  it("merge works when mention has no aliases", async () => {
    mockFindByName.mockResolvedValueOnce([]); // no name match
    mockFindByAlias.mockResolvedValueOnce([
      makeEntity({
        id: "entities:al_person_user-1",
        canonicalName: "Al",
        nameNorm: "al",
        kind: "person",
        aliases: ["albert"],
        aliasesNorm: ["albert"],
        confidence: 0.5,
      }),
    ]);

    const result = await arbitrateEntity(
      mockDb,
      { name: "Alice", kind: "person", context: "mentioned", confidence: 0.9 },
      "user-1", "session", "sess-1", "test",
    );

    expect(result.outcome).toBe("merge");
    const upsertArg = mockUpsertEntity.mock.calls[0][1];
    expect(upsertArg.aliases).toContain("albert");
    expect(upsertArg.aliases).toContain("Alice");
  });

  // Lines 171-172: session stub update when mention has NO aliases
  it("session stub update works when mention has no aliases", async () => {
    mockFindByName
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeEntity({
          scope: "session",
          sessionId: "sess-1",
          canonicalName: "Frank",
          nameNorm: "frank",
          kind: "person",
          aliases: ["Frankie"],
          aliasesNorm: ["frankie"],
          confidence: 0.5,
        }),
      ]);
    mockFindByAlias.mockResolvedValueOnce([]);

    const result = await arbitrateEntity(
      mockDb,
      { name: "Frank", kind: "person", context: "ctx", confidence: 0.6 },
      "user-1", "session", "sess-1", "test",
    );

    expect(result.outcome).toBe("update");
    const upsertArg = mockUpsertEntity.mock.calls[0][1];
    expect(upsertArg.aliases).toContain("Frankie");
  });

  // Line 96-97: name match where mention.name differs from existing.canonicalName
  it("name match adds mention.name as alias when it differs from canonicalName", async () => {
    mockFindByName.mockResolvedValueOnce([
      makeEntity({
        id: "entities:alice_person_user-1",
        canonicalName: "Alice Smith",
        nameNorm: "alice smith",
        kind: "person",
        aliases: [],
        aliasesNorm: [],
        confidence: 0.8,
      }),
    ]);

    const result = await arbitrateEntity(
      mockDb,
      { name: "Alice", kind: "person", context: "mentioned", confidence: 0.9 },
      "user-1", "session", "sess-1", "test",
    );

    expect(result.outcome).toBe("update");
    const upsertArg = mockUpsertEntity.mock.calls[0][1];
    // "Alice" should be added as alias since it differs from "Alice Smith"
    expect(upsertArg.aliases).toContain("Alice");
    expect(upsertArg.aliasesNorm).toContain("alice");
  });

  // Line 126: alias merge where mention.confidence <= existing.confidence (no promotion)
  it("alias merge does not promote name when confidence is lower", async () => {
    mockFindByName.mockResolvedValueOnce([]); // no name match
    mockFindByAlias.mockResolvedValueOnce([
      makeEntity({
        id: "entities:al_person_user-1",
        canonicalName: "Al",
        nameNorm: "al",
        kind: "person",
        aliases: ["albert"],
        aliasesNorm: ["albert"],
        confidence: 0.95, // higher than mention
      }),
    ]);

    const result = await arbitrateEntity(
      mockDb,
      { name: "Alice", kind: "person", context: "mentioned", confidence: 0.8 },
      "user-1", "session", "sess-1", "test",
    );

    expect(result.outcome).toBe("merge");
    const upsertArg = mockUpsertEntity.mock.calls[0][1];
    // Should NOT promote — keep existing canonical
    expect(upsertArg.canonicalName).toBe("Al");
    expect(upsertArg.nameNorm).toBe("al");
  });

  // Session stub with aliases
  it("session stub update merges aliases", async () => {
    mockFindByName
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeEntity({
          scope: "session",
          sessionId: "sess-1",
          canonicalName: "Eve",
          nameNorm: "eve",
          aliases: ["Evie"],
          aliasesNorm: ["evie"],
          confidence: 0.5,
        }),
      ]);
    mockFindByAlias.mockResolvedValueOnce([]);

    await arbitrateEntity(
      mockDb,
      { name: "Eve", kind: "person", context: "ctx", confidence: 0.6, aliases: ["Evelyn"] },
      "user-1", "session", "sess-1", "test",
    );

    const upsertArg = mockUpsertEntity.mock.calls[0][1];
    expect(upsertArg.aliases).toContain("Evie");
    expect(upsertArg.aliases).toContain("Evelyn");
    expect(upsertArg.aliasesNorm).toContain("evelyn");
  });
});
