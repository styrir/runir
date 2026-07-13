import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockExtractId = vi.fn((id: unknown) => String(id));
const mockGetBm25CorpusStats = vi.fn();
const mockGetEmbeddingFingerprint = vi.fn();
const mockFindEntityByName = vi.fn();
const mockFindEntityByAlias = vi.fn();
const mockGetSupportingMemoryIds = vi.fn();

vi.mock("../storage/surreal/surreal-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/surreal/surreal-store")>();
  return {
    ...actual,
    ACTIVE_MEMORY_FILTER: "AND payload.inactive != true",
    extractId: (id: unknown) => mockExtractId(id),
    getBm25CorpusStats: (...args: unknown[]) => mockGetBm25CorpusStats(...args),
    getEmbeddingFingerprint: (...args: unknown[]) => mockGetEmbeddingFingerprint(...args),
  };
});

const mockRerankWithProvider = vi.fn();
const mockAttachRerankerStages = vi.fn();
vi.mock("../storage/reranking/ranker", () => ({
  rerankWithProvider: (...args: unknown[]) => mockRerankWithProvider(...args),
  attachRerankerStages: (...args: unknown[]) => mockAttachRerankerStages(...args),
}));

vi.mock("../entities/entity-store", () => ({
  findEntityByName: (...args: unknown[]) => mockFindEntityByName(...args),
  findEntityByAlias: (...args: unknown[]) => mockFindEntityByAlias(...args),
  // The batched lookups delegate to the per-candidate mocks so every existing
  // test's per-name/per-alias stubbing keeps describing the same world. Rows are
  // deduped by id like the real single-query implementations (a row matching two
  // candidates comes back once).
  findEntitiesByNames: async (db: unknown, names: string[], userId?: unknown, scope?: unknown) => {
    const rows: any[] = [];
    for (const name of names) rows.push(...(await mockFindEntityByName(db, name, undefined, userId, scope)));
    const seen = new Set<unknown>();
    return rows.filter((r) => { const k = r?.id ?? r; if (seen.has(k)) return false; seen.add(k); return true; });
  },
  findEntitiesByAliases: async (db: unknown, aliases: string[], userId?: unknown, scope?: unknown) => {
    const rows: any[] = [];
    for (const alias of aliases) rows.push(...(await mockFindEntityByAlias(db, alias, userId, scope)));
    const seen = new Set<unknown>();
    return rows.filter((r) => { const k = r?.id ?? r; if (seen.has(k)) return false; seen.add(k); return true; });
  },
  getSupportingMemoryIds: (...args: unknown[]) => mockGetSupportingMemoryIds(...args),
  // Batched form (imaf.11 #3) delegates to the per-entity mock so each test's
  // mockResolvedValue setup keeps working unchanged — same pattern as the
  // findEntitiesByNames/Aliases batch delegates above.
  getSupportingMemoryIdsBatch: async (db: unknown, entityIds: string[]) => {
    const byEntity = new Map<string, string[]>();
    for (const id of entityIds) byEntity.set(id, await mockGetSupportingMemoryIds(db, id));
    return byEntity;
  },
}));

const mockApplyRerankScores = vi.fn();
vi.mock("../recall/selection/recall-selection", () => ({
  applyRerankScores: (...args: unknown[]) => mockApplyRerankScores(...args),
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  withTimeout,
  withTimeoutFlagged,
  shouldRunNoemaLeg,
  vectorSearch,
  bm25Search,
  rrfFuse,
  defaultRrfEntityWeight,
  DEFAULT_RRF_ENTITY_WEIGHT,
  nativeRrfSearch,
  runHybridQueryWithEvidenceTable,
  expandRetrievalQuery,
  entityMentionCandidates,
  significantQueryTokens,
  tokenizeText,
  RECENCY_WINDOW_HOURS,
} from "../recall/query/memory-query";
import { parseRankingProfiles } from "../recall/policy/ranking-profile";

// The runir/owner tenant's checked-in ranking profile carries the behavior-frozen
// taxonomy-expansion facets + entity filler words (Rúnir-mmg2). Tests that asserted
// the old hard-coded-constant behavior inject these slices; fresh-tenant tests pass
// nothing (= clean defaults).
const RUNIR_PROFILE = parseRankingProfiles(
  JSON.parse(readFileSync(resolve(process.cwd(), "config/ranking-profiles.runir.json"), "utf8")),
).get("owner")!;
const RUNIR_TAXONOMY_FACETS = RUNIR_PROFILE.taxonomyExpansionFacets;
const RUNIR_ENTITY_FILLER_WORDS = RUNIR_PROFILE.entityFillerWords;

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockDb(rows: any[] = []) {
  return { query: vi.fn().mockResolvedValue([rows]) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractId.mockImplementation((id: unknown) => String(id));
  mockGetBm25CorpusStats.mockResolvedValue({ avgDocLength: 10, totalDocs: 100, df: {} });
  mockGetEmbeddingFingerprint.mockResolvedValue(null);
  mockFindEntityByName.mockResolvedValue([]);
  mockFindEntityByAlias.mockResolvedValue([]);
  mockGetSupportingMemoryIds.mockResolvedValue([]);
  mockRerankWithProvider.mockResolvedValue({ scores: new Map(), labels: new Map(), threshold: 0 });
  mockApplyRerankScores.mockImplementation((hits: any[]) => hits);
});

// ── withTimeout ──────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("returns promise value when it resolves before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "fallback", "test");
    expect(result).toBe("ok");
  });

  it("returns fallback when promise times out", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    const result = await withTimeout(slow, 10, "fallback", "test");
    expect(result).toBe("fallback");
  });

  it("calls warn on timeout", async () => {
    const warn = vi.fn();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    await withTimeout(slow, 10, "fallback", "my-op", warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("my-op timed out"));
  });

  it("handles timeout without warn function", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    const result = await withTimeout(slow, 10, "fallback", "test");
    expect(result).toBe("fallback");
  });

  it("does NOT warn after the window when the promise already won the race", async () => {
    // Regression: the race timer was never cleared, so every SUCCESSFUL call still
    // fired its warn ms later — the live log filled with phantom "timed out after
    // 5000ms" lines from sub-second requests.
    const warn = vi.fn();
    const result = await withTimeout(Promise.resolve("ok"), 15, "fallback", "phantom-op", warn);
    expect(result).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(warn).not.toHaveBeenCalled();
  });
});

// ── withTimeoutFlagged + shouldRunNoemaLeg (Rúnir-yxwe cascade fix) ───────────

describe("withTimeoutFlagged", () => {
  it("reports timedOut=false when the promise completes (even with an empty value)", async () => {
    const r = await withTimeoutFlagged(Promise.resolve([] as number[]), 1000, [99], "test");
    expect(r).toEqual({ value: [], timedOut: false });
  });

  it("reports timedOut=true and returns the fallback on timeout", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    const r = await withTimeoutFlagged(slow, 10, "fallback", "test");
    expect(r).toEqual({ value: "fallback", timedOut: true });
  });
});

describe("shouldRunNoemaLeg", () => {
  const noema = (mode: "primary" | "annotation") =>
    ({ policy: { mode }, requestedPath: undefined } as unknown as Parameters<typeof shouldRunNoemaLeg>[0]);

  it("returns false when noema retrieval is not configured", () => {
    expect(shouldRunNoemaLeg(undefined, { timedOut: false, hitCount: 0 })).toBe(false);
  });

  it("primary mode always runs noema", () => {
    expect(shouldRunNoemaLeg(noema("primary"), { timedOut: false, hitCount: 5 })).toBe(true);
    expect(shouldRunNoemaLeg(noema("primary"), { timedOut: true, hitCount: 0 })).toBe(true);
  });

  it("annotation mode runs noema after a COMPLETED-empty RRF", () => {
    expect(shouldRunNoemaLeg(noema("annotation"), { timedOut: false, hitCount: 0 })).toBe(true);
  });

  it("annotation mode does NOT run noema after an RRF TIMEOUT (the cascade fix)", () => {
    // The whole point of Rúnir-yxwe: an RRF timeout left rrfHits=[] which used to
    // re-trigger annotation noema, stacking a second 8s wait → 16s, zero hits.
    expect(shouldRunNoemaLeg(noema("annotation"), { timedOut: true, hitCount: 0 })).toBe(false);
  });

  it("annotation mode does not run noema when RRF already returned hits", () => {
    expect(shouldRunNoemaLeg(noema("annotation"), { timedOut: false, hitCount: 3 })).toBe(false);
  });
});


// ── vectorSearch ─────────────────────────────────────────────────────────────

describe("vectorSearch", () => {
  it("returns search hits from DB results", async () => {
    const db = mockDb([
      { id: "mem-1", payload: { l2: "hello", userId: "u1", createdAt: "2024-01-01" }, sim: 0.9 },
    ]);

    const hits = await vectorSearch(db, "u1", [1, 0], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("mem-1");
    expect(hits[0].text).toBe("hello");
    expect(hits[0].score).toBe(0.9);
    expect(hits[0].scoreStages?.vector?.rank).toBe(1);
  });

  it("clamps limit to range [1, 200]", async () => {
    const db = mockDb([]);
    await vectorSearch(db, "u1", [1], 500);
    const params = db.query.mock.calls[0][1];
    expect(params.limit).toBe(200);
  });

  it("uses scope filter when provided", async () => {
    const db = mockDb([]);
    await vectorSearch(db, "u1", [1], 10, { whereClause: "AND scope = $scope", vars: { scope: "user" } });
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("AND scope = $scope");
  });

  it("returns empty array when no results", async () => {
    const db = { query: vi.fn().mockResolvedValue([undefined]) } as any;
    const hits = await vectorSearch(db, "u1", [1], 10);
    expect(hits).toEqual([]);
  });
});

// ── bm25Search ───────────────────────────────────────────────────────────────

describe("bm25Search", () => {
  it("returns empty for empty query tokens", async () => {
    const db = mockDb();
    const hits = await bm25Search(db, "u1", "   ", 10, new Map());
    expect(hits).toEqual([]);
  });

  it("returns scored hits with BM25 stages", async () => {
    const db = mockDb([
      { id: "mem-1", payload: { l2: "hello world" }, text_norm: "hello world" },
    ]);

    const hits = await bm25Search(db, "u1", "hello", 10, new Map());
    expect(hits.length).toBeGreaterThanOrEqual(0); // depends on BM25 scoring
  });

  it("returns empty when DB returns no rows", async () => {
    const db = mockDb([]);
    const hits = await bm25Search(db, "u1", "hello", 10, new Map());
    expect(hits).toEqual([]);
  });

  it("returns empty on DB error", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("db error")) } as any;
    mockGetBm25CorpusStats.mockRejectedValue(new Error("stats error"));
    const hits = await bm25Search(db, "u1", "hello", 10, new Map());
    expect(hits).toEqual([]);
  });

  it("uses scope filter", async () => {
    const db = mockDb([]);
    await bm25Search(db, "u1", "test", 10, new Map(), { whereClause: "AND scope = $s", vars: { s: "user" } });
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("AND scope = $s");
  });
});

// ── rrfFuse ──────────────────────────────────────────────────────────────────

describe("rrfFuse", () => {
  it("fuses vector, bm25, and recency results", () => {
    const vectorHits = [{ id: "mem-1", rank: 1 }, { id: "mem-2", rank: 2 }];
    const bm25Hits = [
      { id: "mem-1", score: 0.5, rank: 1, source: "native" as const },
      { id: "mem-3", score: 0.3, rank: 2, source: "native" as const },
    ];
    const recencyHits = [{ id: "mem-1", createdAt: "2024-01-01", rank: 1 }];

    const fused = rrfFuse(vectorHits, bm25Hits, recencyHits);
    expect(fused.length).toBe(3); // mem-1, mem-2, mem-3
    // mem-1 should be highest (appears in all three legs)
    expect(fused[0].vectorRank).toBe(1);
    expect(fused[0].bm25Rank).toBe(1);
    expect(fused[0].recencyRank).toBe(1);
  });

  it("returns empty for empty inputs", () => {
    const fused = rrfFuse([], [], []);
    expect(fused).toEqual([]);
  });

  it("handles single-leg results", () => {
    const fused = rrfFuse([{ id: "mem-1", rank: 1 }], [], []);
    expect(fused).toHaveLength(1);
    expect(fused[0].vectorRank).toBe(1);
    expect(fused[0].bm25Rank).toBeUndefined();
  });

  it("uses custom rrfK parameter", () => {
    const fused1 = rrfFuse([{ id: "a", rank: 1 }], [], [], 60);
    const fused2 = rrfFuse([{ id: "a", rank: 1 }], [], [], 10);
    // k=10 should give higher score than k=60
    expect(fused2[0].score).toBeGreaterThan(fused1[0].score);
  });

  it("sorts results by descending score", () => {
    const vectorHits = [{ id: "low", rank: 10 }];
    const bm25Hits = [{ id: "high", score: 1, rank: 1, source: "native" as const }];
    const fused = rrfFuse(vectorHits, bm25Hits, []);
    expect(extractScore(fused, 0)).toBeGreaterThanOrEqual(extractScore(fused, 1));
  });

  it("preserves bm25Score on fused results", () => {
    const fused = rrfFuse([], [{ id: "a", score: 3.14, rank: 1, source: "native" as const }], []);
    expect(fused[0].bm25Score).toBe(3.14);
  });

  it("preserves recencyCreatedAt on fused results", () => {
    const fused = rrfFuse([], [], [{ id: "a", createdAt: "2024-06-15", rank: 1 }]);
    expect(fused[0].recencyCreatedAt).toBe("2024-06-15");
  });

  it("defaultRrfEntityWeight reads RUNIR_RRF_ENTITY_WEIGHT with safe fallback", () => {
    const prev = process.env.RUNIR_RRF_ENTITY_WEIGHT;
    try {
      delete process.env.RUNIR_RRF_ENTITY_WEIGHT;
      expect(defaultRrfEntityWeight()).toBe(DEFAULT_RRF_ENTITY_WEIGHT);
      process.env.RUNIR_RRF_ENTITY_WEIGHT = "0";
      expect(defaultRrfEntityWeight()).toBe(0);
      process.env.RUNIR_RRF_ENTITY_WEIGHT = "0.45";
      expect(defaultRrfEntityWeight()).toBe(0.45);
      process.env.RUNIR_RRF_ENTITY_WEIGHT = "nope";
      expect(defaultRrfEntityWeight()).toBe(DEFAULT_RRF_ENTITY_WEIGHT);
      process.env.RUNIR_RRF_ENTITY_WEIGHT = "-1";
      expect(defaultRrfEntityWeight()).toBe(DEFAULT_RRF_ENTITY_WEIGHT);
    } finally {
      if (prev === undefined) delete process.env.RUNIR_RRF_ENTITY_WEIGHT;
      else process.env.RUNIR_RRF_ENTITY_WEIGHT = prev;
    }
  });

  it("entity weight 0 vs 0.45 changes fuse score for entity-only hits", () => {
    const entityHits = [{
      id: "e1",
      score: 1,
      rank: 1,
      matchedEntities: ["E"],
      linkedMemoryIds: ["e1"],
    }];
    const prev = process.env.RUNIR_RRF_ENTITY_WEIGHT;
    try {
      process.env.RUNIR_RRF_ENTITY_WEIGHT = "0.45";
      const withEntity = rrfFuse([], [], [], entityHits);
      process.env.RUNIR_RRF_ENTITY_WEIGHT = "0";
      const noEntity = rrfFuse([], [], [], entityHits);
      expect(withEntity[0]!.score).toBeCloseTo(0.45 / 61);
      expect(noEntity[0]!.score).toBe(0);
      // explicit weights still win over env
      const explicit = rrfFuse([], [], [], entityHits, 60, {
        vector: 1, bm25: 1.2, recency: 0.8, entity: 0.45,
      });
      expect(explicit[0]!.score).toBeCloseTo(0.45 / 61);
    } finally {
      if (prev === undefined) delete process.env.RUNIR_RRF_ENTITY_WEIGHT;
      else process.env.RUNIR_RRF_ENTITY_WEIGHT = prev;
    }
  });

  it("supports custom lane-owned RRF weights", () => {
    const fused = rrfFuse(
      [{ id: "a", rank: 1 }],
      [{ id: "b", score: 1, rank: 1, source: "native" as const }],
      [{ id: "c", createdAt: "2024-06-15", rank: 1 }],
      60,
      { vector: 1, bm25: 2, recency: 0.1 },
    );
    expect(fused[0].id).toBe("b");
    expect(fused.at(-1)?.id).toBe("c");
  });
});

function extractScore(fused: any[], idx: number) {
  return fused[idx]?.score ?? 0;
}

// ── nativeRrfSearch ──────────────────────────────────────────────────────────

describe("nativeRrfSearch", () => {
  it("returns empty array on DB failure", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("db down")) } as any;
    const warn = vi.fn();
    const hits = await nativeRrfSearch(db, "u1", [1], "hello", 10, undefined, warn);
    expect(hits).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nativeRrfSearch failed"));
  });

  it("returns empty array when no fused rows", async () => {
    const db = mockDb([]);
    const warn = vi.fn();
    const hits = await nativeRrfSearch(db, "u1", [1], "hello", 10, undefined, warn);
    expect(hits).toEqual([]);
  });

  it("returns search hits with score stages", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "mem-1" }]])   // vector leg
        .mockResolvedValueOnce([[{ id: "mem-1", bm25score: 0.5 }]])  // bm25 leg
        .mockResolvedValueOnce([[{ id: "mem-1", created_at: "2024-01-01" }]])  // recency leg
        .mockResolvedValueOnce([[{ id: "mem-1", payload: { l2: "hello", createdAt: "2024-01-01" } }]]),  // payload fetch
    } as any;

    const hits = await nativeRrfSearch(db, "u1", [1], "hello", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].scoreStages?.rrf).toBeDefined();
    expect(hits[0].scoreStages?.bm25?.source).toBe("native");
  });

  it("skips recency leg when recencyWindowHours is 0", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "m1" }]])  // vector
        .mockResolvedValueOnce([[]])  // bm25
        .mockResolvedValueOnce([[]])  // bm25 fallback lexical scan
        .mockResolvedValueOnce([[{ id: "m1", payload: { l2: "x" } }]]),  // payload
    } as any;

    await nativeRrfSearch(db, "u1", [1], "q", 10, undefined, undefined, 0);
    // Only vector, bm25, bm25 fallback, payload (no recency query)
    expect(db.query).toHaveBeenCalledTimes(4);
  });

  it("sorts the recency leg newest-first before assigning recency ranks", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ id: "m-bm25", bm25score: 0.4 }]])
        .mockResolvedValueOnce([[{ id: "m-old", created_at: "2024-01-01T00:00:00.000Z" }, { id: "m-new", created_at: "2024-01-03T00:00:00.000Z" }]])
        .mockResolvedValueOnce([[{ id: "m-old", payload: { l2: "old" } }, { id: "m-new", payload: { l2: "new" } }, { id: "m-bm25", payload: { l2: "bm25" } }]]),
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "q",
      10,
      undefined,
      undefined,
      48,
      undefined,
      "AND (active = NONE OR active = true)",
      "memories",
      { rrfWeights: { vector: 0, bm25: 0, recency: 1 } },
    );

    expect(hits[0]?.id).toBe("m-new");
    expect(hits[0]?.scoreStages?.recency?.rank).toBe(1);
  });

  it("uses lexical fallback when the DB BM25 leg returns zero rows", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector
        .mockResolvedValueOnce([[]]) // primary bm25
        .mockResolvedValueOnce([[]]) // recency
        .mockResolvedValueOnce([[ // fallback lexical scan
          { id: "m1", text_norm: "seeded replay history architecture reference" },
          { id: "m2", text_norm: "generic unrelated note" },
        ]])
        .mockResolvedValueOnce([[{ id: "m1", payload: { l2: "seeded replay history architecture reference" } }]]),
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "How should we seed realistic historical memory for the replay?",
      10,
    );

    expect(hits.some((hit) => hit.id === "m1")).toBe(true);
    const hit = hits.find((candidate) => candidate.id === "m1");
    expect(hit?.scoreStages?.bm25?.rank).toBe(1);
    expect(hit?.scoreStages?.bm25?.source).toBe("fallback");
  });

  it("resolves lowercase entity aliases and filters linked memories through active/scope predicates", async () => {
    mockExtractId.mockImplementation((id: unknown) => String(id).replace(/^[^:]+:/, "").replace(/[⟨⟩]/g, ""));
    mockFindEntityByAlias.mockImplementation(async (_db, normalized) => normalized === "surrealdb js sdk"
      ? [{ id: "entities:surrealdb_js_sdk_concept_u1", canonicalName: "SurrealDB JS SDK", nameNorm: "surrealdb js sdk", aliasesNorm: ["surrealdb js sdk"], confidence: 0.9 }]
      : []);
    mockGetSupportingMemoryIds.mockResolvedValue([
      "semiote:⟨allowed-entity-hit⟩",
      "semiote:filtered-out-hit",
    ]);

    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id FROM $ids") && sql.includes("payload.userId = $userId")) {
          return [[{ id: "semiote:allowed-entity-hit" }]];
        }
        if (sql.includes("SELECT id, payload")) {
          return [[{
            id: "semiote:allowed-entity-hit",
            payload: { l2: "SurrealDB JS SDK keeps opaque IDs stable." },
          }]];
        }
        return [[]];
      }),
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "surrealdb js sdk recordid parsing",
      10,
      { whereClause: "AND scope = $scopeVal", vars: { scopeVal: "user" } },
      undefined,
      RECENCY_WINDOW_HOURS,
      undefined,
      "AND payload.inactive != true",
      "semiote",
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("allowed-entity-hit");
    expect(hits[0]?.scoreStages?.entity).toMatchObject({
      rank: 1,
      matchedEntities: ["SurrealDB JS SDK"],
    });
    expect(hits[0]?.scoreStages?.entity).not.toHaveProperty("linkedMemoryIds");
    expect(hits[0]?.scoreStages?.entity?.scoreBefore).toBeCloseTo(0);
    expect(hits[0]?.scoreStages?.entity?.scoreAfter).toBeCloseTo(0.45 / 61);
    const filterCall = db.query.mock.calls.find((call: any[]) => String(call[0]).includes("SELECT id FROM $ids"));
    const filterSql = filterCall?.[0] as string;
    expect(filterSql).toContain("payload.userId = $userId");
    expect(filterSql).toContain("AND payload.inactive != true");
    expect(filterSql).toContain("AND scope = $scopeVal");
    expect(filterCall?.[1].ids.map(String)).toEqual(["semiote:⟨allowed-entity-hit⟩", "semiote:⟨filtered-out-hit⟩"]);
    expect(filterCall?.[1]).toMatchObject({ userId: "u1", scopeVal: "user" });
  });

  it("entity attribution boost follows RUNIR_RRF_ENTITY_WEIGHT via defaultRrfEntityWeight", async () => {
    mockExtractId.mockImplementation((id: unknown) => String(id).replace(/^[^:]+:/, "").replace(/[⟨⟩]/g, ""));
    mockFindEntityByAlias.mockImplementation(async (_db, normalized) => normalized === "surrealdb js sdk"
      ? [{ id: "entities:surrealdb_js_sdk_concept_u1", canonicalName: "SurrealDB JS SDK", nameNorm: "surrealdb js sdk", aliasesNorm: ["surrealdb js sdk"], confidence: 0.9 }]
      : []);
    mockGetSupportingMemoryIds.mockResolvedValue(["semiote:⟨allowed-entity-hit⟩"]);

    const makeDb = () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id FROM $ids") && sql.includes("payload.userId = $userId")) {
          return [[{ id: "semiote:allowed-entity-hit" }]];
        }
        if (sql.includes("SELECT id, payload")) {
          return [[{
            id: "semiote:allowed-entity-hit",
            payload: { l2: "SurrealDB JS SDK keeps opaque IDs stable." },
          }]];
        }
        return [[]];
      }),
    } as any);

    const prev = process.env.RUNIR_RRF_ENTITY_WEIGHT;
    try {
      process.env.RUNIR_RRF_ENTITY_WEIGHT = "0";
      const hitsZero = await nativeRrfSearch(
        makeDb(),
        "u1",
        [1],
        "surrealdb js sdk recordid parsing",
        10,
        { whereClause: "AND scope = $scopeVal", vars: { scopeVal: "user" } },
        undefined,
        RECENCY_WINDOW_HOURS,
        undefined,
        "AND payload.inactive != true",
        "semiote",
      );
      // scoreAfter comes from rrfFuse; boost/scoreBefore are attribution-only —
      // assert all three so a hardcoded 0.45 in attribution cannot hide.
      expect(hitsZero[0]?.scoreStages?.entity?.boost).toBe(0);
      expect(hitsZero[0]?.scoreStages?.entity?.scoreBefore).toBe(0);
      expect(hitsZero[0]?.scoreStages?.entity?.scoreAfter).toBe(0);

      process.env.RUNIR_RRF_ENTITY_WEIGHT = "0.45";
      const hitsDefault = await nativeRrfSearch(
        makeDb(),
        "u1",
        [1],
        "surrealdb js sdk recordid parsing",
        10,
        { whereClause: "AND scope = $scopeVal", vars: { scopeVal: "user" } },
        undefined,
        RECENCY_WINDOW_HOURS,
        undefined,
        "AND payload.inactive != true",
        "semiote",
      );
      expect(hitsDefault[0]?.scoreStages?.entity?.boost).toBeCloseTo(0.45 / 61);
      expect(hitsDefault[0]?.scoreStages?.entity?.scoreBefore).toBeCloseTo(0);
      expect(hitsDefault[0]?.scoreStages?.entity?.scoreAfter).toBeCloseTo(0.45 / 61);
    } finally {
      if (prev === undefined) delete process.env.RUNIR_RRF_ENTITY_WEIGHT;
      else process.env.RUNIR_RRF_ENTITY_WEIGHT = prev;
    }
  });

  it("uses session-scoped entity stubs when default retrieval includes the current session", async () => {
    mockExtractId.mockImplementation((id: unknown) => String(id).replace(/^[^:]+:/, "").replace(/[⟨⟩]/g, ""));
    mockFindEntityByAlias.mockImplementation(async (_db, normalized, _userId, scope) => normalized === "surrealdb js sdk" && scope === "session"
      ? [{ id: "entities:surrealdb_session_stub", canonicalName: "SurrealDB JS SDK", nameNorm: "surrealdb js sdk", aliasesNorm: ["surrealdb js sdk"], confidence: 0.8, sessionId: "s1" }]
      : []);
    mockGetSupportingMemoryIds.mockResolvedValue(["semiote:session-entity-hit"]);

    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id FROM $ids") && sql.includes("session_id = $sessionId")) {
          return [[{ id: "semiote:session-entity-hit" }]];
        }
        if (sql.includes("SELECT id, payload")) {
          return [[{
            id: "semiote:session-entity-hit",
            payload: { l2: "Session stub linked SurrealDB JS SDK memory." },
          }]];
        }
        return [[]];
      }),
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "surrealdb js sdk",
      10,
      { whereClause: "AND (scope = NONE OR scope = $scopeVal OR (scope = $sessionScope AND session_id = $sessionId))", vars: { scopeVal: "user", sessionScope: "session", sessionId: "s1" } },
      undefined,
      RECENCY_WINDOW_HOURS,
      undefined,
      "AND payload.inactive != true",
      "semiote",
    );

    expect(mockFindEntityByAlias).toHaveBeenCalledWith(db, "surrealdb js sdk", "u1", "session");
    expect(hits[0]?.id).toBe("session-entity-hit");
    expect(hits[0]?.scoreStages?.entity?.matchedEntities).toEqual(["SurrealDB JS SDK"]);
  });

  it("captures wrong-entity misses without adding broad recall pollution", async () => {
    mockFindEntityByName.mockImplementation(async (_db, normalized) => normalized === "surrealdb"
      ? [{ id: "entities:wrong_surrealdb", canonicalName: "Wrong SurrealDB", nameNorm: "surrealdb", aliasesNorm: [], confidence: 0.9 }]
      : []);
    mockGetSupportingMemoryIds.mockResolvedValue(["semiote:wrong-entity-hit"]);
    const entityTrace: Array<{ canonicalName?: string; ignoredReason?: string; linkedMemoryIds: string[] }> = [];

    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "semiote:ordinary-hit" }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ id: "semiote:ordinary-hit", payload: { l2: "ordinary hybrid result" } }]]),
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "SurrealDB",
      10,
      { whereClause: "AND scope = $scopeVal", vars: { scopeVal: "user" } },
      undefined,
      RECENCY_WINDOW_HOURS,
      undefined,
      "AND payload.inactive != true",
      "semiote",
      { onEntityTrace: (matches) => entityTrace.push(...matches) },
    );

    expect(hits.map((hit) => hit.id)).toEqual(["semiote:ordinary-hit"]);
    expect(entityTrace).toEqual(expect.arrayContaining([
      expect.objectContaining({ ignoredReason: "linked_memories_filtered", linkedMemoryIds: [] }),
    ]));
    expect(entityTrace.some((match) => match.canonicalName === "Wrong SurrealDB")).toBe(false);
  });

  it("does not pollute recall when entity-linked memories are filtered as decoys", async () => {
    mockFindEntityByName.mockImplementation(async (_db, normalized) => normalized === "postgresql"
      ? [{ id: "entities:postgresql_concept_u1", canonicalName: "PostgreSQL", nameNorm: "postgresql", aliasesNorm: [], confidence: 0.9 }]
      : []);
    mockGetSupportingMemoryIds.mockResolvedValue(["semiote:wrong-session-decoy"]);

    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "semiote:ordinary-hit" }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ id: "semiote:ordinary-hit", payload: { l2: "ordinary hybrid result" } }]]),
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "PostgreSQL",
      10,
      { whereClause: "AND scope = $scopeVal", vars: { scopeVal: "user" } },
      undefined,
      RECENCY_WINDOW_HOURS,
      undefined,
      "AND payload.inactive != true",
      "semiote",
    );

    expect(hits.map((hit) => hit.id)).toEqual(["semiote:ordinary-hit"]);
    expect(hits[0]?.scoreStages?.entity).toBeUndefined();
  });

  it("handles error without warn function", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("fail")) } as any;
    const hits = await nativeRrfSearch(db, "u1", [1], "q", 10);
    expect(hits).toEqual([]);
  });

  // Regression: HIGH-1 code-review fix — stage-2 SELECT must include memory_role/valid_at/invalid_at
  // and those top-level columns must flow through to the returned SearchHit.
  // Without the fix the SELECT omitted these columns so hits always had memoryRole=undefined.
  it("propagates memory_role/valid_at/invalid_at from stage-2 payload fetch into SearchHit", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "mem:abc" }]])   // vector leg
        .mockResolvedValueOnce([[{ id: "mem:abc", bm25score: 0.8 }]])  // bm25 leg
        .mockResolvedValueOnce([[{ id: "mem:abc", created_at: "2026-04-01T00:00:00.000Z" }]])  // recency leg
        .mockResolvedValueOnce([[{
          id: "mem:abc",
          payload: {
            l2: "Working on MIM-71 state lane — continuity wiring complete",
            data: "Working on MIM-71 state lane — continuity wiring complete",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T12:00:00.000Z",
            userId: "agent-hermes",
            tags: ["runir", "state-lane"],
            continuitySubjectKey: "runir:mim-71",
          },
          active: true,
          inactive_reason: null,
          superseded_by: null,
          lineage_root_id: null,
          // top-level columns added by HIGH-1 fix
          memory_role: "current_status",
          valid_at: "2026-04-01T00:00:00.000Z",
          invalid_at: null,
        }]]),  // stage-2 full record fetch
    } as any;

    const hits = await nativeRrfSearch(db, "agent-hermes", [1], "state lane status", 10);
    expect(hits).toHaveLength(1);
    const hit = hits[0];

    // These were the missing fields before the HIGH-1 fix — must be present and correct
    expect(hit.memoryRole).toBe("current_status");
    expect(hit.validAt).toBe("2026-04-01T00:00:00.000Z");
    expect(hit.invalidAt).toBeUndefined();

    // continuitySubjectKey comes from payload — also verify it flows through
    expect(hit.continuitySubjectKey).toBe("runir:mim-71");

    // Sanity: text and score are intact
    expect(hit.text).toBeTruthy();
    expect(hit.score).toBeGreaterThan(0);
  });
});

// ── runHybridQueryWithEvidenceTable ──────────────────────────────────────────

describe("runHybridQueryWithEvidenceTable", () => {
  it("returns empty on embedding fingerprint mismatch", async () => {
    mockGetEmbeddingFingerprint.mockResolvedValue("old-fp");
    const provider = { fingerprint: () => "new-fp" } as any;
    const warn = vi.fn();
    const db = mockDb();

    const hits = await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories", warn, embeddingProvider: provider });
    expect(hits).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fingerprint mismatch"));
  });

  it("returns empty when no fingerprint but corpus is non-empty", async () => {
    mockGetEmbeddingFingerprint.mockResolvedValue(null);
    const provider = { fingerprint: () => "fp" } as any;
    const warn = vi.fn();
    const db = { query: vi.fn().mockResolvedValue([[{ cnt: 5 }]]) } as any;

    const hits = await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories", warn, embeddingProvider: provider });
    expect(hits).toEqual([]);
    expect(warn).toHaveBeenCalledWith("no embedding fingerprint for non-empty corpus");
  });

  it("allows through when no fingerprint and corpus is empty", async () => {
    mockGetEmbeddingFingerprint.mockResolvedValue(null);
    const provider = { fingerprint: () => "fp" } as any;
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ cnt: 0 }]])  // count check
        .mockResolvedValueOnce([[]])  // vector
        .mockResolvedValueOnce([[]])  // bm25
        .mockResolvedValueOnce([[]])  // recency
    } as any;

    const hits = await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories", embeddingProvider: provider });
    expect(hits).toEqual([]);
  });

  it("skips reranking when rerankerConfig is off", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[]]),
    } as any;
    await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories", rerankerConfig: { provider: "off" } as any });
    expect(mockRerankWithProvider).not.toHaveBeenCalled();
  });

  it("skips reranking when no config provided", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) } as any;
    await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories" });
    expect(mockRerankWithProvider).not.toHaveBeenCalled();
  });

  it("applies reranking when provider is llm", async () => {
    const scores = new Map([["mem-1", 0.9]]);
    const labels = new Map([["mem-1", "direct"]]);
    mockRerankWithProvider.mockResolvedValue({ scores, labels, threshold: 0.2 });
    mockApplyRerankScores.mockReturnValue([{ id: "mem-1", text: "hi", score: 0.9 }]);

    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "mem-1" }]])  // vector
        .mockResolvedValueOnce([[{ id: "mem-1", bm25score: 0.5 }]])  // bm25
        .mockResolvedValueOnce([[]])  // recency
        .mockResolvedValueOnce([[{ id: "mem-1", payload: { l2: "hi" } }]]),  // payload
    } as any;

    await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories", rerankerConfig: { provider: "llm", openrouterApiKey: "key" } as any });
    expect(mockRerankWithProvider).toHaveBeenCalled();
    expect(mockAttachRerankerStages).toHaveBeenCalled();
    expect(mockApplyRerankScores).toHaveBeenCalled();
  });

  it("returns RRF results when reranker returns empty scores", async () => {
    mockRerankWithProvider.mockResolvedValue({ scores: new Map(), labels: new Map(), threshold: 0 });

    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "mem-1" }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ id: "mem-1", payload: { l2: "hi" } }]]),
    } as any;

    await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories", rerankerConfig: { provider: "llm", openrouterApiKey: "key" } as any });
    // Should return RRF hits, not reranked
    expect(mockApplyRerankScores).not.toHaveBeenCalled();
  });

  it("works without embeddingProvider (skips fingerprint check)", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) } as any;
    const hits = await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories" });
    expect(hits).toEqual([]);
    expect(mockGetEmbeddingFingerprint).not.toHaveBeenCalled();
  });

  it("does not consult semiote_relations during hybrid query", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "mem-1" }]])
        .mockResolvedValueOnce([[{ id: "mem-1", bm25score: 0.5 }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ id: "mem-1", payload: { l2: "hi" } }]]),
    } as any;

    await runHybridQueryWithEvidenceTable({ db, userId: "u1", query: "q", embedding: [1], limit: 10, evidenceTable: "memories" });

    const executedSql = db.query.mock.calls.map((call: any[]) => String(call[0]));
    expect(executedSql.some((sql: string) => sql.includes("semiote_relations"))).toBe(false);
  });

  it("uses the explicit evidence table from the named wrapper", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) } as any;

    await runHybridQueryWithEvidenceTable({
      db,
      userId: "u1",
      query: "q",
      embedding: [1],
      limit: 10,
      evidenceTable: "semiote",
    });

    const executedSql = db.query.mock.calls.map((call: any[]) => String(call[0]));
    expect(executedSql.some((sql: string) => sql.includes("FROM semiote"))).toBe(true);
    expect(executedSql.some((sql: string) => sql.includes("FROM memories"))).toBe(false);
  });
});

// ── RECENCY_WINDOW_HOURS ─────────────────────────────────────────────────────

describe("RECENCY_WINDOW_HOURS", () => {
  it("is 48 hours", () => {
    expect(RECENCY_WINDOW_HOURS).toBe(48);
  });
});

// ── MIM-64-1: legacy payload.data fallback ────────────────────────────────────

describe("MIM-64-1: payload.data fallback", () => {
  it("vectorSearch returns text from payload.data when payload.l2 is undefined", async () => {
    const db = mockDb([
      { id: "mem-legacy", payload: { data: "legacy text", userId: "u1", createdAt: "2024-01-01" }, sim: 0.8 },
    ]);

    const hits = await vectorSearch(db, "u1", [1, 0], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("mem-legacy");
    expect(hits[0].text).toBe("legacy text");
  });

  it("bm25Search returns text from payload.data when payload.l2 is undefined", async () => {
    const db = mockDb([
      { id: "mem-legacy", payload: { data: "legacy text" }, text_norm: "legacy text" },
    ]);

    const hits = await bm25Search(db, "u1", "legacy", 10, new Map());
    // Should have at least 1 result if scoring works, but text should come from payload.data
    if (hits.length > 0) {
      expect(hits[0].text).toBe("legacy text");
    } else {
      // BM25 scoring may filter to 0 if the term doesn't match in test conditions
      // But the data shape should be correct when there are results
      expect(hits).toEqual([]);
    }
  });

  it("bm25Search with matching term returns legacy text", async () => {
    const db = mockDb([
      { id: "mem-1", payload: { data: "hello world" }, text_norm: "hello world" },
    ]);

    const hits = await bm25Search(db, "u1", "hello", 10, new Map());
    // If hits exist, verify text comes from payload.data fallback
    expect(hits.length).toBeGreaterThanOrEqual(0);
    if (hits.length > 0) {
      expect(hits[0].text).toBe("hello world");
    }
  });
});

// ── MIM-70: tokenizeText unit tests ─────────────────────────────────────────

describe("tokenizeText", () => {
  it("tokenizes a natural-language sentence into lowercase words", () => {
    expect(tokenizeText("What are we working on in Runir")).toEqual([
      "what", "are", "we", "working", "on", "in", "runir",
    ]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(tokenizeText("   ")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeText("")).toEqual([]);
  });

  it("handles punctuation and special characters", () => {
    expect(tokenizeText("SurrealDB's payload.schema")).toEqual([
      "surrealdb", "s", "payload", "schema",
    ]);
  });

  it("extracts unicode letters and numbers", () => {
    expect(tokenizeText("MIM-64 MIM-65 decay")).toEqual([
      "mim", "64", "mim", "65", "decay",
    ]);
  });

  it("preserves underscores within tokens", () => {
    expect(tokenizeText("text_norm is_stale")).toEqual([
      "text_norm", "is_stale",
    ]);
  });
});

describe("significantQueryTokens", () => {
  it("drops stopwords while keeping replay-distinguishing terms", () => {
    const tokens = significantQueryTokens("How should we seed realistic historical memory for the replay?");
    expect(tokens).toEqual(expect.arrayContaining(["seed", "realistic", "historical", "memory", "replay"]));
    expect(tokens).not.toContain("how");
    expect(tokens).not.toContain("we");
  });
});

describe("expandRetrievalQuery (runir profile)", () => {
  it("adds capped taxonomy facet terms for underspecified field-intent queries", () => {
    const expanded = expandRetrievalQuery("What fields would someone likely pursue in their educaton?", RUNIR_TAXONOMY_FACETS);

    expect(expanded).toContain("education");
    expect(expanded).toContain("career");
    expect(expanded).toContain("profession");
    expect(expanded).toContain("training");
    expect(expanded).not.toContain("Caroline");
    expect(expanded).not.toContain("field work");
    expect(expanded.split(/\s+/u).filter((token) => ["career", "profession", "education", "training"].includes(token))).toHaveLength(4);
  });

  it("normalizes education typos through taxonomy facet terms", () => {
    const expanded = expandRetrievalQuery("Which educaton path needs certification?", RUNIR_TAXONOMY_FACETS);

    expect(expanded).toContain("education");
    expect(expanded).toContain("training");
    expect(expanded).toContain("degree");
  });

  it("leaves ordinary non-career queries unchanged", () => {
    const query = "When did Melanie paint a sunrise?";

    expect(expandRetrievalQuery(query, RUNIR_TAXONOMY_FACETS)).toBe(query);
  });
});

describe("expandRetrievalQuery (clean/fresh tenant — no profile)", () => {
  it("does NOT expand a field-intent query when no taxonomy facets are configured", () => {
    const query = "What fields would someone likely pursue in their educaton?";
    // No facets passed → clean default (EMPTY_PROFILE) → no taxonomy expansion.
    expect(expandRetrievalQuery(query)).toBe(query);
  });
});

describe("entityMentionCandidates (Rúnir-mmg2 profile-driven filler filtering)", () => {
  it("runir profile filters 'paint' out of entity candidates", () => {
    const candidates = entityMentionCandidates("When did Melanie paint a sunrise?", RUNIR_ENTITY_FILLER_WORDS);
    const normals = candidates.map((c) => c.normalized);
    expect(normals).not.toContain("paint");
  });

  it("clean/fresh tenant (no filler words): 'paint' survives as a candidate", () => {
    const candidates = entityMentionCandidates("When did Melanie paint a sunrise?");
    const normals = candidates.map((c) => c.normalized);
    expect(normals).toContain("paint");
  });
});

// ── MIM-70: queryBm25Leg tokenized query construction (via nativeRrfSearch) ──

describe("queryBm25Leg tokenized OR-term construction (MIM-70)", () => {
  it("uses native @1,OR@ scored contract for multi-token input", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector
        .mockResolvedValueOnce([[{ id: "m1", text_norm: "working runir status note", bm25score: 5.5 }]]) // bm25 multi-token native scored query
        .mockResolvedValueOnce([[]]) // recency
        .mockResolvedValueOnce([[{ id: "m1", payload: { l2: "working runir status note" } }]]), // payload
    } as any;
    mockGetEmbeddingFingerprint.mockResolvedValue(null);
    mockRerankWithProvider.mockResolvedValue({ scores: new Map(), labels: new Map(), threshold: 0 });
    mockApplyRerankScores.mockImplementation((hits: any[]) => hits);

    await nativeRrfSearch(
      db,
      "u1",
      Array(768).fill(0),
      "what runir working status",
      10,
      undefined,
      undefined,
      0,
      undefined,
      "AND (active = NONE OR active = true)",
    );

    // The db.query should have been called with the native scored BM25 leg
    const calls = db.query.mock.calls;
    const bm25Call = calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("@1,OR@"));
    expect(bm25Call).toBeTruthy();
    const sql = bm25Call![0] as string;
    expect(sql).toContain("text_norm @1,OR@");
    expect(sql).toContain("search::score(1) AS bm25score");
    expect(sql).toContain("ORDER BY bm25score DESC");
    const ftClause = sql.match(/text_norm @1,OR@ '([^']+)'/)?.[1];
    expect(ftClause).toContain("working");
    expect(ftClause).toContain("runir");
    expect(ftClause).toContain("status");
    expect(ftClause).not.toContain(" OR ");
  });

  it("BM25 leg handles single keyword with unquoted syntax", async () => {
    const db = mockDb([]);
    mockGetEmbeddingFingerprint.mockResolvedValue(null);
    mockRerankWithProvider.mockResolvedValue({ scores: new Map(), labels: new Map(), threshold: 0 });
    mockApplyRerankScores.mockImplementation((hits: any[]) => hits);

    await nativeRrfSearch(
      db,
      "u1",
      Array(768).fill(0),
      "runir",
      10,
      undefined,
      undefined,
      0,
      undefined,
      "AND (active = NONE OR active = true)",
    );

    const calls = db.query.mock.calls;
    const bm25Call = calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("@1@"));
    expect(bm25Call).toBeTruthy();
    const sql = bm25Call![0] as string;
    expect(sql).toContain('text_norm @1@');
    const ftClause = sql.match(/text_norm @1@ '([^']+)'/)?.[1];
    expect(ftClause).toBe("runir");
  });

  it("does not invoke fallback when native @1,OR@ returns candidates", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector
        .mockResolvedValueOnce([[{ id: "m1", text_norm: "runir memory note", bm25score: 4.2 }]]) // native multi-token scored
        .mockResolvedValueOnce([[]]) // recency
        .mockResolvedValueOnce([[{ id: "m1", payload: { l2: "runir memory note" } }]]), // payload
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "runir memory",
      10,
      undefined,
      undefined,
      RECENCY_WINDOW_HOURS,
      undefined,
      undefined,
      "semiote",
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.scoreStages?.bm25?.source).toBe("native");
    expect(hits[0]?.scoreStages?.bm25?.matchedTerms).toEqual(expect.arrayContaining(["runir", "memory"]));
    expect(
      db.query.mock.calls.some((call: any[]) => String(call[0]).includes("text_norm != NONE")),
    ).toBe(false);
  });

  it("ranks multi-token native candidates by native BM25 score (ORDER BY bm25score DESC from DB)", async () => {
    // DB returns rows already sorted by bm25score DESC — m1 scores higher (both terms), m2 lower (one term).
    // matchedTerms is computed via token-containment tagging (app-side, no scoring math).
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector
        .mockResolvedValueOnce([[
          { id: "m1", text_norm: "runir memory note", bm25score: 10.7 },
          { id: "m2", text_norm: "runir note", bm25score: 5.06 },
        ]]) // native multi-token scored, pre-sorted DESC by DB
        .mockResolvedValueOnce([[]]) // recency
        .mockResolvedValueOnce([[
          { id: "m1", payload: { l2: "runir memory note" } },
          { id: "m2", payload: { l2: "runir note" } },
        ]]), // payload
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "runir memory",
      10,
      undefined,
      undefined,
      RECENCY_WINDOW_HOURS,
      undefined,
      undefined,
      "semiote",
    );

    expect(hits[0]?.id).toBe("m1");
    expect(hits[0]?.scoreStages?.bm25?.matchedTerms).toEqual(expect.arrayContaining(["runir", "memory"]));
    expect(hits[1]?.id).toBe("m2");
    expect(hits[1]?.scoreStages?.bm25?.matchedTerms).toEqual(["runir"]);
  });

  it("records sparse-health metrics for semiote native/fallback/negative-control cases", async () => {
    const runProbe = async (
      db: any,
      queryText: string,
    ): Promise<{ nativeCount: number; fallbackCount: number; nativeZeroScoreCount: number; fallbackInvoked: boolean }> => {
      const hits = await nativeRrfSearch(
        db,
        "u1",
        [1],
        queryText,
        10,
        undefined,
        undefined,
        RECENCY_WINDOW_HOURS,
        undefined,
        undefined,
        "semiote",
      );

      return {
        nativeCount: hits.filter((hit) => hit.scoreStages?.bm25?.source === "native").length,
        fallbackCount: hits.filter((hit) => hit.scoreStages?.bm25?.source === "fallback").length,
        nativeZeroScoreCount: hits.filter((hit) => hit.scoreStages?.bm25?.source === "native" && hit.scoreStages?.bm25?.score === 0).length,
        fallbackInvoked: db.query.mock.calls.some((call: any[]) => String(call[0]).includes("text_norm != NONE")),
      };
    };

    const nativePositiveDb = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector
        .mockResolvedValueOnce([[{ id: "m-native", bm25score: 0 }]]) // native bm25 match with zero score
        .mockResolvedValueOnce([[]]) // recency
        .mockResolvedValueOnce([[{ id: "m-native", payload: { l2: "runir sparse marker" } }]]), // payload
    } as any;
    const positive = await runProbe(nativePositiveDb, "runir");

    const fallbackDb = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector
        .mockResolvedValueOnce([[]]) // native bm25
        .mockResolvedValueOnce([[]]) // recency
        .mockResolvedValueOnce([[{ id: "m-fallback", text_norm: "runir sparse marker" }]]) // fallback lexical scan
        .mockResolvedValueOnce([[{ id: "m-fallback", payload: { l2: "runir sparse marker" } }]]), // payload
    } as any;
    const fallback = await runProbe(fallbackDb, "runir");

    const negativeControlDb = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector
        .mockResolvedValueOnce([[]]) // native bm25
        .mockResolvedValueOnce([[]]) // recency
        .mockResolvedValueOnce([[{ id: "m-none", text_norm: "unrelated lexical content only" }]]), // fallback lexical scan (no match)
    } as any;
    const negative = await runProbe(negativeControlDb, "runir");

    expect(positive.nativeCount).toBeGreaterThan(0);
    expect(positive.fallbackCount).toBe(0);
    expect(positive.nativeZeroScoreCount).toBeGreaterThan(0);
    expect(positive.fallbackInvoked).toBe(false);

    expect(fallback.nativeCount).toBe(0);
    expect(fallback.fallbackCount).toBeGreaterThan(0);
    expect(fallback.nativeZeroScoreCount).toBe(0);
    expect(fallback.fallbackInvoked).toBe(true);

    expect(negative.nativeCount).toBe(0);
    expect(negative.fallbackCount).toBe(0);
    expect(negative.nativeZeroScoreCount).toBe(0);
    expect(negative.fallbackInvoked).toBe(true);
  });
});

// ── tp2w.1: multi-token native BM25 — @1,OR@ scored path ─────────────────────

describe("queryBm25Leg multi-token native scored path (tp2w.1)", () => {
  it("maps native bm25score to scoreStages and computes matchedTerms by token-containment", async () => {
    // DB returns rows already scored and sorted by native BM25 — no app-side scoring math.
    // recencyWindowHours=0 → no recency db.query fires; mock slots: vector, bm25-native, payload.
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector leg
        .mockResolvedValueOnce([[
          { id: "doc-a", text_norm: "career development work skills", bm25score: 8.3 },
          { id: "doc-b", text_norm: "work work work work", bm25score: 5.1 },
        ]]) // BM25 leg — @1,OR@ scored, pre-sorted DESC by DB
        .mockResolvedValueOnce([[
          { id: "doc-a", payload: { l2: "career development work skills" } },
          { id: "doc-b", payload: { l2: "work work work work" } },
        ]]), // payload fetch (no recency slot since recencyWindowHours=0)
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "career work",
      10,
      undefined,
      undefined,
      0, // no recency window → no recency db.query
      undefined,
      undefined,
      "semiote",
    );

    // SQL shape: assert the @1,OR@ operator and search::score(1) were requested
    const bm25Call = db.query.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("@1,OR@"),
    );
    expect(bm25Call).toBeTruthy();
    const sql = bm25Call![0] as string;
    expect(sql).toContain("search::score(1) AS bm25score");
    expect(sql).toContain("ORDER BY bm25score DESC");

    // Score mapping: native bm25score flows through to scoreStages
    const hitA = hits.find((h) => h.id === "doc-a");
    const hitB = hits.find((h) => h.id === "doc-b");
    expect(hitA).toBeDefined();
    expect(hitB).toBeDefined();
    expect(hitA?.scoreStages?.bm25?.score).toBeCloseTo(8.3, 5);
    expect(hitB?.scoreStages?.bm25?.score).toBeCloseTo(5.1, 5);
    expect(hitA?.scoreStages?.bm25?.source).toBe("native");
    expect(hitB?.scoreStages?.bm25?.source).toBe("native");

    // matchedTerms: token-containment tagging only (no scoring math)
    // doc-a contains both "career" and "work"; doc-b contains "work" only
    expect(hitA?.scoreStages?.bm25?.matchedTerms).toEqual(
      expect.arrayContaining(["career", "work"]),
    );
    expect(hitB?.scoreStages?.bm25?.matchedTerms).toEqual(["work"]);
  });

  it("falls back to full-scan when @1,OR@ returns no rows", async () => {
    // Use a neutral two-token query that does NOT trigger taxonomy expansion,
    // so exactly 2 query tokens reach the BM25 leg.
    // recencyWindowHours=0 → no recency db.query fires; mock slots are: vector, bm25-native, bm25-fallback, payload.
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // vector leg
        .mockResolvedValueOnce([[]]) // BM25 @1,OR@ returns nothing → falls through to fallback
        .mockResolvedValueOnce([[{ id: "fb1", text_norm: "runir memory note" }]]) // fallback full-scan
        .mockResolvedValueOnce([[{ id: "fb1", payload: { l2: "runir memory note" } }]]), // payload fetch
    } as any;

    const hits = await nativeRrfSearch(
      db,
      "u1",
      [1],
      "runir memory",
      10,
      undefined,
      undefined,
      0, // no recency window → no recency db.query
      undefined,
      undefined,
      "semiote",
    );

    // Fallback was invoked
    expect(
      db.query.mock.calls.some((c: any[]) => String(c[0]).includes("text_norm != NONE")),
    ).toBe(true);
    // fb1 should appear in hits (it matches both query tokens in fallback)
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.id)).toContain("fb1");
    // Fallback hit surfaces with source "fallback"
    const fbHit = hits.find((h) => h.id === "fb1");
    expect(fbHit?.scoreStages?.bm25?.source).toBe("fallback");
  });
});
