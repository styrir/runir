import { describe, it, expect } from "vitest";
import { buildClusters, buildMergedEntry } from "../lifecycle/compaction/memory-compactor.js";

describe("buildClusters", () => {
  it("groups entries with cosine >= threshold into a cluster", () => {
    // Two very similar embeddings
    const entries = [
      { id: "a", text: "User prefers TypeScript", embedding: [1, 0, 0], confidence: 0.9, category: "preferences" as const, tags: ["typescript"] },
      { id: "b", text: "User likes TypeScript", embedding: [0.99, 0.1, 0], confidence: 0.85, category: "preferences" as const, tags: ["typescript"] },
      { id: "c", text: "Server runs on port 7700", embedding: [0, 0, 1], confidence: 0.9, category: "cases" as const, tags: ["server"] },
    ];
    const clusters = buildClusters(entries, 0.88, 2);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    // The first cluster should contain a and b (similar), not c
    const firstCluster = clusters[0];
    const ids = firstCluster.map((e: any) => e.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("c");
  });

  it("returns empty when no pairs exceed threshold", () => {
    const entries = [
      { id: "a", text: "TypeScript", embedding: [1, 0, 0], confidence: 0.9, category: "preferences" as const, tags: [] },
      { id: "b", text: "Port 7700", embedding: [0, 0, 1], confidence: 0.9, category: "cases" as const, tags: [] },
    ];
    const clusters = buildClusters(entries, 0.88, 2);
    expect(clusters).toHaveLength(0);
  });

  it("respects minClusterSize", () => {
    const entries = [
      { id: "a", text: "text a", embedding: [1, 0, 0], confidence: 0.9, category: "preferences" as const, tags: [] },
      { id: "b", text: "text b", embedding: [0.99, 0.1, 0], confidence: 0.85, category: "preferences" as const, tags: [] },
    ];
    // minClusterSize=3 means a pair of 2 doesn't qualify
    const clusters = buildClusters(entries, 0.88, 3);
    expect(clusters).toHaveLength(0);
  });
});

describe("buildMergedEntry", () => {
  it("deduplicates lines and takes max confidence", () => {
    const members = [
      { id: "a", text: "Line one.\nLine two.", embedding: [1, 0], confidence: 0.9, category: "preferences" as const, tags: ["tag1"] },
      { id: "b", text: "Line two.\nLine three.", embedding: [1, 0], confidence: 0.95, category: "preferences" as const, tags: ["tag2"] },
    ];
    const merged = buildMergedEntry(members);
    expect(merged.confidence).toBe(0.95);
    expect(merged.text).toContain("Line one.");
    expect(merged.text).toContain("Line two.");
    expect(merged.text).toContain("Line three.");
    // Line two should not be duplicated
    const lineCount = merged.text.split("\n").filter((l: string) => l.includes("Line two.")).length;
    expect(lineCount).toBe(1);
  });

  it("uses plurality category", () => {
    const members = [
      { id: "a", text: "a", embedding: [1], confidence: 0.9, category: "preferences" as const, tags: [] },
      { id: "b", text: "b", embedding: [1], confidence: 0.9, category: "preferences" as const, tags: [] },
      { id: "c", text: "c", embedding: [1], confidence: 0.9, category: "profile" as const, tags: [] },
    ];
    const merged = buildMergedEntry(members);
    expect(merged.category).toBe("preferences");
  });

  it("unions tags with dedup", () => {
    const members = [
      { id: "a", text: "a", embedding: [1], confidence: 0.9, category: "preferences" as const, tags: ["ts", "go"] },
      { id: "b", text: "b", embedding: [1], confidence: 0.9, category: "preferences" as const, tags: ["go", "rust"] },
    ];
    const merged = buildMergedEntry(members);
    expect(merged.tags).toEqual(expect.arrayContaining(["ts", "go", "rust"]));
    expect(merged.tags.filter((t: string) => t === "go")).toHaveLength(1);
  });
});
