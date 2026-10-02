import { describe, expect, it, vi } from "vitest";
import { PROCESSING_LINEAGE_VERSION } from "../domain/memory/processing-lineage.js";
import { getSearchHitLineage } from "../domain/memory/search-hit-lineage.js";
import { mapMemoryRowToSearchHit } from "../storage/surreal/surreal-client.js";
import {
  bm25Search,
  nativeRrfSearch,
  vectorSearch,
} from "../recall/query/memory-query.js";

const USER = "user.sourcec.r2.unit";
const VALID_LINEAGE = {
  state: "minni_verified",
  origin: "minni",
  producer_principal_ref: "principal.sourcec.r2.unit",
  producer_registration_ref: "registration.sourcec.r2.unit",
  processing_policy_version: "runir.minni.local/v1",
  admitted_operation: "capture_ingest",
  target_user_id: USER,
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "ordinary",
    restrictions: [],
  },
} as const;
const INVALID_LINEAGE = { ...VALID_LINEAGE, state: "forged" };

function row(id: string, processingLineage?: unknown) {
  return {
    id,
    payload: {
      l2: `synthetic ${id}`,
      userId: USER,
      tags: ["synthetic"],
      processing_lineage: VALID_LINEAGE,
    },
    ...(processingLineage === undefined ? {} : { processing_lineage: processingLineage }),
    text_norm: `lineage ${id}`,
    created_at: "2026-10-01T21:00:00.000Z",
    updated_at: "2026-10-01T21:00:00.000Z",
    active: true,
    embedding: [1, 0, 0],
    sim: 0.9,
  };
}

describe("R2 query storage-lineage handoff", () => {
  it("classifies the actual vector and BM25 full projections without changing scores", async () => {
    const rows = [row("valid", VALID_LINEAGE), row("legacy"), row("invalid", INVALID_LINEAGE)];
    const vectorDb = { query: vi.fn().mockResolvedValue([rows]) } as any;
    const vectorHits = await vectorSearch(vectorDb, USER, [1, 0, 0], 10, undefined, "semiote");
    expect(vectorHits.map((hit) => getSearchHitLineage(hit).state)).toEqual([
      "minni_verified",
      "legacy_unknown",
      "invalid",
    ]);
    expect(vectorHits[0].score).toBe(0.9);
    expect(vectorDb.query.mock.calls[0][0]).toContain("SELECT id, payload, processing_lineage");

    const bm25Db = {
      query: vi.fn(async (sql: string) => sql.includes("GROUP ALL")
        ? [[{ total_docs: 3, avg_doc_length: 2 }]]
        : [rows]),
    } as any;
    const bm25Hits = await bm25Search(bm25Db, USER, "lineage", 10, new Map(), undefined, "semiote");
    expect(bm25Hits.map((hit) => getSearchHitLineage(hit).state)).toEqual([
      "minni_verified",
      "legacy_unknown",
      "invalid",
    ]);
    expect(bm25Db.query.mock.calls.find(([sql]: [string]) => sql.includes("text_norm @0@"))?.[0])
      .toContain("processing_lineage");

    const multiRows = [
      { ...row("both", INVALID_LINEAGE), payload: { ...row("both", INVALID_LINEAGE).payload, l2: "alpha beta" }, text_norm: "alpha beta" },
      { ...row("alpha", VALID_LINEAGE), payload: { ...row("alpha", VALID_LINEAGE).payload, l2: "alpha" }, text_norm: "alpha" },
      { ...row("beta", undefined), payload: { ...row("beta", undefined).payload, l2: "beta" }, text_norm: "beta" },
    ];
    const multiDb = {
      query: vi.fn(async (sql: string) => sql.includes("GROUP ALL")
        ? [[{ total_docs: 3, avg_doc_length: 1.33 }]]
        : [multiRows]),
    } as any;
    const multiHits = await bm25Search(
      multiDb,
      USER,
      "alpha beta",
      2,
      new Map(),
      { whereClause: "AND scope = $scope", vars: { scope: "user" } },
      "semiote",
    );
    expect(multiHits).toHaveLength(2);
    expect(multiHits[0].score).toBeGreaterThan(multiHits[1].score);
    expect(multiHits[0].scoreStages?.bm25?.matchedTerms).toEqual(["alpha", "beta"]);
    const multiCall = multiDb.query.mock.calls.find(([sql]: [string]) => sql.includes("text_norm @0,OR@"));
    expect(multiCall?.[0]).toContain("text_norm @0,OR@ 'alpha beta'");
    expect(multiCall?.[0]).toContain("AND scope = $scope");
    expect(multiCall?.[1]).toMatchObject({ userId: USER, limit: 2, scope: "user" });
  });

  it("keeps one-argument foreign rows unavailable and preserves selected state through RRF spreads and JSON", async () => {
    const manual = mapMemoryRowToSearchHit(row("manual", VALID_LINEAGE));
    expect(getSearchHitLineage(manual)).toEqual({ state: "unavailable" });

    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[
          { id: "valid", rank: 1 },
          { id: "legacy", rank: 2 },
          { id: "invalid", rank: 3 },
        ]])
        .mockResolvedValueOnce([[
          row("valid", VALID_LINEAGE),
          row("legacy"),
          row("invalid", INVALID_LINEAGE),
        ]]),
    } as any;
    const hits = await nativeRrfSearch(db, USER, [1, 0, 0], "", 10, undefined, undefined, 0);
    expect(hits.map((hit) => getSearchHitLineage(hit).state)).toEqual([
      "minni_verified",
      "legacy_unknown",
      "invalid",
    ]);
    for (const hit of hits) {
      expect(JSON.stringify(hit)).not.toContain("processing_lineage");
      expect(JSON.stringify(hit)).not.toContain("minni_verified");
      expect(getSearchHitLineage({ ...hit })).toEqual(getSearchHitLineage(hit));
    }
    expect(db.query.mock.calls[1][0]).toContain("processing_lineage");
  });
});
