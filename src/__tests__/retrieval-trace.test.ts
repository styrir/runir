import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TraceCollector } from "../recall/selection/retrieval-trace.js";
import type { RetrievalTrace, RetrievalStageResult } from "../recall/selection/retrieval-trace.js";

describe("TraceCollector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a trace with no stages", () => {
    const tc = new TraceCollector();
    const trace = tc.finalize("test query", "hybrid");
    expect(trace.query).toBe("test query");
    expect(trace.mode).toBe("hybrid");
    expect(trace.stages).toHaveLength(0);
    expect(trace.finalCount).toBe(0);
  });

  it("tracks a single stage with start/end", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", []);
    vi.advanceTimersByTime(10);
    tc.endStage(["id1", "id2"]);

    const trace = tc.finalize("q", "hybrid");
    expect(trace.stages).toHaveLength(1);
    expect(trace.stages[0].name).toBe("vector_search");
    expect(trace.stages[0].inputCount).toBe(0);
    expect(trace.stages[0].outputCount).toBe(2);
    expect(trace.stages[0].durationMs).toBe(10);
  });

  it("tracks dropped IDs", () => {
    const tc = new TraceCollector();
    tc.startStage("threshold_filter", ["a", "b", "c"]);
    tc.endStage(["a"]); // b and c dropped

    const stage = tc.stages[0];
    expect(stage.droppedIds).toEqual(["b", "c"]);
    expect(stage.inputCount).toBe(3);
    expect(stage.outputCount).toBe(1);
  });

  it("computes score range", () => {
    const tc = new TraceCollector();
    tc.startStage("reranker", ["a", "b", "c"]);
    tc.endStage(["a", "b", "c"], [0.9, 0.5, 0.75]);

    const stage = tc.stages[0];
    expect(stage.scoreRange).toEqual([0.5, 0.9]);
  });

  it("returns null scoreRange when no scores provided", () => {
    const tc = new TraceCollector();
    tc.startStage("rrf_fusion", ["a"]);
    tc.endStage(["a"]);

    expect(tc.stages[0].scoreRange).toBeNull();
  });

  it("auto-closes unclosed stage on startStage", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", ["a", "b"]);
    // Start new stage without ending previous
    tc.startStage("bm25_search", ["c"]);
    tc.endStage(["c"]);

    const trace = tc.finalize("q", "hybrid");
    expect(trace.stages).toHaveLength(2);
    expect(trace.stages[0].name).toBe("vector_search");
    expect(trace.stages[0].outputCount).toBe(2); // auto-closed with all input IDs
    expect(trace.stages[1].name).toBe("bm25_search");
  });

  it("auto-closes unclosed stage on finalize", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", ["a"]);
    // Don't end it — finalize should auto-close

    const trace = tc.finalize("q", "vector");
    expect(trace.stages).toHaveLength(1);
    expect(trace.stages[0].outputCount).toBe(1);
  });

  it("tracks multiple stages in pipeline order", () => {
    const tc = new TraceCollector();

    tc.startStage("vector_search", []);
    vi.advanceTimersByTime(5);
    tc.endStage(["a", "b", "c"]);

    tc.startStage("bm25_search", []);
    vi.advanceTimersByTime(3);
    tc.endStage(["b", "d"]);

    tc.startStage("rrf_fusion", ["a", "b", "c", "d"]);
    vi.advanceTimersByTime(1);
    tc.endStage(["a", "b", "c"], [0.9, 0.8, 0.7]);

    tc.startStage("threshold_filter", ["a", "b", "c"]);
    tc.endStage(["a", "b"], [0.9, 0.8]);

    const trace = tc.finalize("q", "hybrid");
    expect(trace.stages).toHaveLength(4);
    expect(trace.stages.map(s => s.name)).toEqual([
      "vector_search", "bm25_search", "rrf_fusion", "threshold_filter",
    ]);
    expect(trace.finalCount).toBe(2);
  });

  it("computes totalMs from start to finalize", () => {
    const tc = new TraceCollector();
    vi.advanceTimersByTime(100);
    const trace = tc.finalize("q", "hybrid");
    expect(trace.totalMs).toBe(100);
  });

  it("records startedAt as epoch ms", () => {
    const tc = new TraceCollector();
    const trace = tc.finalize("q", "hybrid");
    expect(trace.startedAt).toBe(new Date("2026-03-28T12:00:00Z").getTime());
  });

  it("endStage is a no-op when no stage is pending", () => {
    const tc = new TraceCollector();
    tc.endStage(["a"]); // no-op, shouldn't throw
    expect(tc.stages).toHaveLength(0);
  });

  it("summarize produces human-readable output", () => {
    const tc = new TraceCollector();
    tc.startStage("vector_search", []);
    tc.endStage(["a", "b"]);
    tc.startStage("threshold_filter", ["a", "b"]);
    tc.endStage(["a"], [0.9]);

    const summary = tc.summarize();
    expect(summary).toContain("vector_search");
    expect(summary).toContain("threshold_filter");
    expect(summary).toContain("dropped: b");
  });
});
