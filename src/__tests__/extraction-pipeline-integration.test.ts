import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mock dag-guard before importing write-arbitrator
// ---------------------------------------------------------------------------
vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

// ---------------------------------------------------------------------------
// Mock surreal-store for DB calls
// vi.mock factory must not reference variables outside since it's hoisted
// ---------------------------------------------------------------------------
vi.mock("../storage/surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class {
    query = vi.fn().mockResolvedValue([[]]);
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { extractMemories } from "../capture/extraction/capture.js";
import { arbitrateWrite } from "../storage/writes/write-arbitrator.js";
import {
  findSimilarMemories,
  updateMemoryText,
  upsertMemory,
  supersedeMemory,
} from "../storage/surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../domain/memory/types.js";
import { CONFIDENCE_THRESHOLD } from "../domain/memory/types.js";

// ---------------------------------------------------------------------------
// Mock fetch for OpenRouter API calls (after imports)
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}

function makeEmbedding(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

function makeOpenRouterResponse(facts: Array<{ l2: string; confidence: number }>) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({ facts }),
          },
        },
      ],
    }),
  };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("extraction pipeline integration (MIM-53)", () => {
  beforeEach(() => {
  process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1"; // Rúnir-h435.1 [R1-1]
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (updateMemoryText as Mock).mockResolvedValue(undefined);
    (upsertMemory as Mock).mockResolvedValue("new-id");
    (supersedeMemory as Mock).mockResolvedValue(undefined);
  });

  it("fact goes through create path end-to-end", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeEmbedding(0);
    const embedText = vi.fn().mockResolvedValue(embedding);

    // Mock extractMemories to return a fact
    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        { l2: "user prefers dark mode for all applications", confidence: 0.9 },
      ])
    );

    const facts = await extractMemories(
      [{ role: "user", content: "I always use dark mode" }],
      "test prompt",
      "test-api-key"
    );

    expect(facts.length).toBe(1);
    expect(facts[0]!.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);

    // Pass fact through arbitrateWrite
    const result = await arbitrateWrite({
      db,
      text: facts[0]!.l2,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText,
    });

    expect(result.outcome).toBe("create");
    expect(upsertMemory).toHaveBeenCalled();
  });

  it("fact merges with existing when written twice with same recentWrites map", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeEmbedding(0);
    const embedText = vi.fn().mockResolvedValue(embedding);

    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        { l2: "user prefers TypeScript", confidence: 0.95 },
      ])
    );

    const facts = await extractMemories(
      [{ role: "user", content: "I prefer TypeScript" }],
      "test prompt",
      "test-api-key"
    );

    // First write
    const result1 = await arbitrateWrite({
      db,
      text: facts[0]!.l2,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText,
    });
    expect(result1.outcome).toBe("create");

    // Second write with same text — should skip via in-memory cache
    const result2 = await arbitrateWrite({
      db,
      text: facts[0]!.l2,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites, // Same map
      embedText,
    });
    expect(result2.outcome).toBe("skip");
    expect(result2.reason).toContain("in-memory");
  });

  it("fact supersedes conflicting memory", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeEmbedding(0);
    const embedText = vi.fn().mockResolvedValue(embedding);

    // First, write "feature X is enabled"
    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        { l2: "feature X is enabled", confidence: 0.9 },
      ])
    );

    const facts1 = await extractMemories(
      [{ role: "user", content: "Enable feature X" }],
      "test prompt",
      "test-api-key"
    );

    await arbitrateWrite({
      db,
      text: facts1[0]!.l2,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText,
    });

    // Clear recentWrites to simulate fresh session
    recentWrites.clear();

    // Mock DB to return the existing "enabled" memory. Rúnir-pn1l.13.4 (U5): F1 is
    // nominate-only — the state correction proves referent identity via a shared atomicFact
    // {subject, predicate} (subject-stable across enabled/disabled).
    const featureXFact = { subject: "feature X", predicate: "is" };
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.88,
        l2: "feature X is enabled",
        atomicFact: { ...featureXFact, value: "enabled" },
      }),
    ]);

    // Now write "feature X is disabled"
    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        { l2: "feature X is disabled", confidence: 0.9 },
      ])
    );

    const facts2 = await extractMemories(
      [{ role: "user", content: "Disable feature X" }],
      "test prompt",
      "test-api-key"
    );

    const result = await arbitrateWrite({
      db,
      text: facts2[0]!.l2,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText,
      metadata: { atomicFact: { ...featureXFact, value: "disabled" } },
    });

    expect(result.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("fact rejected by confidence gate < 0.7", async () => {
    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        { l2: "maybe the user likes Python", confidence: 0.5 }, // Below threshold
      ])
    );

    const facts = await extractMemories(
      [{ role: "user", content: "I might use Python" }],
      "test prompt",
      "test-api-key"
    );

    // Fact should be filtered out by extractMemories due to low confidence
    expect(facts.length).toBe(0);
    expect(upsertMemory).not.toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled();
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("multiple facts processed through pipeline", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();

    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        { l2: "user is a senior engineer", confidence: 0.95 },
        { l2: "user works at Acme Corp", confidence: 0.92 },
        { l2: "user prefers VS Code", confidence: 0.88 },
      ])
    );

    const facts = await extractMemories(
      [{ role: "user", content: "I'm a senior engineer at Acme using VS Code" }],
      "test prompt",
      "test-api-key"
    );

    expect(facts.length).toBe(3);

    // Process each fact with DIFFERENT embeddings to avoid in-memory dedup
    const results = [];
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i]!;
      const embedding = makeEmbedding(i); // Each fact gets a different embedding
      const embedText = vi.fn().mockResolvedValue(embedding);
      const result = await arbitrateWrite({
        db,
        text: fact.l2,
        userId: "user1",
        embedding,
        scope: "user",
        source: "memory_store",
        recentWrites,
        embedText,
      });
      results.push(result);
    }

    // All should create (different texts, different embeddings)
    expect(results.filter((r) => r.outcome === "create").length).toBe(3);
  });
});
