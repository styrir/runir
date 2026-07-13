/**
 * entity-alias-enricher.test.ts — Code-c7bj
 * Tests for entity alias enrichment via LLM.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAliasEnrichmentPrompt,
  enrichEntityAliases,
} from "../entities/entity-alias-enricher.js";
import type { EntityRecord } from "../domain/memory/types.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeFetchResponse(content: string) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
    text: () => Promise.resolve(""),
  });
}

function makeFetchError(status: number, body = "API error") {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.reject(new Error("no json")),
    text: () => Promise.resolve(body),
  });
}

function makeEntity(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: "entities:surrealdb_concept_user1",
    kind: "concept",
    canonicalName: "SurrealDB",
    nameNorm: "surrealdb",
    aliases: [],
    aliasesNorm: [],
    description: "Multi-model database",
    sourceProject: "runir",
    firstSeenAt: "2026-01-01",
    lastSeenAt: "2026-01-01",
    confidence: 0.95,
    scope: "user",
    userId: "user1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildAliasEnrichmentPrompt
// ---------------------------------------------------------------------------

describe("buildAliasEnrichmentPrompt", () => {
  it("includes canonicalName in the prompt", () => {
    const prompt = buildAliasEnrichmentPrompt({
      canonicalName: "SurrealDB",
      kind: "concept",
      description: "Multi-model database",
    });
    expect(prompt).toContain("SurrealDB");
  });

  it("includes description when provided", () => {
    const prompt = buildAliasEnrichmentPrompt({
      canonicalName: "SurrealDB",
      kind: "concept",
      description: "Multi-model database",
    });
    expect(prompt).toContain("Multi-model database");
  });

  it("includes entity kind", () => {
    const prompt = buildAliasEnrichmentPrompt({
      canonicalName: "SurrealDB",
      kind: "concept",
    });
    expect(prompt).toContain("concept");
  });

  it("does not include description line when description is absent", () => {
    const prompt = buildAliasEnrichmentPrompt({
      canonicalName: "SurrealDB",
      kind: "concept",
    });
    expect(prompt).not.toContain("Description:");
  });

  it("includes few-shot examples", () => {
    const prompt = buildAliasEnrichmentPrompt({
      canonicalName: "SurrealDB",
      kind: "concept",
    });
    expect(prompt).toContain("SRDB");
  });
});

// ---------------------------------------------------------------------------
// enrichEntityAliases
// ---------------------------------------------------------------------------

describe("enrichEntityAliases", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("writes aliases back to DB when LLM returns non-empty array", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(JSON.stringify({ aliases: ["SRDB", "Surreal"] })),
    );
    const db = { query: vi.fn(() => Promise.resolve([[]])) } as any;
    const entity = makeEntity();

    await enrichEntityAliases(db, entity, "fake-key");

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("SET"),
      expect.objectContaining({
        aliases: ["SRDB", "Surreal"],
      }),
    );
  });

  it("writes normalized aliasesNorm alongside aliases", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(JSON.stringify({ aliases: ["SRDB", "Surreal DB"] })),
    );
    const db = { query: vi.fn(() => Promise.resolve([[]])) } as any;
    const entity = makeEntity();

    await enrichEntityAliases(db, entity, "fake-key");

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("aliasesNorm"),
      expect.objectContaining({
        aliasesNorm: ["srdb", "surreal db"],
      }),
    );
  });

  it("stamps the attempted marker (aliases_enriched_at only) when LLM returns empty aliases array", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(JSON.stringify({ aliases: [] })),
    );
    const db = { query: vi.fn(() => Promise.resolve([[]])) } as any;
    const entity = makeEntity();

    await enrichEntityAliases(db, entity, "fake-key");

    expect(db.query).toHaveBeenCalledOnce();
    const [sql, vars] = db.query.mock.calls[0];
    expect(sql).toContain("aliases_enriched_at = time::now()");
    expect(sql).not.toContain("aliases =");
    expect(vars).toEqual({ id: "surrealdb_concept_user1" });
  });

  it("skips the LLM when aliases_enriched_at is already stamped", async () => {
    const db = { query: vi.fn(() => Promise.resolve([[]])) } as any;
    const entity = makeEntity({ aliases_enriched_at: "2026-07-01T00:00:00Z" });

    await enrichEntityAliases(db, entity, "fake-key");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("skips entirely when entity.aliases is already non-empty", async () => {
    const db = { query: vi.fn(() => Promise.resolve([[]])) } as any;
    const entity = makeEntity({ aliases: ["existing-alias"] });

    await enrichEntityAliases(db, entity, "fake-key");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not throw on LLM API error — graceful failure", async () => {
    mockFetch.mockReturnValueOnce(makeFetchError(500));
    const db = { query: vi.fn(() => Promise.resolve([[]])) } as any;
    const entity = makeEntity();

    await expect(enrichEntityAliases(db, entity, "fake-key")).rejects.toThrow();
    // db.query should not have been called
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not throw on unparseable JSON from LLM", async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse("not json at all"));
    const db = { query: vi.fn(() => Promise.resolve([[]])) } as any;
    const entity = makeEntity();

    await expect(enrichEntityAliases(db, entity, "fake-key")).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
  });
});
