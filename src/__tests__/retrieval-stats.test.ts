import { describe, it, expect } from "vitest";
import { RetrievalStatsCollector } from "../recall/selection/retrieval-stats.js";
import type { RetrievalTrace } from "../recall/selection/retrieval-trace.js";

function makeTrace(overrides: Partial<RetrievalTrace> = {}): RetrievalTrace {
  return {
    query: "test",
    mode: "hybrid",
    startedAt: Date.now(),
    stages: [],
    finalCount: 3,
    totalMs: 50,
    ...overrides,
  };
}

describe("RetrievalStatsCollector", () => {
  it("returns zero stats when empty", () => {
    const collector = new RetrievalStatsCollector();
    const stats = collector.getStats();
    expect(stats.totalQueries).toBe(0);
    expect(stats.zeroResultQueries).toBe(0);
    expect(stats.avgLatencyMs).toBe(0);
    expect(stats.p95LatencyMs).toBe(0);
    expect(stats.avgResultCount).toBe(0);
    expect(stats.queriesBySource).toEqual({});
    expect(stats.topDropStages).toEqual([]);
  });

  it("records a single query", () => {
    const collector = new RetrievalStatsCollector();
    collector.recordQuery(makeTrace({ totalMs: 100, finalCount: 5 }), "manual");
    const stats = collector.getStats();
    expect(stats.totalQueries).toBe(1);
    expect(stats.avgLatencyMs).toBe(100);
    expect(stats.avgResultCount).toBe(5);
    expect(stats.queriesBySource).toEqual({ manual: 1 });
  });

  it("counts zero-result queries", () => {
    const collector = new RetrievalStatsCollector();
    collector.recordQuery(makeTrace({ finalCount: 0 }), "auto");
    collector.recordQuery(makeTrace({ finalCount: 3 }), "auto");
    const stats = collector.getStats();
    expect(stats.zeroResultQueries).toBe(1);
  });

  it("computes P95 latency", () => {
    const collector = new RetrievalStatsCollector();
    // Add 20 traces with ascending latency 10, 20, ..., 200
    for (let i = 1; i <= 20; i++) {
      collector.recordQuery(makeTrace({ totalMs: i * 10 }), "test");
    }
    const stats = collector.getStats();
    // P95 index = ceil(20 * 0.95) - 1 = 18, latencies[18] = 190
    expect(stats.p95LatencyMs).toBe(190);
  });

  it("tracks rerank usage", () => {
    const collector = new RetrievalStatsCollector();
    collector.recordQuery(makeTrace({
      stages: [
        { name: "vector_search", inputCount: 0, outputCount: 10, droppedIds: [], scoreRange: null, durationMs: 5 },
        { name: "rerank", inputCount: 10, outputCount: 8, droppedIds: ["a", "b"], scoreRange: [0.5, 0.9], durationMs: 20 },
      ],
    }), "auto");
    const stats = collector.getStats();
    expect(stats.rerankUsed).toBe(1);
  });

  it("tracks noise filter drops", () => {
    const collector = new RetrievalStatsCollector();
    collector.recordQuery(makeTrace({
      stages: [
        { name: "noise_filter", inputCount: 5, outputCount: 3, droppedIds: ["a", "b"], scoreRange: null, durationMs: 1 },
      ],
    }), "auto");
    const stats = collector.getStats();
    expect(stats.noiseFiltered).toBe(1);
  });

  it("computes top drop stages", () => {
    const collector = new RetrievalStatsCollector();
    for (let i = 0; i < 5; i++) {
      collector.recordQuery(makeTrace({
        stages: [
          { name: "threshold_filter", inputCount: 10, outputCount: 3, droppedIds: Array(7).fill("x"), scoreRange: null, durationMs: 1 },
          { name: "rrf_fusion", inputCount: 20, outputCount: 18, droppedIds: ["a", "b"], scoreRange: null, durationMs: 1 },
        ],
      }), "test");
    }
    const stats = collector.getStats();
    expect(stats.topDropStages[0].name).toBe("threshold_filter");
    expect(stats.topDropStages[0].totalDropped).toBe(35); // 7 * 5
    expect(stats.topDropStages[1].name).toBe("rrf_fusion");
    expect(stats.topDropStages[1].totalDropped).toBe(10); // 2 * 5
  });

  it("evicts oldest records when over capacity", () => {
    const collector = new RetrievalStatsCollector(5);
    for (let i = 0; i < 10; i++) {
      collector.recordQuery(makeTrace({ totalMs: (i + 1) * 10 }), "test");
    }
    expect(collector.count).toBe(5);
    const stats = collector.getStats();
    expect(stats.totalQueries).toBe(5);
    // Should only have the last 5 traces (60, 70, 80, 90, 100ms)
    expect(stats.avgLatencyMs).toBe(80); // (60+70+80+90+100)/5
  });

  it("resets all stats", () => {
    const collector = new RetrievalStatsCollector();
    collector.recordQuery(makeTrace(), "test");
    collector.recordQuery(makeTrace(), "test");
    expect(collector.count).toBe(2);
    collector.reset();
    expect(collector.count).toBe(0);
    expect(collector.getStats().totalQueries).toBe(0);
  });

  it("tracks queries by multiple sources", () => {
    const collector = new RetrievalStatsCollector();
    collector.recordQuery(makeTrace(), "manual");
    collector.recordQuery(makeTrace(), "manual");
    collector.recordQuery(makeTrace(), "auto-recall");
    const stats = collector.getStats();
    expect(stats.queriesBySource).toEqual({ manual: 2, "auto-recall": 1 });
  });
});
