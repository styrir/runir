import { describe, it, expect } from "vitest";
import {
  resolveAttributionFilter,
  mergeFilters,
  applyRecallSoftFilters,
} from "../src/recall/query/scope-predicate";
import type { SearchHit } from "../src/domain/memory/types";

// --- Code-vufa: resolveAttributionFilter tests ---

describe("resolveAttributionFilter", () => {
  it("returns empty filter when both path and client are undefined", () => {
    const result = resolveAttributionFilter(undefined, undefined);
    expect(result.whereClause).toBe("");
    expect(result.vars).toEqual({});
  });

  it("returns path clause and var when only path is provided", () => {
    const result = resolveAttributionFilter("/Users/brooks/Code/runir", undefined);
    expect(result.whereClause).toBe("AND payload.path = $attrPath");
    expect(result.vars).toEqual({ attrPath: "/Users/brooks/Code/runir" });
  });

  it("returns client clause and var when only client is provided", () => {
    const result = resolveAttributionFilter(undefined, "hermes");
    expect(result.whereClause).toBe("AND payload.client = $attrClient");
    expect(result.vars).toEqual({ attrClient: "hermes" });
  });

  it("keeps client filtering strict and does not widen to untagged records", () => {
    const result = resolveAttributionFilter(undefined, "hermes");
    expect(result.whereClause).not.toContain("payload.client = NONE");
    expect(result.whereClause).not.toContain("OR");
  });

  it("returns both clauses joined and both vars when both path and client are provided", () => {
    const result = resolveAttributionFilter("/Users/brooks/Code/runir", "claude-code");
    expect(result.whereClause).toBe(
      "AND payload.path = $attrPath AND payload.client = $attrClient",
    );
    expect(result.vars).toEqual({
      attrPath: "/Users/brooks/Code/runir",
      attrClient: "claude-code",
    });
  });

  it("SQL injection safety: evil path ends up in vars only, never in whereClause", () => {
    const evilPath = "'; DROP TABLE memories; --";
    const result = resolveAttributionFilter(evilPath, undefined);
    // The whereClause must NOT contain the evil string
    expect(result.whereClause).not.toContain(evilPath);
    // The whereClause must only contain the parameterized form
    expect(result.whereClause).toBe("AND payload.path = $attrPath");
    // The value ends up safely in vars
    expect(result.vars.attrPath).toBe(evilPath);
  });
});

// --- Code-y399: mergeFilters tests ---

describe("mergeFilters", () => {
  it("merges two non-empty filters: concatenates whereClauses and merges vars", () => {
    const a = { whereClause: "AND scope = $scopeVal", vars: { scopeVal: "user" } };
    const b = { whereClause: "AND payload.path = $attrPath", vars: { attrPath: "/foo" } };
    const result = mergeFilters(a, b);
    expect(result.whereClause).toBe("AND scope = $scopeVal AND payload.path = $attrPath");
    expect(result.vars).toEqual({ scopeVal: "user", attrPath: "/foo" });
  });

  it("skips empty filter: only non-empty clause appears", () => {
    const empty = { whereClause: "", vars: {} };
    const nonEmpty = { whereClause: "AND payload.client = $attrClient", vars: { attrClient: "hermes" } };
    const result = mergeFilters(empty, nonEmpty);
    expect(result.whereClause).toBe("AND payload.client = $attrClient");
    expect(result.vars).toEqual({ attrClient: "hermes" });
  });

  it("returns empty whereClause and vars when all filters are empty", () => {
    const result = mergeFilters(
      { whereClause: "", vars: {} },
      { whereClause: "", vars: {} },
    );
    expect(result.whereClause).toBe("");
    expect(result.vars).toEqual({});
  });
});

// --- Code-mftz: applyRecallSoftFilters tests ---

function makeHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    id: "memories:test",
    text: "test memory",
    score: 0.9,
    createdAt: "2026-03-01T00:00:00Z",
    tier: "working",
    confidence: 0.8,
    tags: ["typescript", "testing"],
    ...overrides,
  };
}

describe("applyRecallSoftFilters", () => {
  it("pass-through when filter is empty (all fields undefined)", () => {
    const hits = [makeHit(), makeHit({ id: "memories:test2" })];
    const result = applyRecallSoftFilters(hits, {});
    expect(result).toEqual(hits);
  });

  it("since filter: only returns hits at or after cutoff date", () => {
    const old = makeHit({ id: "memories:old", createdAt: "2026-01-01T00:00:00Z" });
    const recent = makeHit({ id: "memories:recent", createdAt: "2026-03-15T00:00:00Z" });
    const result = applyRecallSoftFilters([old, recent], { since: "2026-03-01T00:00:00Z" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("memories:recent");
  });

  it("since filter: includes hit exactly at cutoff boundary", () => {
    const hit = makeHit({ createdAt: "2026-03-01T00:00:00Z" });
    const result = applyRecallSoftFilters([hit], { since: "2026-03-01T00:00:00Z" });
    expect(result).toHaveLength(1);
  });

  it("tier filter: only returns hits with matching tier", () => {
    const durable = makeHit({ id: "memories:durable", tier: "durable" });
    const working = makeHit({ id: "memories:working", tier: "working" });
    const ephemeral = makeHit({ id: "memories:ephemeral", tier: "ephemeral" });
    const result = applyRecallSoftFilters([durable, working, ephemeral], { tier: "durable" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("memories:durable");
  });

  it("confidence filter: only returns hits at or above threshold", () => {
    const low = makeHit({ id: "memories:low", confidence: 0.5 });
    const mid = makeHit({ id: "memories:mid", confidence: 0.75 });
    const high = makeHit({ id: "memories:high", confidence: 0.95 });
    const result = applyRecallSoftFilters([low, mid, high], { confidence: 0.75 });
    expect(result).toHaveLength(2);
    expect(result.map((h) => h.id)).toContain("memories:mid");
    expect(result.map((h) => h.id)).toContain("memories:high");
  });

  it("tags filter: any-match semantics — hit passes if ANY tag matches", () => {
    const match = makeHit({ id: "memories:match", tags: ["typescript", "bun"] });
    const noMatch = makeHit({ id: "memories:nomatch", tags: ["python", "django"] });
    const result = applyRecallSoftFilters([match, noMatch], { tags: ["typescript", "go"] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("memories:match");
  });

  it("invalid since (NaN date): passes all hits through without filtering", () => {
    const hits = [makeHit(), makeHit({ id: "memories:test2" })];
    const result = applyRecallSoftFilters(hits, { since: "not-a-date" });
    // Should pass through all hits — not discard everything
    expect(result).toHaveLength(2);
  });

  it("confidence filter: excludes hits with undefined confidence", () => {
    const withConf = makeHit({ id: "memories:with", confidence: 0.9 });
    const withoutConf = makeHit({ id: "memories:without", confidence: undefined });
    const result = applyRecallSoftFilters([withConf, withoutConf], { confidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("memories:with");
  });
});
