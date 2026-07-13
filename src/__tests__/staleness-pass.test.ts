import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../lifecycle/semion/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  writeStalenessBacklog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../storage/surreal/surreal-store.js", () => ({
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: vi.fn(),
  extractId: vi.fn((id: unknown) => String(id).replace(/^[^:]+:/, "").replace(/[⟨⟩]/g, "")),
}));

vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

vi.mock("../storage/writes/write-arbitrator.js", () => ({
  deriveStatementKey: vi.fn().mockImplementation((text: string) => text),
}));

import { runStalenessPass, runStalenessCoreNoLock } from "../lifecycle/semion/staleness-pass.js";

// Mock the db
function makeDb(): { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue([[]]) };
}

const FACTS = [
  { text: "Server runs on port 7700", confidence: 0.9, replacementMemoryId: "mem:new1" },
];

const BASE_OPTS = {
  userId: "user-1",
  scope: "user" as const,
  sessionId: "sess-1",
  facts: FACTS,
  apiKey: "test-key",
  embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
  logger: vi.fn(),
};

describe("runStalenessPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { checked: 0, superseded: 0 } on lock contention and writes backlog", async () => {
    const { acquireLock, writeStalenessBacklog } = await import("../lifecycle/semion/lock.js");
    vi.mocked(acquireLock).mockResolvedValue(null); // lock held → contention

    const db = makeDb();
    const result = await runStalenessPass({ ...BASE_OPTS, db: db as any });

    expect(result).toEqual({ checked: 0, superseded: 0 });
    expect(writeStalenessBacklog).toHaveBeenCalledOnce();
    expect(writeStalenessBacklog).toHaveBeenCalledWith(
      db,
      "user-1",
      "user",
      "sess-1",
      FACTS,
    );
  });

  it("returns { checked: 0, superseded: 0 } when no candidates found from BM25 or vector", async () => {
    const { acquireLock, releaseLock } = await import("../lifecycle/semion/lock.js");
    vi.mocked(acquireLock).mockResolvedValue("holder-uuid"); // acquired
    vi.mocked(releaseLock).mockResolvedValue(undefined);

    // db.query returns empty results (no BM25 candidates, no vector candidates)
    const db = { query: vi.fn().mockResolvedValue([[]]) };

    const result = await runStalenessPass({ ...BASE_OPTS, db: db as any });

    expect(result).toEqual({ checked: 0, superseded: 0 });
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("skips LLM call when both tiers return no candidates", async () => {
    const { acquireLock, releaseLock } = await import("../lifecycle/semion/lock.js");
    vi.mocked(acquireLock).mockResolvedValue("holder-uuid");
    vi.mocked(releaseLock).mockResolvedValue(undefined);

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const db = { query: vi.fn().mockResolvedValue([[]]) };
    await runStalenessPass({ ...BASE_OPTS, db: db as any });

    // fetch should NOT have been called (no candidates = skip LLM)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Rúnir-n7ze.12: staleness flags now folded into supersedeMemory atomically ──

describe("runStalenessCoreNoLock — staleness flags passed atomically to supersedeMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeLlmResponse(staleEntries: Array<{ existingId: string; reason: string; supersededByNewFactIndex: number }>) {
    return {
      ok: true,
      json: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ stale: staleEntries }) }],
      }),
    };
  }

  it("passes previousStaleFlags with replacementMemoryId as contradictedBy to supersedeMemory", async () => {
    const { supersedeMemory } = await import("../storage/surreal/surreal-store.js");
    const db = makeDb();
    db.query
      .mockResolvedValueOnce([[{ id: "old-1", text: "old fact", userId: "user-1", scope: "user" }]])
      .mockResolvedValue([[]]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      makeLlmResponse([{ existingId: "old-1", reason: "outdated", supersededByNewFactIndex: 0 }]),
    ));

    const facts = [{ text: "Server runs on port 7700", confidence: 0.9, replacementMemoryId: "mem:new1" }];
    await runStalenessCoreNoLock({ ...BASE_OPTS, facts, db: db as any });

    expect(vi.mocked(supersedeMemory)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(supersedeMemory).mock.calls[0];
    // 8th arg (index 7) is previousStaleFlags
    const staleFlags = callArgs[7] as { staleSince: string; contradictedBy: string } | undefined;
    expect(staleFlags).toBeDefined();
    expect(staleFlags?.contradictedBy).toBe("new1");
    expect(typeof staleFlags?.staleSince).toBe("string");
    expect(staleFlags?.staleSince).not.toBe("");

    // No separate db.query for isStale UPDATE should be issued
    const updateCalls = db.query.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && (c[0] as string).includes("payload.isStale = true"),
    );
    expect(updateCalls.length).toBe(0);
  });

  it("passes previousStaleFlags with synthesized UUID as contradictedBy when replacementMemoryId is empty", async () => {
    const { supersedeMemory } = await import("../storage/surreal/surreal-store.js");
    const db = makeDb();
    db.query
      .mockResolvedValueOnce([[{ id: "old-2", text: "old fact", userId: "user-1", scope: "user" }]])
      .mockResolvedValue([[]]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      makeLlmResponse([{ existingId: "old-2", reason: "outdated", supersededByNewFactIndex: 0 }]),
    ));

    const facts = [{ text: "Server runs on port 7700", confidence: 0.9, replacementMemoryId: "" }];
    await runStalenessCoreNoLock({ ...BASE_OPTS, facts, db: db as any });

    expect(vi.mocked(supersedeMemory)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(supersedeMemory).mock.calls[0];
    const staleFlags = callArgs[7] as { staleSince: string; contradictedBy: string } | undefined;
    expect(staleFlags).toBeDefined();
    // UUID fallback — non-empty string, not "mem:new1"
    expect(typeof staleFlags?.contradictedBy).toBe("string");
    expect(staleFlags?.contradictedBy).not.toBe("");
    expect(staleFlags?.contradictedBy).not.toBe("mem:new1");
    expect(typeof staleFlags?.staleSince).toBe("string");

    // No separate db.query for isStale UPDATE
    const updateCalls = db.query.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && (c[0] as string).includes("payload.isStale = true"),
    );
    expect(updateCalls.length).toBe(0);
  });

  it("logs and continues when supersedeMemory throws (per-entry resilience)", async () => {
    const { supersedeMemory } = await import("../storage/surreal/surreal-store.js");
    vi.mocked(supersedeMemory).mockRejectedValueOnce(new Error("db write error"));

    const db = makeDb();
    db.query
      .mockResolvedValueOnce([[
        { id: "old-3", text: "old fact", userId: "user-1", scope: "user" },
        { id: "old-4", text: "old fact 2", userId: "user-1", scope: "user" },
      ]])
      .mockResolvedValue([[]]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ stale: [
          { existingId: "old-3", reason: "outdated", supersededByNewFactIndex: 0 },
          { existingId: "old-4", reason: "outdated", supersededByNewFactIndex: 0 },
        ] }) }],
      }),
    }));

    const logger = vi.fn();
    const facts = [{ text: "Server runs on port 7700", confidence: 0.9, replacementMemoryId: "mem:new1" }];
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, facts, db: db as any, logger });

    // First entry threw — logged and continued; second entry succeeded
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("staleness supersede failed for old-3"));
    // supersedeMemory called for both entries
    expect(vi.mocked(supersedeMemory)).toHaveBeenCalledTimes(2);
    // Only the second succeeded → superseded=1
    expect(result.superseded).toBe(1);
  });

  it("threads the resolved tableName into wouldCreateCycle's cycle guard (Rúnir-ekos B-LIVE-2)", async () => {
    const { wouldCreateCycle } = await import("../lifecycle/semion/dag-guard.js");
    const db = makeDb();
    db.query
      .mockResolvedValueOnce([[{ id: "old-1", text: "old fact", userId: "user-1", scope: "user" }]])
      .mockResolvedValue([[]]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      makeLlmResponse([{ existingId: "old-1", reason: "outdated", supersededByNewFactIndex: 0 }]),
    ));

    const facts = [{ text: "Server runs on port 7700", confidence: 0.9, replacementMemoryId: "mem:new1" }];
    await runStalenessCoreNoLock({ ...BASE_OPTS, facts, tableName: "semiote", db: db as any });

    expect(vi.mocked(wouldCreateCycle)).toHaveBeenCalledWith(
      db, "new1", "old-1", "user-1", "semiote",
    );
  });
});


describe("runStalenessCoreNoLock — bm25 query syntax", () => {
  it("uses Surreal fulltext @0@ syntax instead of MATCHES", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) } as any;

    await runStalenessCoreNoLock({
      ...BASE_OPTS,
      db,
      facts: [{ text: "current project status blocked local testing", confidence: 0.9, replacementMemoryId: "m1" }],
    });

    const [sql] = db.query.mock.calls[0] ?? [];
    expect(sql).toContain("text_norm @0@");
    expect(sql).not.toContain("MATCHES");
  });

  it("excludes replacement ids using type::record(tableName, ...)", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) } as any;

    await runStalenessCoreNoLock({
      ...BASE_OPTS,
      db,
      facts: [{ text: "current project status blocked local testing", confidence: 0.9, replacementMemoryId: "mem:new1" }],
    });

    const [sql] = db.query.mock.calls[0] ?? [];
    // Rúnir-ekos B4: tableName now defaults to PRIMARY_MEMORY_TABLE ("semiote"),
    // not the legacy "memories" literal.
    expect(sql).toContain("id NOT IN [type::record('semiote', 'new1')]");
  });
});


describe("runStalenessCoreNoLock — provider contract", () => {
  it("calls OpenRouter chat completions with Bearer auth and parses OpenRouter responses", async () => {
    const db = makeDb();
    db.query.mockResolvedValueOnce([[{ id: "old-1", text: "old fact", userId: "user-1", scope: "user" }]]).mockResolvedValue([[]]);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ stale: [{ existingId: "old-1", reason: "outdated", supersededByNewFactIndex: 0 }] }) } }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await runStalenessCoreNoLock({ ...BASE_OPTS, db: db as any });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });
});
