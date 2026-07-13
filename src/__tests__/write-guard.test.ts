import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

import { upsertMemory, updateMemoryText } from "../storage/surreal/surreal-store.js";
import { arbitrateWrite } from "../storage/writes/write-arbitrator.js";
import type { RecentWrite } from "../domain/memory/types.js";

function makeMockDb(resultRows: any[][] = [[]]) {
  let callIndex = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const rows = resultRows[callIndex] ?? resultRows[resultRows.length - 1];
      callIndex++;
      return Promise.resolve([rows]);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("write guards — empty text rejection", () => {
  it("upsertMemory throws on empty string", async () => {
    const db = makeMockDb([[]]);
    await expect(
      upsertMemory(db as any, "id", "", "user1", [0.1, 0.2], {}, "user"),
    ).rejects.toThrow("non-empty");
  });

  it("upsertMemory throws on whitespace-only string", async () => {
    const db = makeMockDb([[]]);
    await expect(
      upsertMemory(db as any, "id", "   ", "user1", [0.1, 0.2], {}, "user"),
    ).rejects.toThrow("non-empty");
  });

  it("updateMemoryText throws on empty string", async () => {
    const db = makeMockDb([[]]);
    await expect(
      updateMemoryText(db as any, "mem-id", "", [0.1], "memory_store", "retain"),
    ).rejects.toThrow("non-empty");
  });
});

describe("write-arbitrator empty-text guard", () => {
  it("returns skip outcome for empty-text input", async () => {
    const recentWrites = new Map<string, RecentWrite[]>();
    const result = await arbitrateWrite({
      db: makeMockDb([[]]) as any,
      text: "",
      source: "memory_store" as const,
      userId: "u1",
      embedding: [0.1],
      scope: "user",
      recentWrites,
      embedText: vi.fn().mockResolvedValue([0.1]),
    });
    expect(result.outcome).toBe("skip");
  });
});
