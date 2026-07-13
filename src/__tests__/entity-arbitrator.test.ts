import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeEntityName, entityIdSlug, arbitrateEntity } from "../entities/entity-arbitrator.js";

vi.mock("../entities/entity-store.js", () => ({
  findEntityByName: vi.fn(),
  findEntityByAlias: vi.fn(),
  upsertEntity: vi.fn().mockResolvedValue("new-slug"),
}));

import { findEntityByName, findEntityByAlias, upsertEntity } from "../entities/entity-store.js";

const mockDb = { query: vi.fn() } as any;
const mockFindByName = vi.mocked(findEntityByName);
const mockFindByAlias = vi.mocked(findEntityByAlias);

describe("normalizeEntityName", () => {
  it("strips diacritics: Ólafur → olafur", () => {
    expect(normalizeEntityName("Ólafur")).toBe("olafur");
  });

  it("preserves Cyrillic, lowercased: Москва → москва", () => {
    expect(normalizeEntityName("Москва")).toBe("москва");
  });

  it("preserves CJK: 東京 → 東京", () => {
    expect(normalizeEntityName("東京")).toBe("東京");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(normalizeEntityName("hello!!! world  ")).toBe("hello world");
  });
});

describe("entityIdSlug", () => {
  it('scope="user" produces keyed string without session info', () => {
    const slug = entityIdSlug("alice", "person", "user-1", "user");
    expect(slug).toContain("alice");
    expect(slug).toContain("person");
    expect(slug).toContain("user");
    expect(slug).not.toContain("session");
  });

  it('scope="session" produces keyed string with sessionId', () => {
    const slug = entityIdSlug("alice", "person", "user-1", "session", "sess-42");
    expect(slug).toContain("sess");
    expect(slug).toContain("42");
  });

  it("non-ASCII chars are hex-encoded (no raw Unicode in output)", () => {
    const slug = entityIdSlug("москва", "location", "user-1", "user");
    // Should not contain any Cyrillic characters directly
    expect(slug).not.toMatch(/[а-яА-Я]/);
    // Should contain hex encoding pattern
    expect(slug).toMatch(/_x[0-9a-f]+_/);
  });
});

describe("arbitrateEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mention = {
    name: "Alice",
    kind: "person" as const,
    context: "Alice mentioned",
    confidence: 0.9,
  };

  it("name match → returns update outcome", async () => {
    mockFindByName.mockResolvedValueOnce([
      {
        id: "entities:alice_person_user-1",
        kind: "person",
        canonicalName: "Alice",
        nameNorm: "alice",
        aliases: [],
        aliasesNorm: [],
        sourceProject: "test",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        confidence: 0.8,
        scope: "user",
        userId: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await arbitrateEntity(mockDb, mention, "user-1", "session", "sess-1", "test");
    expect(result.outcome).toBe("update");
    expect(result.entityId).toBe("alice_person_user-1");
  });

  it("name match with a SurrealDB RecordId-OBJECT id does not throw (Rúnir-imaf.1 regression)", async () => {
    // SurrealDB SELECT returns `id` as a RecordId OBJECT, not the bare string the
    // EntityRecord.id type claims. The old normalizeEntityId did id.startsWith(...)
    // and threw "id.startsWith is not a function" on EVERY recurring entity (601x live).
    mockFindByName.mockResolvedValueOnce([
      {
        id: { tb: "entities", id: "alice_person_user-1" } as unknown as string,
        kind: "person",
        canonicalName: "Alice",
        nameNorm: "alice",
        aliases: [],
        aliasesNorm: [],
        sourceProject: "test",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        confidence: 0.8,
        scope: "user",
        userId: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await arbitrateEntity(mockDb, mention, "user-1", "session", "sess-1", "test");
    expect(result.outcome).toBe("update");
    expect(result.entityId).toBe("alice_person_user-1");
  });

  it("alias match with a RecordId-OBJECT id does not throw (Rúnir-imaf.1 — STEP 3 path)", async () => {
    mockFindByName.mockResolvedValueOnce([]); // no user-canonical name match
    mockFindByAlias.mockResolvedValueOnce([
      {
        id: { tb: "entities", id: "al_person_user-1" } as unknown as string,
        kind: "person",
        canonicalName: "Al",
        nameNorm: "al",
        aliases: ["alice"],
        aliasesNorm: ["alice"],
        sourceProject: "test",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        confidence: 0.7,
        scope: "user",
        userId: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await arbitrateEntity(mockDb, mention, "user-1", "session", "sess-1", "test");
    expect(result.outcome).toBe("merge");
    expect(result.entityId).toBe("al_person_user-1");
  });

  it("session-stub match with a RecordId-OBJECT id does not throw (Rúnir-imaf.1 — STEP 4 path)", async () => {
    mockFindByName.mockResolvedValueOnce([]); // STEP 2 user-scope: no match
    mockFindByAlias.mockResolvedValueOnce([]); // STEP 3 alias: no match
    mockFindByName.mockResolvedValueOnce([
      // STEP 4 session-scope stub
      {
        id: { tb: "entities", id: "alice_person_user-1_session_sess-1" } as unknown as string,
        kind: "person",
        canonicalName: "Alice",
        nameNorm: "alice",
        aliases: [],
        aliasesNorm: [],
        sourceProject: "test",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        confidence: 0.8,
        scope: "session",
        sessionId: "sess-1",
        userId: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await arbitrateEntity(mockDb, mention, "user-1", "session", "sess-1", "test");
    expect(result.outcome).toBe("update");
    expect(result.entityId).toBe("alice_person_user-1_session_sess-1");
  });

  it("alias match → returns merge outcome", async () => {
    mockFindByName.mockResolvedValueOnce([]); // no name match
    mockFindByAlias.mockResolvedValueOnce([
      {
        id: "entities:al_person_user-1",
        kind: "person",
        canonicalName: "Al",
        nameNorm: "al",
        aliases: ["alice"],
        aliasesNorm: ["alice"],
        sourceProject: "test",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        confidence: 0.7,
        scope: "user",
        userId: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await arbitrateEntity(mockDb, mention, "user-1", "session", "sess-1", "test");
    expect(result.outcome).toBe("merge");
    expect(result.entityId).toBe("al_person_user-1");
  });

  it("no match → returns create outcome", async () => {
    mockFindByName
      .mockResolvedValueOnce([])  // no user canonical name match
      .mockResolvedValueOnce([]); // no session stub match
    mockFindByAlias.mockResolvedValueOnce([]); // no alias match

    const result = await arbitrateEntity(mockDb, mention, "user-1", "session", "sess-1", "test");
    expect(result.outcome).toBe("create");
    expect(typeof result.entityId).toBe("string");
  });
});
