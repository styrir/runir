import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("created-id"),
}));

import { findSimilarMemories, updateMemoryText, upsertMemory } from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";
import { arbitrateWrite } from "../write-arbitrator.js";

function makeCandidate(l2: string): SimilarCandidate {
  return {
    id: "existing-id",
    l2,
    similarity: 0.99,
    createdAt: new Date().toISOString(),
  };
}

describe("write arbitration exact-QA distinct answers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (upsertMemory as Mock).mockResolvedValue("created-id");
  });

  it("creates a separate memory for answer-distinct exact facts instead of skipping on high cosine", async () => {
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate("Alice birthday is 1990-01-02."),
    ]);
    const recentWrites = new Map<string, RecentWrite[]>();

    const result = await arbitrateWrite({
      db: { query: vi.fn().mockResolvedValue([[]]) } as any,
      text: "Bob birthday is 1991-03-04.",
      userId: "u1",
      embedding: [1, 0, 0],
      metadata: { factKey: "cases:bob-birthday", continuitySubjectKey: "person:bob-birthday" },
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue([1, 0, 0]),
    });

    expect(result.outcome).toBe("create");
    expect(upsertMemory).toHaveBeenCalledTimes(1);
    expect(updateMemoryText).not.toHaveBeenCalled();
  });

  it("still skips a same exact answer duplicate", async () => {
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate("Alice birthday is 1990-01-02."),
    ]);

    const result = await arbitrateWrite({
      db: { query: vi.fn().mockResolvedValue([[]]) } as any,
      text: "Alice birthday is 1990-01-02.",
      userId: "u1",
      embedding: [1, 0, 0],
      scope: "user",
      source: "memory_store",
      recentWrites: new Map<string, RecentWrite[]>(),
      embedText: vi.fn().mockResolvedValue([1, 0, 0]),
    });

    expect(result.outcome).toBe("skip");
  });
});
