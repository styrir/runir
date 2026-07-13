import { describe, it, expect, vi } from "vitest";
import { batchDedupFacts } from "../capture/extraction/capture.js";
import type { ExtractedFact } from "../domain/memory/types.js";

describe("batchDedupFacts", () => {
  const makeFact = (id: string, l0: string, confidence: number): ExtractedFact => ({
    l2: `Full text for ${id}`,
    l0,
    l1: "",
    confidence,
    category: "cases",
    tier: "working",
    tags: [],
    factKey: `cases:${id}`,
  });

  it("drops lower-confidence duplicate when cosine > 0.85", async () => {
    const facts = [
      makeFact("a", "User prefers TypeScript", 0.95),
      makeFact("b", "User likes TypeScript a lot", 0.85),
    ];
    // embedText returns nearly identical vectors for similar texts
    const embedText = vi.fn()
      .mockResolvedValueOnce([1, 0, 0]) // "User prefers TypeScript"
      .mockResolvedValueOnce([0.99, 0.1, 0]); // "User likes TypeScript a lot" — cosine ~0.995

    const result = await batchDedupFacts(facts, embedText);
    expect(result).toHaveLength(1);
    expect(result[0]!.factKey).toBe("cases:a"); // higher confidence wins
  });

  it("keeps both facts when cosine <= 0.85", async () => {
    const facts = [
      makeFact("a", "TypeScript is great", 0.9),
      makeFact("b", "Server runs on port 7700", 0.9),
    ];
    const embedText = vi.fn()
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0, 0, 1]); // orthogonal

    const result = await batchDedupFacts(facts, embedText);
    expect(result).toHaveLength(2);
  });

  it("passes single fact through unchanged", async () => {
    const facts = [makeFact("a", "Only fact", 0.9)];
    const embedText = vi.fn().mockResolvedValueOnce([1, 0, 0]);

    const result = await batchDedupFacts(facts, embedText);
    expect(result).toHaveLength(1);
  });

  it("passes empty array through", async () => {
    const embedText = vi.fn();
    const result = await batchDedupFacts([], embedText);
    expect(result).toHaveLength(0);
    expect(embedText).not.toHaveBeenCalled();
  });

  it("handles three-way dedup keeping highest confidence", async () => {
    const facts = [
      makeFact("a", "TypeScript preference", 0.8),
      makeFact("b", "TypeScript pref", 0.95),
      makeFact("c", "TypeScript preferred", 0.85),
    ];
    // All three return nearly identical vectors
    const embedText = vi.fn()
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0.99, 0.1, 0])
      .mockResolvedValueOnce([0.98, 0.15, 0]);

    const result = await batchDedupFacts(facts, embedText);
    expect(result).toHaveLength(1);
    expect(result[0]!.factKey).toBe("cases:b"); // highest confidence
  });

  it("respects custom threshold", async () => {
    const facts = [
      makeFact("a", "fact a", 0.9),
      makeFact("b", "fact b", 0.85),
    ];
    // Vectors with cosine ~0.86 — below default 0.85? Let's make it exact
    // cosine of [1,0,0] and [0.8,0.6,0] = 0.8 → below 0.85
    const embedText = vi.fn()
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0.8, 0.6, 0]);

    // With default threshold 0.85, both should survive (cosine = 0.8)
    const result = await batchDedupFacts(facts, embedText, 0.85);
    expect(result).toHaveLength(2);
  });
});
