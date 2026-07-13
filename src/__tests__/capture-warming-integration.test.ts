import { describe, it, expect } from "vitest";
import { selectWarmingCandidates, type WarmingFact } from "../capture/continuity/project-state-warming.js";

describe("capture warming integration", () => {
  it("produces warming candidates from typical capture output", () => {
    const capturedFacts: WarmingFact[] = [
      {
        text: "Implementing incremental capture with watermark for Codex hooks",
        category: "events",
        confidence: 0.88,
        outcome: "create",
        timestamp: new Date().toISOString(),
      },
      {
        text: "SurrealDB supports vector search with KNN index",
        category: "entities",
        confidence: 0.92,
        outcome: "create",
        timestamp: new Date().toISOString(),
      },
    ];

    const result = selectWarmingCandidates(capturedFacts);
    expect(result).not.toBeNull();
    expect(result!.currentFocus).toContain("incremental capture");
    expect(result!.latestProgress).toBeUndefined();
  });

  it("skips warming when all facts are skipped by arbitration", () => {
    const capturedFacts: WarmingFact[] = [
      {
        text: "working on the recall pipeline",
        category: "events",
        confidence: 0.85,
        outcome: "skip",
        timestamp: new Date().toISOString(),
      },
    ];

    const result = selectWarmingCandidates(capturedFacts);
    expect(result).toBeNull();
  });

  it("includes supersede outcomes in warming", () => {
    const capturedFacts: WarmingFact[] = [
      {
        text: "switched from Ollama to Nomic API for cloud embeddings",
        category: "cases",
        confidence: 0.90,
        outcome: "supersede",
        timestamp: new Date().toISOString(),
      },
    ];

    const result = selectWarmingCandidates(capturedFacts);
    expect(result).not.toBeNull();
    expect(result!.currentFocus).toContain("switched from Ollama");
  });

  it("separates focus and progress correctly", () => {
    const capturedFacts: WarmingFact[] = [
      {
        text: "completed the BM25 index migration",
        category: "events",
        confidence: 0.85,
        outcome: "create",
        timestamp: "2026-04-12T09:00:00Z",
      },
      {
        text: "working on the reranker integration",
        category: "events",
        confidence: 0.82,
        outcome: "create",
        timestamp: "2026-04-12T10:00:00Z",
      },
    ];

    const result = selectWarmingCandidates(capturedFacts);
    expect(result).not.toBeNull();
    expect(result!.currentFocus).toContain("reranker integration");
    expect(result!.latestProgress).toContain("BM25 index migration");
  });
});
