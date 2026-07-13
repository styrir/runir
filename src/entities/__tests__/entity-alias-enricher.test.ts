import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAliasEnrichmentPrompt,
  enrichEntityAliases,
  runEntityAliasEnrichment,
} from "../entity-alias-enricher.js";
import type { EntityRecord } from "../../domain/memory/types.js";

describe("buildAliasEnrichmentPrompt", () => {
  it("includes the canonicalName and kind", () => {
    const p = buildAliasEnrichmentPrompt({
      canonicalName: "SurrealDB",
      kind: "concept",
    });
    expect(p).toContain("SurrealDB");
    expect(p).toContain("concept");
  });

  it("includes the description line when description is provided", () => {
    const p = buildAliasEnrichmentPrompt({
      canonicalName: "OpenAI",
      kind: "org",
      description: "AI research lab in San Francisco",
    });
    expect(p).toContain("Description: AI research lab in San Francisco");
  });

  it("omits the description line when description is missing", () => {
    const p = buildAliasEnrichmentPrompt({
      canonicalName: "PKM",
      kind: "concept",
    });
    expect(p).not.toMatch(/^Description:/m);
  });

  it("omits the description line when description is an empty string", () => {
    const p = buildAliasEnrichmentPrompt({
      canonicalName: "PKM",
      kind: "concept",
      description: "",
    });
    expect(p).not.toMatch(/^Description:/m);
  });

  it("asks the model for JSON without markdown fences", () => {
    const p = buildAliasEnrichmentPrompt({ canonicalName: "Foo", kind: "concept" });
    expect(p).toMatch(/aliases/i);
    expect(p).toMatch(/No markdown fences/i);
    expect(p).toMatch(/Respond with ONLY valid JSON/i);
  });

  it("renders the documented example list in the prompt", () => {
    const p = buildAliasEnrichmentPrompt({ canonicalName: "Foo", kind: "concept" });
    expect(p).toMatch(/SurrealDB.*SRDB/);
    expect(p).toMatch(/PostgreSQL.*Postgres/);
  });
});

function makeEntity(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: "entities:abc",
    kind: "concept",
    canonicalName: "Test Entity",
    nameNorm: "test entity",
    aliases: [],
    aliasesNorm: [],
    sourceProject: "test",
    firstSeenAt: "2026-05-15T00:00:00.000Z",
    lastSeenAt: "2026-05-15T00:00:00.000Z",
    confidence: 1,
    scope: "user",
    userId: "user-1",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function mockFetchOk(body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("enrichEntityAliases", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("skips entities that already have aliases", async () => {
    const dbQuery = vi.fn();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const entity = makeEntity({ aliases: ["already", "set"] });

    await enrichEntityAliases(
      { query: dbQuery } as unknown as never,
      entity,
      "api-key",
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("writes aliases when LLM returns a non-empty list", async () => {
    const dbQuery = vi.fn(async () => []);
    globalThis.fetch = mockFetchOk({
      choices: [
        {
          message: {
            content: '{"aliases": ["SRDB", "Surreal"]}',
          },
        },
      ],
    }) as unknown as typeof fetch;

    const entity = makeEntity();
    await enrichEntityAliases(
      { query: dbQuery } as unknown as never,
      entity,
      "api-key",
    );

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(dbQuery).toHaveBeenCalledOnce();
    const call = dbQuery.mock.calls[0] as unknown as [string, { aliases: string[]; aliasesNorm: string[] }];
    const sentVars = call[1];
    expect(sentVars.aliases).toEqual(["SRDB", "Surreal"]);
    expect(sentVars.aliasesNorm).toEqual(["srdb", "surreal"]);
  });

  it("strips markdown code fences from LLM output before parsing", async () => {
    const dbQuery = vi.fn(async () => []);
    globalThis.fetch = mockFetchOk({
      choices: [
        {
          message: {
            content: '```json\n{"aliases": ["A", "B"]}\n```',
          },
        },
      ],
    }) as unknown as typeof fetch;

    await enrichEntityAliases(
      { query: dbQuery } as unknown as never,
      makeEntity(),
      "api-key",
    );

    expect(dbQuery).toHaveBeenCalledOnce();
  });

  it("stamps aliases_enriched_at WITHOUT touching aliases when LLM returns an empty array", async () => {
    const dbQuery = vi.fn(async () => []);
    globalThis.fetch = mockFetchOk({
      choices: [{ message: { content: '{"aliases": []}' } }],
    }) as unknown as typeof fetch;

    await enrichEntityAliases(
      { query: dbQuery } as unknown as never,
      makeEntity(),
      "api-key",
    );

    // Attempted-marker write: without it every export re-pays the LLM for
    // entities the model has no aliases for (runaway paid loop).
    expect(dbQuery).toHaveBeenCalledOnce();
    const [sql, vars] = dbQuery.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(sql).toContain("aliases_enriched_at = time::now()");
    expect(sql).not.toContain("aliases =");
    expect(sql).not.toContain("aliasesNorm");
    expect(vars).toEqual({ id: "abc" });
  });

  it("skips the LLM entirely when aliases_enriched_at is already set", async () => {
    const dbQuery = vi.fn();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const entity = makeEntity({ aliases: [], aliases_enriched_at: "2026-07-01T00:00:00Z" });

    await enrichEntityAliases(
      { query: dbQuery } as unknown as never,
      entity,
      "api-key",
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("filters non-string and empty alias entries", async () => {
    const dbQuery = vi.fn(async () => []);
    globalThis.fetch = mockFetchOk({
      choices: [
        {
          message: {
            content: '{"aliases": ["ok", 42, "", "  ", "trim me  "]}',
          },
        },
      ],
    }) as unknown as typeof fetch;

    await enrichEntityAliases(
      { query: dbQuery } as unknown as never,
      makeEntity(),
      "api-key",
    );

    expect(dbQuery).toHaveBeenCalledOnce();
    const filteredCall = dbQuery.mock.calls[0] as unknown as [string, { aliases: string[] }];
    expect(filteredCall[1].aliases).toEqual(["ok", "trim me"]);
  });

  it("throws when the LLM API returns a non-OK status", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(
      enrichEntityAliases(
        { query: vi.fn() } as unknown as never,
        makeEntity(),
        "api-key",
      ),
    ).rejects.toThrow(/LLM gateway error 429/);
  });
});

describe("runEntityAliasEnrichment", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("short-circuits with zero counts when apiKey is empty", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dbQuery = vi.fn();

    const result = await runEntityAliasEnrichment(
      { query: dbQuery } as unknown as never,
      "",
    );

    expect(result).toEqual({
      processed: 0,
      enriched: 0,
      failed: 0,
      errors: [],
      durationMs: 0,
    });
    expect(stderr).toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("returns failure summary when initial entity fetch throws", async () => {
    const dbQuery = vi.fn(async () => {
      throw new Error("db down");
    });

    const result = await runEntityAliasEnrichment(
      { query: dbQuery } as unknown as never,
      "api-key",
    );

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toMatch(/Failed to fetch entities/);
  });

  it("processes one entity successfully", async () => {
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM entities")) {
        return [[makeEntity()]];
      }
      return [];
    });
    globalThis.fetch = mockFetchOk({
      choices: [{ message: { content: '{"aliases": ["X"]}' } }],
    }) as unknown as typeof fetch;

    const result = await runEntityAliasEnrichment(
      { query: dbQuery } as unknown as never,
      "api-key",
    );

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("records per-entity failures without aborting the batch", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM entities")) {
        return [[makeEntity({ canonicalName: "Bad" })]];
      }
      throw new Error("write failed");
    });
    globalThis.fetch = mockFetchOk({
      choices: [{ message: { content: '{"aliases": ["X"]}' } }],
    }) as unknown as typeof fetch;

    const result = await runEntityAliasEnrichment(
      { query: dbQuery } as unknown as never,
      "api-key",
    );

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toMatch(/Bad/);
    expect(stderr).toHaveBeenCalled();
  });
});
