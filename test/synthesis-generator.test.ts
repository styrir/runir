import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSynthesisPrompt,
  callGeminiFlash,
  inferParaPlacement,
  qualifiesForSynthesis,
  upsertSynthesis,
  type SynthesisNote,
} from "../src/lifecycle/synthesis/synthesis-generator.js";
import type { MemoryCluster } from "../src/lifecycle/compaction/memory-clusterer.js";
import type { RawMemoryRow } from "../src/capture/enrichment/memory-enricher.js";

function memory(overrides: Partial<RawMemoryRow> = {}): RawMemoryRow {
  return {
    id: "mem-1",
    l2: "Some content",
    l0: "short",
    l1: "summary",
    category: "cases",
    tier: "working",
    tags: [],
    writeSource: "capture",
    createdAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function cluster(overrides: Partial<MemoryCluster> = {}): MemoryCluster {
  return {
    fingerprintId: "fp-1",
    label: "test cluster",
    memoryIds: ["m1", "m2", "m3", "m4"],
    entityIds: ["e1", "e2"],
    size: 4,
    method: "entity_cooccurrence",
    ...overrides,
  };
}

describe("qualifiesForSynthesis", () => {
  it("returns false when cluster size is below minimum", () => {
    expect(qualifiesForSynthesis(cluster({ size: 2 }), null)).toBe(false);
  });

  it("returns false for singleton clusters", () => {
    expect(qualifiesForSynthesis(cluster({ size: 4, method: "singleton" }), null)).toBe(false);
  });

  it("returns true for a fresh qualifying cluster", () => {
    expect(qualifiesForSynthesis(cluster({ size: 4 }), null)).toBe(true);
  });

  it("returns false when delta is below minNewMemories", () => {
    const existing: SynthesisNote = {
      l0: "x",
      l1: "y",
      l2: "z",
      clusterId: "c",
      memoryIds: [],
      entityIds: [],
      tags: [],
      para_placement: "01 Projects",
      lastMemoryCount: 3,
      updateCount: 1,
    };
    expect(qualifiesForSynthesis(cluster({ size: 4 }), existing)).toBe(false);
  });

  it("returns true when delta meets minNewMemories", () => {
    const existing: SynthesisNote = {
      l0: "x",
      l1: "y",
      l2: "z",
      clusterId: "c",
      memoryIds: [],
      entityIds: [],
      tags: [],
      para_placement: "01 Projects",
      lastMemoryCount: 1,
      updateCount: 1,
    };
    expect(qualifiesForSynthesis(cluster({ size: 4 }), existing)).toBe(true);
  });
});

describe("buildSynthesisPrompt", () => {
  it("emits system and user content", () => {
    const out = buildSynthesisPrompt([memory()]);
    expect(out.system).toContain("knowledge synthesizer");
    expect(out.user).toContain("Synthesize the following 1");
  });

  it("sorts memories by createdAt", () => {
    const out = buildSynthesisPrompt([
      memory({ id: "z", createdAt: "2026-05-15T12:00:00.000Z", l0: "newer" }),
      memory({ id: "a", createdAt: "2026-05-15T00:00:00.000Z", l0: "older" }),
    ]);
    expect(out.user.indexOf("older")).toBeLessThan(out.user.indexOf("newer"));
  });

  it("falls back to l2 prefix when l0 is empty", () => {
    const out = buildSynthesisPrompt([
      memory({ l0: "", l2: "The full content of this memory" }),
    ]);
    expect(out.user).toContain("The full content of this memory");
  });
});

describe("inferParaPlacement", () => {
  it("returns 04 Archives when any memory has archive hint", () => {
    expect(
      inferParaPlacement("some content", [memory({ para_hint: "archive" })]),
    ).toBe("04 Archives");
  });

  it("returns 04 Archives when any memory is inactive", () => {
    expect(
      inferParaPlacement("some content", [memory({ active: false })]),
    ).toBe("04 Archives");
  });

  it("returns 04 Archives when any memory is superseded", () => {
    expect(
      inferParaPlacement("some content", [memory({ supersededById: "x" })]),
    ).toBe("04 Archives");
  });

  it("returns 01 Projects on majority project hint", () => {
    expect(
      inferParaPlacement("content", [
        memory({ id: "1", para_hint: "project" }),
        memory({ id: "2", para_hint: "project" }),
        memory({ id: "3", para_hint: "project" }),
      ]),
    ).toBe("01 Projects");
  });

  it("returns 02 Areas on majority area hint", () => {
    expect(
      inferParaPlacement("content", [
        memory({ id: "1", para_hint: "area" }),
        memory({ id: "2", para_hint: "area" }),
        memory({ id: "3", para_hint: "area" }),
      ]),
    ).toBe("02 Areas");
  });

  it("returns 03 Resources on majority resource hint", () => {
    expect(
      inferParaPlacement("content", [
        memory({ id: "1", para_hint: "resource" }),
        memory({ id: "2", para_hint: "resource" }),
        memory({ id: "3", para_hint: "resource" }),
      ]),
    ).toBe("03 Resources");
  });

  it("falls back to 01 Projects when l2 mentions a ticket id", () => {
    expect(inferParaPlacement("Track ticket MIM-42", [memory()])).toBe(
      "01 Projects",
    );
  });

  it("falls back to 03 Resources when l2 reads like a how-to", () => {
    expect(
      inferParaPlacement("How to use the SurrealDB INSERT statement", [memory()]),
    ).toBe("03 Resources");
  });

  it("falls back to 02 Areas with first-person preference signals", () => {
    expect(
      inferParaPlacement("I always prefer feature flags over branches", [memory()]),
    ).toBe("02 Areas");
  });

  it("defaults to 03 Resources for unclassified developer notes", () => {
    expect(inferParaPlacement("some neutral content", [memory()])).toBe(
      "03 Resources",
    );
  });
});

function mockFetchOk(body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("callGeminiFlash", () => {
  let originalFetch: typeof fetch;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("parses an OK response into {l0, l1, l2}", async () => {
    globalThis.fetch = mockFetchOk({
      choices: [
        {
          message: {
            content: '{"l0":"topic","l1":"## Context\\nA","l2":"detailed prose"}',
          },
        },
      ],
    }) as unknown as typeof fetch;

    const out = await callGeminiFlash(
      { system: "sys", user: "usr" },
      "api-key",
    );
    expect(out).toEqual({ l0: "topic", l1: "## Context\nA", l2: "detailed prose" });
  });

  it("returns null and logs when the API returns non-OK", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server error", { status: 500 }),
    ) as unknown as typeof fetch;

    const out = await callGeminiFlash(
      { system: "sys", user: "usr" },
      "api-key",
    );
    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns null on JSON parse failure", async () => {
    globalThis.fetch = mockFetchOk({
      choices: [{ message: { content: "not-json" } }],
    }) as unknown as typeof fetch;

    const out = await callGeminiFlash(
      { system: "sys", user: "usr" },
      "api-key",
    );
    expect(out).toBeNull();
  });

  it("strips markdown code fences from LLM output", async () => {
    globalThis.fetch = mockFetchOk({
      choices: [
        {
          message: {
            content: '```json\n{"l0":"a","l1":"b","l2":"c"}\n```',
          },
        },
      ],
    }) as unknown as typeof fetch;

    const out = await callGeminiFlash(
      { system: "sys", user: "usr" },
      "api-key",
    );
    expect(out).toEqual({ l0: "a", l1: "b", l2: "c" });
  });

  it("coerces missing fields to empty strings", async () => {
    globalThis.fetch = mockFetchOk({
      choices: [{ message: { content: "{}" } }],
    }) as unknown as typeof fetch;

    const out = await callGeminiFlash(
      { system: "sys", user: "usr" },
      "api-key",
    );
    expect(out).toEqual({ l0: "", l1: "", l2: "" });
  });
});

describe("upsertSynthesis", () => {
  it("updates existing synthesis when existingId is provided", async () => {
    const dbQuery = vi.fn(async () => [[]]);
    await upsertSynthesis(
      { query: dbQuery } as unknown as never,
      cluster(),
      "l0",
      "l1",
      "l2",
      "01 Projects",
      [memory()],
      "synthesis_notes:abc",
      3,
    );
    const updateCall = dbQuery.mock.calls.find(
      (c) => String((c as unknown as unknown[])[0]).includes("UPDATE $id SET"),
    );
    expect(updateCall).toBeDefined();
  });

  it("creates a new synthesis when no existingId is provided", async () => {
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT canonicalName FROM entities")) {
        return [[{ canonicalName: "SurrealDB" }]];
      }
      if (sql.includes("CREATE synthesis_notes CONTENT")) {
        return [[{ id: "synthesis_notes:new" }]];
      }
      return [];
    });
    const newId = await upsertSynthesis(
      { query: dbQuery } as unknown as never,
      cluster({ id: "memory_clusters:abc" }),
      "l0",
      "l1",
      "l2",
      "01 Projects",
      [memory({ tags: ["t1", "t2"] })],
    );
    expect(newId).toBe("synthesis_notes:new");
    const createCall = dbQuery.mock.calls.find(
      (c) => String((c as unknown as unknown[])[0]).includes("CREATE synthesis_notes"),
    );
    expect(createCall).toBeDefined();
    const updateClusterCall = dbQuery.mock.calls.find(
      (c) => String((c as unknown as unknown[])[0]).includes("UPDATE $clusterId SET synthesisId"),
    );
    expect(updateClusterCall).toBeDefined();
  });

  it("skips entity-name fetch when cluster has no entityIds", async () => {
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("CREATE synthesis_notes")) {
        return [[{ id: "synthesis_notes:new" }]];
      }
      return [];
    });
    await upsertSynthesis(
      { query: dbQuery } as unknown as never,
      cluster({ entityIds: [] }),
      "l0",
      "l1",
      "l2",
      "01 Projects",
      [memory()],
    );
    const entityCall = dbQuery.mock.calls.find(
      (c) => String((c as unknown as unknown[])[0]).includes("SELECT canonicalName FROM entities"),
    );
    expect(entityCall).toBeUndefined();
  });
});
