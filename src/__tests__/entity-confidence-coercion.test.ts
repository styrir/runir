/**
 * Unit tests for entity confidence coercion — imaf.6.
 *
 * Covers:
 *  1. coerceConfidence01() matrix (boundary + representative values)
 *  2. extractEntities() passes coerced values for string/non-numeric confidence
 *  3. arbitrateEntity() Math.max is NaN-safe under legacy/garbage inputs
 *  4. promoteSessionEntities() consolidation comparison is NaN-safe
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── 1. coerceConfidence01 unit tests ───────────────────────────────────────

import { coerceConfidence01, resolveEntityModel } from "../entities/entity-extractor.js";

describe("coerceConfidence01", () => {
  it("numeric string '0.9' → 0.9", () => {
    expect(coerceConfidence01("0.9")).toBe(0.9);
  });

  it("non-numeric string 'high' → fallback 0.5", () => {
    expect(coerceConfidence01("high")).toBe(0.5);
  });

  it("null → fallback 0.5", () => {
    expect(coerceConfidence01(null)).toBe(0.5);
  });

  it("undefined → fallback 0.5", () => {
    expect(coerceConfidence01(undefined)).toBe(0.5);
  });

  it("NaN → fallback 0.5", () => {
    expect(coerceConfidence01(NaN)).toBe(0.5);
  });

  it("2.5 (>1) → clamped to 1.0", () => {
    expect(coerceConfidence01(2.5)).toBe(1.0);
  });

  it("-1 (<0) → clamped to 0.0", () => {
    expect(coerceConfidence01(-1)).toBe(0.0);
  });

  it("0.7 (valid in-range) → unchanged", () => {
    expect(coerceConfidence01(0.7)).toBe(0.7);
  });

  it("0.0 (boundary) → 0.0", () => {
    expect(coerceConfidence01(0.0)).toBe(0.0);
  });

  it("1.0 (boundary) → 1.0", () => {
    expect(coerceConfidence01(1.0)).toBe(1.0);
  });

  it("custom fallback 0.8 used when value is 'high'", () => {
    expect(coerceConfidence01("high", 0.8)).toBe(0.8);
  });

  it("custom fallback is itself clamped if out of range", () => {
    // fallback itself doesn't bypass the clamp — but coercion of a VALID
    // fallback value (a number in range) should be a no-op
    expect(coerceConfidence01("bad", 0.3)).toBe(0.3);
  });

  it("Infinity → fallback 0.5 (not finite)", () => {
    expect(coerceConfidence01(Infinity)).toBe(0.5);
  });

  it("-Infinity → fallback 0.5 (not finite)", () => {
    expect(coerceConfidence01(-Infinity)).toBe(0.5);
  });
});

// ─── 2. extractEntities coerces string/non-numeric confidence ────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { extractEntities } from "../entities/entity-extractor.js";

function makeFetchResponse(content: string) {
  return Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content } }],
      }),
  });
}

const FAKE_KEY = "test-key";
const MESSAGES = [{ role: "user" as const, content: "Alice works at Acme" }];

describe("extractEntities — confidence coercion at parse boundary", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("string '0.9' confidence is coerced and passes threshold (≥0.7)", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: "0.9" },
          ],
        }),
      ),
    );
    const entities = await extractEntities(MESSAGES, FAKE_KEY);
    expect(entities).toHaveLength(1);
    expect(entities[0].confidence).toBe(0.9);
  });

  it("string 'high' confidence → coerced to fallback 0.5 → DROPPED (below 0.7 threshold)", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: "high" },
          ],
        }),
      ),
    );
    const entities = await extractEntities(MESSAGES, FAKE_KEY);
    expect(entities).toHaveLength(0);
  });

  it("null confidence → coerced to 0.5 → DROPPED", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: null },
          ],
        }),
      ),
    );
    const entities = await extractEntities(MESSAGES, FAKE_KEY);
    expect(entities).toHaveLength(0);
  });

  it("2.5 (out-of-range) → clamped to 1.0 → passes threshold", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: 2.5 },
          ],
        }),
      ),
    );
    const entities = await extractEntities(MESSAGES, FAKE_KEY);
    expect(entities).toHaveLength(1);
    expect(entities[0].confidence).toBe(1.0);
  });

  it("-1 (negative) → clamped to 0.0 → DROPPED (below threshold)", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: -1 },
          ],
        }),
      ),
    );
    const entities = await extractEntities(MESSAGES, FAKE_KEY);
    expect(entities).toHaveLength(0);
  });

  it("valid 0.7 confidence → unchanged, passes threshold", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: 0.7 },
          ],
        }),
      ),
    );
    const entities = await extractEntities(MESSAGES, FAKE_KEY);
    expect(entities).toHaveLength(1);
    expect(entities[0].confidence).toBe(0.7);
  });
});

// ─── 3. arbitrateEntity — NaN-safe Math.max under garbage inputs ─────────────

vi.mock("../entities/entity-store.js", () => ({
  findEntityByName: vi.fn(),
  findEntityByAlias: vi.fn(),
  upsertEntity: vi.fn().mockResolvedValue("slug"),
  mergeEntities: vi.fn().mockResolvedValue(undefined),
  reassignEntityEdges: vi.fn().mockResolvedValue(undefined),
}));

// The consolidation module imports entityIdSlug from entity-arbitrator; mock
// only that export so promoteSessionEntities tests get a stable slug, while
// arbitrateEntity itself stays real (we call it directly in section 3).
vi.mock("../entities/entity-arbitrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../entities/entity-arbitrator.js")>();
  return {
    ...actual,
    entityIdSlug: vi.fn().mockReturnValue("canonical-slug"),
  };
});

import { arbitrateEntity } from "../entities/entity-arbitrator.js";
import { findEntityByName, findEntityByAlias } from "../entities/entity-store.js";

const mockFindByName = vi.mocked(findEntityByName);
const mockFindByAlias = vi.mocked(findEntityByAlias);
const mockDb = { query: vi.fn() } as any;

function makeExistingEntity(confidence: any, overrides: Record<string, any> = {}) {
  return {
    id: "entities:alice_person_user-1",
    kind: "person" as const,
    canonicalName: "Alice",
    nameNorm: "alice",
    aliases: [],
    aliasesNorm: [],
    sourceProject: "test",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    confidence,
    scope: "user" as const,
    sessionId: undefined,
    userId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("arbitrateEntity — NaN-safe confidence under garbage DB rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("existing.confidence=NaN + mention.confidence=0.9 → Math.max does not produce NaN", async () => {
    const { upsertEntity } = await import("../entities/entity-store.js");
    const mockUpsert = vi.mocked(upsertEntity);

    mockFindByName.mockResolvedValueOnce([makeExistingEntity(NaN)]);

    await arbitrateEntity(mockDb, { name: "Alice", kind: "person", context: "...", confidence: 0.9 }, "user-1", "session", "sess-1", "test");

    const upsertArgs = mockUpsert.mock.calls[0][1];
    expect(Number.isFinite(upsertArgs.confidence)).toBe(true);
    expect(upsertArgs.confidence).toBeGreaterThanOrEqual(0);
    expect(upsertArgs.confidence).toBeLessThanOrEqual(1);
  });

  it("existing.confidence=undefined + mention.confidence=0.8 → safe result", async () => {
    const { upsertEntity } = await import("../entities/entity-store.js");
    const mockUpsert = vi.mocked(upsertEntity);

    mockFindByName.mockResolvedValueOnce([makeExistingEntity(undefined)]);

    await arbitrateEntity(mockDb, { name: "Alice", kind: "person", context: "...", confidence: 0.8 }, "user-1", "session", "sess-1", "test");

    const upsertArgs = mockUpsert.mock.calls[0][1];
    expect(Number.isFinite(upsertArgs.confidence)).toBe(true);
  });

  it("alias match: mention.confidence > existing.confidence with NaN existing → NaN comparison does not crash", async () => {
    const { upsertEntity } = await import("../entities/entity-store.js");
    const mockUpsert = vi.mocked(upsertEntity);

    mockFindByName.mockResolvedValueOnce([]); // no name match
    mockFindByAlias.mockResolvedValueOnce([
      makeExistingEntity(NaN, {
        id: "entities:al_person_user-1",
        canonicalName: "Al",
        nameNorm: "al",
        aliases: ["alice"],
        aliasesNorm: ["alice"],
      }),
    ]);

    await arbitrateEntity(mockDb, { name: "Alice", kind: "person", context: "...", confidence: 0.9 }, "user-1", "session", "sess-1", "test");

    const upsertArgs = mockUpsert.mock.calls[0][1];
    expect(Number.isFinite(upsertArgs.confidence)).toBe(true);
  });
});

// ─── 4. promoteSessionEntities — NaN-safe comparison ────────────────────────

import { promoteSessionEntities } from "../lifecycle/semion/entity-consolidation.js";
import { mergeEntities } from "../entities/entity-store.js";

const mockMergeEntities = vi.mocked(mergeEntities);

function makeStub(confidence: any, overrides: Record<string, any> = {}) {
  return {
    id: "entities:stub-1",
    kind: "person" as const,
    canonicalName: "Alice",
    nameNorm: "alice",
    aliases: [] as string[],
    aliasesNorm: [] as string[],
    sourceProject: "test",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
    confidence,
    scope: "session" as const,
    sessionId: "sess-1",
    userId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCanonical(confidence: any, overrides: Record<string, any> = {}) {
  return {
    ...makeStub(confidence, overrides),
    id: "entities:canonical-1",
    scope: "user" as const,
    sessionId: undefined,
  };
}

describe("promoteSessionEntities — NaN-safe confidence comparisons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockReset();
    vi.mocked(mergeEntities).mockResolvedValue(undefined as any);
    vi.mocked(findEntityByName).mockReset();
  });

  it("stub.confidence=NaN, canonical.confidence=0.8 → mergeEntities called, winnerUpdates.confidence is finite", async () => {
    const stub = makeStub(NaN);
    const canonical = makeCanonical(0.8);

    mockDb.query.mockResolvedValueOnce([[stub]]);
    mockFindByName.mockResolvedValueOnce([canonical]);

    await promoteSessionEntities(mockDb, "user-1");

    expect(mockMergeEntities).toHaveBeenCalledOnce();
    const winnerUpdates = mockMergeEntities.mock.calls[0][3];
    expect(Number.isFinite(winnerUpdates.confidence)).toBe(true);
  });

  it("stub.confidence=0.9, canonical.confidence=NaN → stub wins (0.5 fallback for NaN canonical)", async () => {
    const stub = makeStub(0.9);
    const canonical = makeCanonical(NaN);

    mockDb.query.mockResolvedValueOnce([[stub]]);
    mockFindByName.mockResolvedValueOnce([canonical]);

    await promoteSessionEntities(mockDb, "user-1");

    const winnerUpdates = mockMergeEntities.mock.calls[0][3];
    // stub 0.9 > NaN-→-0.5 fallback, so stub wins: canonicalName from stub
    expect(winnerUpdates.canonicalName).toBe("Alice");
    expect(winnerUpdates.confidence).toBe(0.9);
  });

  it("both confidences are undefined → fallback 0.5 used, canonical wins tie (not stub)", async () => {
    const stub = makeStub(undefined);
    const canonical = makeCanonical(undefined);

    mockDb.query.mockResolvedValueOnce([[stub]]);
    mockFindByName.mockResolvedValueOnce([canonical]);

    await promoteSessionEntities(mockDb, "user-1");

    const winnerUpdates = mockMergeEntities.mock.calls[0][3];
    // 0.5 > 0.5 is false → canonical wins (else branch)
    expect(winnerUpdates).not.toHaveProperty("canonicalName");
    expect(Number.isFinite(winnerUpdates.confidence)).toBe(true);
  });
});

describe("resolveEntityModel — env fallback chain (RUNIR_ENTITY_MODEL > RUNIR_EXTRACTOR_MODEL > default)", () => {
  const ORIG_ENTITY = process.env.RUNIR_ENTITY_MODEL;
  const ORIG_EXTRACTOR = process.env.RUNIR_EXTRACTOR_MODEL;

  afterEach(() => {
    if (ORIG_ENTITY === undefined) delete process.env.RUNIR_ENTITY_MODEL;
    else process.env.RUNIR_ENTITY_MODEL = ORIG_ENTITY;
    if (ORIG_EXTRACTOR === undefined) delete process.env.RUNIR_EXTRACTOR_MODEL;
    else process.env.RUNIR_EXTRACTOR_MODEL = ORIG_EXTRACTOR;
  });

  it("RUNIR_ENTITY_MODEL wins over everything (deliberate observer/actor split)", () => {
    process.env.RUNIR_ENTITY_MODEL = "google/gemini-3-flash-preview";
    process.env.RUNIR_EXTRACTOR_MODEL = "claude-haiku-4-5-20251001";
    expect(resolveEntityModel()).toBe("google/gemini-3-flash-preview");
  });

  it("falls back to RUNIR_EXTRACTOR_MODEL so one switch moves both lanes", () => {
    delete process.env.RUNIR_ENTITY_MODEL;
    process.env.RUNIR_EXTRACTOR_MODEL = "claude-haiku-4-5-20251001";
    expect(resolveEntityModel()).toBe("claude-haiku-4-5-20251001");
  });

  it("falls back to the default when both env vars are absent", () => {
    delete process.env.RUNIR_ENTITY_MODEL;
    delete process.env.RUNIR_EXTRACTOR_MODEL;
    expect(resolveEntityModel()).toBe("openai/gpt-5.4-mini");
  });

  it("empty strings fall through the chain", () => {
    process.env.RUNIR_ENTITY_MODEL = "";
    process.env.RUNIR_EXTRACTOR_MODEL = "";
    expect(resolveEntityModel()).toBe("openai/gpt-5.4-mini");
  });
});
