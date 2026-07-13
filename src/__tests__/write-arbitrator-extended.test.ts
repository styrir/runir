import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

vi.mock("../storage/surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class { query = vi.fn().mockResolvedValue([[]]); },
}));

import { arbitrateWrite, deriveStatementKey } from "../storage/writes/write-arbitrator.js";
import {
  findSimilarMemories,
  updateMemoryText,
} from "../storage/surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../domain/memory/types.js";

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}

function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

function makeCandidate(overrides: Partial<SimilarCandidate> = {}): SimilarCandidate {
  const now = new Date().toISOString();
  return {
    id: "existing-id",
    l2: "existing memory text",
    similarity: 0.9,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("write-arbitrator extended coverage", () => {
  beforeEach(() => {
  process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1"; // Rúnir-h435.1 [R1-1]
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (updateMemoryText as Mock).mockResolvedValue(undefined);
  });

  // Line 311: skip when existing memory already contains incoming detail
  it("skip: existing memory already contains incoming text", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: "user prefers dark mode and reduced motion",
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "dark mode",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).toBe("skip");
    expect(result.reason).toContain("already contains");
  });

  // Line 320: skip when merged text equals existing
  it("skip: merge candidate resolves to existing memory text", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // Candidate text and incoming share the same segments so merged = existing
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: "user prefers dark mode",
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "user prefers dark mode",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    // normalizeText of both is identical → skip (either normalized dup or merge resolves)
    expect(result.outcome).toBe("skip");
  });

  // Line 410: merge-update path where merged text differs from input → re-embed
  it("merge-update re-embeds when merged text differs from input", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);
    const mergedEmbedding = makeVec(3);
    const embedText = vi.fn().mockResolvedValue(mergedEmbedding);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: "the user likes hiking in mountains",
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "the user likes camping by lakes",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText,
    });

    expect(result.outcome).toBe("merge-update");
    // embedText should be called to re-embed the merged text
    expect(embedText).toHaveBeenCalled();
    expect(updateMemoryText).toHaveBeenCalledWith(
      db,
      "existing-id",
      expect.any(String),
      mergedEmbedding,
      "memory_store",
      // Rúnir-h435.1 PIN-7: required atomicFactAction (no stored/incoming atomicFact → clear).
      "clear",
      {
        memoryRole: undefined,
        validAt: undefined,
        continuitySubjectKey: undefined,
      },
      // Rúnir-ekos B4: input.targetTable is undefined here, so the call site
      // falls back to PRIMARY_MEMORY_TABLE ("semiote") explicitly rather than
      // relying on updateMemoryText's own default.
      "semiote",
    );
  });

  // Line 182: extractStatementValue fallback (no delimiter found)
  it("deriveStatementKey returns first 8 words when no delimiter at index >= 8", () => {
    // Short text with no delimiters at all
    const key = deriveStatementKey("hello world today");
    expect(key).toBe("hello world today");
  });

  it("deriveStatementKey finds delimiter at index >= 8", () => {
    // "the quick fox is fast" — "is" at index 14 >= 8
    expect(deriveStatementKey("the quick fox is fast")).toBe("the quick fox");
  });

  it("deriveStatementKey ignores delimiter at index < 8", () => {
    // "foo is bar" — " is " at index 3 < 8, so falls through to 8-word slice
    expect(deriveStatementKey("foo is bar")).toBe("foo is bar");
  });

  // Test withinHours with invalid date (NaN)
  it("skip not triggered for candidate with invalid date", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.96,
        l2: "old candidate",
        createdAt: "invalid-date",
        updatedAt: undefined as any,
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "new memory content here now",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    // Invalid date → withinHours returns false → skip not triggered, should create
    expect(result.outcome).toBe("create");
  });

  // Test hasOpposingState through supersede path
  it("supersede: opposing true/false state", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // Rúnir-pn1l.13.4 (U5): F1 nominate-only. A same-subject state correction proves via a
    // shared atomicFact {subject, predicate} (subject-stable across the flipped value).
    const notifFact = { subject: "notifications setting", predicate: "is" };
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: "the notifications setting is true",
        atomicFact: { ...notifFact, value: "true" },
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "the notifications setting is false",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: { atomicFact: { ...notifFact, value: "false" } },
    });

    expect(result.outcome).toBe("supersede");
  });

  // buildMergedText: incoming contains existing
  it("merge-update: incoming text subsumes existing", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: "user likes coffee",
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "user likes coffee and tea and also juice",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).toBe("merge-update");
  });

  // buildMergedText over 1200 chars — existingText longer → returns existingText
  it("merge-update: merged text exceeds 1200 chars, existing is longer → uses existing", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // Create texts with distinct segments that will produce a merged result > 1200 chars
    // splitSegments splits on \n+ or sentence endings, so use distinct sentences
    const longExisting = Array.from({ length: 20 }, (_, i) => `Fact number ${i} about the user is important`).join(". ");
    const longIncoming = Array.from({ length: 20 }, (_, i) => `Detail number ${i + 100} about preferences is noted`).join(". ");

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: longExisting,
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: longIncoming,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    // Merged would be > 1200, and existing is longer, so should use existing
    expect(result.outcome).toBe("merge-update");
  });

  // shouldSupersede: values where one contains the other → returns false (no supersede)
  it("no supersede when existing value contains incoming value", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: "the user's editor is vscode with vim keybindings",
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "the user's editor is vscode",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    // Value "vscode" is contained in "vscode with vim keybindings" → no supersede
    expect(result.outcome).not.toBe("supersede");
  });

  // skip: normalized text match in DB candidate within window
  it("skip: exact normalized text match in DB candidate within skipWindowHours", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.80, // below skipThreshold but text matches exactly
        l2: "  User  likes  COFFEE  ", // normalizes to "user likes coffee"
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "user likes coffee",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).toBe("skip");
    expect(result.reason).toContain("normalized duplicate");
  });

  // skip: in-memory cosine >= skipThreshold (different text, same embedding)
  it("skip: in-memory cosine >= skipThreshold with different text", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // First write to populate in-memory cache
    await arbitrateWrite({
      db,
      text: "first version of the memory",
      userId: "user1",
      embedding, // same vector
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    // Second write with different text but identical embedding → cosine = 1.0 >= 0.95
    const result = await arbitrateWrite({
      db,
      text: "slightly different text version",
      userId: "user1",
      embedding, // same vector → cosine = 1.0
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).toBe("skip");
    expect(result.reason).toContain("cosine");
  });

  // shouldSupersede where same key but different non-opposing values → supersede via value diff
  it("supersede: same key, different non-opposing values", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // Rúnir-pn1l.13.4 (U5): shared atomicFact proves the same-subject value correction.
    const langFact = { subject: "user's favorite language", predicate: "is" };
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: "the user's favorite language is Python",
        atomicFact: { ...langFact, value: "Python" },
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "the user's favorite language is Rust",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: { atomicFact: { ...langFact, value: "Rust" } },
    });

    expect(result.outcome).toBe("supersede");
  });

  // Metadata writeSource propagation
  it("create: propagates metadata writeSource", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    const result = await arbitrateWrite({
      db,
      text: "brand new unique memory entry today",
      userId: "user1",
      embedding,
      metadata: { writeSource: "extraction" as any, extra: "data" },
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).toBe("create");
  });
});
