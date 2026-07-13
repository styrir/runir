import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
const mockSupersedeMemory = vi.fn();
const mockWouldCreateCycle = vi.fn();
const mockDeriveStatementKey = vi.fn();

vi.mock("../storage/surreal/surreal-store.js", () => ({
  SurrealClient: vi.fn(),
  supersedeMemory: (...args: unknown[]) => mockSupersedeMemory(...args),
  extractId: (id: unknown) => String(id).replace(/^[^:]+:/, "").replace(/[⟨⟩]/g, ""),
}));

vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: (...args: unknown[]) => mockWouldCreateCycle(...args),
}));

vi.mock("../storage/writes/write-arbitrator.js", () => ({
  deriveStatementKey: (...args: unknown[]) => mockDeriveStatementKey(...args),
}));

vi.mock("../lifecycle/semion/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  writeStalenessBacklog: vi.fn(),
}));

import { runStalenessCoreNoLock } from "../lifecycle/semion/staleness-pass";

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockDeriveStatementKey.mockImplementation((t: string) => t);
  mockWouldCreateCycle.mockResolvedValue(false);
  mockSupersedeMemory.mockResolvedValue(undefined);
});

describe("runStalenessCoreNoLock", () => {
  it("skips global scope", async () => {
    const result = await runStalenessCoreNoLock({
      db: { query: vi.fn().mockResolvedValue([[]]) } as any,
      userId: "u1",
      scope: "global",
      facts: [{ text: "fact", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
    });
    expect(result).toEqual({ checked: 0, superseded: 0 });
  });

  it("returns 0 when no candidates found (with logger)", async () => {
    mockDeriveStatementKey.mockReturnValue("short");
    const db = { query: vi.fn().mockResolvedValue([[]]) } as any;
    const logger = vi.fn();
    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "x", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
      logger,
    });
    expect(result).toEqual({ checked: 0, superseded: 0 });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("0 candidates"));
  });

  it("uses vector fallback when BM25 returns empty", async () => {
    mockDeriveStatementKey.mockReturnValue("multiple tokens here for search");
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]]) // BM25 empty
        .mockResolvedValueOnce([[{ id: "c1", text: "old fact here", userId: "u1", scope: "user" }]]), // vector
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify({ stale: [] }) }] }),
    } as Response);

    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact about something", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
    });
    expect(result.checked).toBe(1);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("supersedes stale entries from LLM", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "user prefers light mode", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            stale: [{ existingId: "c1", reason: "contradicted", supersededByNewFactIndex: 0 }],
          }),
        }],
      }),
    } as Response);

    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "user prefers dark mode", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
    });
    expect(result.superseded).toBe(1);
    expect(mockSupersedeMemory).toHaveBeenCalledTimes(1);
  });

  it("handles LLM HTTP error gracefully", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 } as Response);

    const logger = vi.fn();
    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
      logger,
    });
    expect(result.superseded).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("LLM call failed"));
  });

  it("handles invalid JSON from LLM", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "not json at all" }] }),
    } as Response);

    const logger = vi.fn();
    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
      logger,
    });
    expect(result.superseded).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("invalid JSON"));
  });

  it("accepts JSON wrapped in markdown fences", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: "```json\n{\"stale\":[{\"existingId\":\"c1\",\"reason\":\"old\",\"supersededByNewFactIndex\":0}]}\n```",
          },
        }],
      }),
    } as Response);

    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
    });

    expect(result.superseded).toBe(1);
    expect(mockSupersedeMemory).toHaveBeenCalledTimes(1);
  });

  it("skips stale entry with invalid fact index", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({ stale: [{ existingId: "c1", reason: "old", supersededByNewFactIndex: 99 }] }),
        }],
      }),
    } as Response);

    const logger = vi.fn();
    await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
      logger,
    });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("invalid fact index"));
  });

  it("skips stale entry with unknown candidate ID", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({ stale: [{ existingId: "unknown-id", reason: "old", supersededByNewFactIndex: 0 }] }),
        }],
      }),
    } as Response);

    const logger = vi.fn();
    await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
      logger,
    });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("unknown candidate"));
  });

  it("normalizes full Surreal record ids returned by the LLM", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              stale: [{ existingId: "memories:⟨c1⟩", reason: "old", supersededByNewFactIndex: 0 }],
            }),
          },
        }],
      }),
    } as Response);

    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
    });

    expect(result.superseded).toBe(1);
    expect(mockSupersedeMemory).toHaveBeenCalledTimes(1);
  });

  it("skips self-staleness candidates instead of triggering cycle warnings", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "m1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              stale: [{ existingId: "memories:⟨m1⟩", reason: "old", supersededByNewFactIndex: 0 }],
            }),
          },
        }],
      }),
    } as Response);

    const logger = vi.fn();
    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
      logger,
    });

    expect(result.superseded).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("skipping self-staleness candidate"));
    expect(mockSupersedeMemory).not.toHaveBeenCalled();
  });

  it("skips supersede when cycle detected", async () => {
    mockWouldCreateCycle.mockResolvedValue(true);
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({ stale: [{ existingId: "c1", reason: "stale", supersededByNewFactIndex: 0 }] }),
        }],
      }),
    } as Response);

    const logger = vi.fn();
    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
      logger,
    });
    expect(result.superseded).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("cycle detected"));
  });

  it("uses BM25 results when available (not vector fallback)", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old fact about modes", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify({ stale: [] }) }] }),
    } as Response);

    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
    });
    expect(result.checked).toBe(1);
    // Only 1 query (BM25 found results, no vector fallback)
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("handles empty content from LLM response", async () => {
    mockDeriveStatementKey.mockReturnValue("the user prefers dark mode theme");
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "c1", text: "old", userId: "u1", scope: "user" },
      ]]),
    } as any;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ content: [] }),
    } as Response);

    const logger = vi.fn();
    const result = await runStalenessCoreNoLock({
      db,
      userId: "u1",
      scope: "user",
      facts: [{ text: "new fact here now today", confidence: 0.9, replacementMemoryId: "m1" }],
      apiKey: "key",
      embedText: async () => [1, 0],
      logger,
    });
    // Empty content → JSON.parse("{}") → stale = undefined → []
    expect(result.superseded).toBe(0);
  });
});
