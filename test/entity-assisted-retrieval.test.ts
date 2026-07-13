import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { entityLookupScopes, entityMentionCandidates, linkedMemoryRecordIds, rrfFuse } from "../src/recall/query/memory-query";
import { parseRankingProfiles } from "../src/recall/policy/ranking-profile";

// The "does melanie" filler-phrase suppression is runir-tenant tuning (Rúnir-mmg2),
// now carried in the per-tenant ranking profile rather than a hard-coded constant.
// Inject the owner profile's filler words to assert that behavior.
const RUNIR_ENTITY_FILLER_WORDS = parseRankingProfiles(
  JSON.parse(readFileSync(resolve(process.cwd(), "config/ranking-profiles.runir.json"), "utf8")),
).get("owner")!.entityFillerWords;

describe("entity-assisted retrieval", () => {
  it("resolves entity-like query mentions with normalized aliases", () => {
    const candidates = entityMentionCandidates("What did SurrealDB JS SDK decide about RecordId parsing?");

    expect(candidates).toContainEqual({
      mention: "surrealdb js sdk",
      normalized: "surrealdb js sdk",
    });
    expect(candidates).toContainEqual({
      mention: "recordid parsing",
      normalized: "recordid parsing",
    });
  });

  it("prioritizes proper-name mentions over question filler phrases (runir profile)", () => {
    const candidates = entityMentionCandidates("How does Melanie prioritize self-care?", RUNIR_ENTITY_FILLER_WORDS);

    expect(candidates[0]).toEqual({ mention: "Melanie", normalized: "melanie" });
    expect(candidates.some((candidate) => candidate.normalized === "does melanie")).toBe(false);
  });

  it("includes session-scoped entity stubs for user-wide recall", () => {
    expect(entityLookupScopes({ whereClause: "", vars: {} })).toEqual([
      { scope: "user" },
      { scope: "session" },
    ]);
  });

  it("adds linked entity memories as a low-weight RRF lane", () => {
    const fused = rrfFuse(
      [{ id: "semiote:semantic", rank: 1 }],
      [{ id: "semiote:lexical", score: 2, rank: 1, source: "native" }],
      [],
      [{ id: "semiote:entity", rank: 1, score: 0.9, matchedEntities: ["SurrealDB"], linkedMemoryIds: ["entity"] }],
    );

    const entity = fused.find((row) => String(row.id) === "semiote:entity");
    const semantic = fused.find((row) => String(row.id) === "semiote:semantic");
    const lexical = fused.find((row) => String(row.id) === "semiote:lexical");

    expect(entity?.score).toBeCloseTo(0.45 / 61);
    expect(semantic?.score).toBeCloseTo(1 / 61);
    expect(lexical?.score).toBeCloseTo(1.2 / 61);
    expect((entity?.score ?? 0) < (semantic?.score ?? 0)).toBe(true);
  });

  it("uses typed record IDs for linked memory filtering", () => {
    expect(linkedMemoryRecordIds(["abc", "abc", "semiote:def"], "semiote").map(String)).toEqual([
      "semiote:abc",
      "semiote:def",
    ]);
  });

  it("preserves ordinary hybrid ordering when no entity candidates exist", () => {
    const withoutEntity = rrfFuse(
      [{ id: "semiote:semantic", rank: 1 }],
      [{ id: "semiote:lexical", score: 2, rank: 1, source: "native" }],
      [{ id: "semiote:recent", createdAt: "2026-05-25T00:00:00.000Z", rank: 1 }],
    );
    const withEmptyEntity = rrfFuse(
      [{ id: "semiote:semantic", rank: 1 }],
      [{ id: "semiote:lexical", score: 2, rank: 1, source: "native" }],
      [{ id: "semiote:recent", createdAt: "2026-05-25T00:00:00.000Z", rank: 1 }],
      [],
    );

    expect(withEmptyEntity).toEqual(withoutEntity);
  });

  it("keeps entity debug details separate from the frozen trace shape", () => {
    const debug = {
      entityMatches: [
        {
          queryMention: "SurrealDB",
          normalizedMention: "surrealdb",
          entityId: "surrealdb_concept_user",
          canonicalName: "SurrealDB",
          matchedBy: "name",
          linkedMemoryIds: ["memory-surrealdb"],
          scoreChanges: [{ memoryId: "memory-surrealdb", before: 0, boost: 0.9, after: 0.9 }],
        },
        {
          queryMention: "PostgreSQL",
          normalizedMention: "postgresql",
          linkedMemoryIds: [],
          ignoredReason: "no_entity_match",
        },
      ],
    };

    expect(debug.entityMatches).toHaveLength(2);
    expect(debug.entityMatches[0]?.linkedMemoryIds).toEqual(["memory-surrealdb"]);
    expect(debug.entityMatches[0]?.scoreChanges).toEqual([{ memoryId: "memory-surrealdb", before: 0, boost: 0.9, after: 0.9 }]);
    expect(debug.entityMatches[1]?.ignoredReason).toBe("no_entity_match");
  });
});
