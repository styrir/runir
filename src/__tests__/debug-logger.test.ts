import { describe, it, expect, vi } from "vitest";
import { makeDebugLogger } from "../shared/debug-logger.js";

describe("makeDebugLogger", () => {
  it("returns noop logger when disabled", () => {
    const logger = makeDebugLogger(false);
    // Should not throw
    logger.watermark({ session: "s", prior: 0, incoming: 5, toProcess: 5 });
    logger.normalize({ session: "s", count: 3 });
    logger.recallResults({ session: "s", query: "test", count: 1, topScore: 0.9 });
  });

  it("emits to custom sink when enabled", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);

    logger.watermark({ session: "s1", prior: 0, incoming: 10, toProcess: 10 });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("[debug]"));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("watermark"));
  });

  it("emits normalize log", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.normalize({ session: "s1", count: 5 });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("normalize"));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("count=5"));
  });

  it("emits segmentation log", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.segmentation({ session: "s1", topics: 3, titles: "a, b, c" });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("segmentation"));
  });

  it("emits factExtraction with up to 3 facts", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.factExtraction({
      session: "s1",
      count: 2,
      facts: [
        { conf: 0.95, text: "User likes TypeScript" },
        { conf: 0.80, text: "User prefers dark mode" },
      ],
    });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("facts"));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("0.95"));
  });

  it("emits arbitrationOutcome log", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.arbitrationOutcome({ session: "s1", outcome: "create", text: "some memory" });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("arbitration"));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("create"));
  });

  it("emits entityExtraction log", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.entityExtraction({ session: "s1", count: 2, names: "Alice, Bob" });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("entities"));
  });

  it("emits entityOutcome without error", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.entityOutcome({ session: "s1", name: "Alice", outcome: "create" });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("entity"));
    expect(sink).toHaveBeenCalledWith(expect.not.stringContaining("err="));
  });

  it("emits entityOutcome WITH error branch", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.entityOutcome({ session: "s1", name: "Bob", outcome: "error", err: "DB timeout" });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("err="));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("DB timeout"));
  });

  it("emits recallResults log", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.recallResults({ session: "s1", query: "test query", count: 3, topScore: 0.88 });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("recall"));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("top=0.88"));
  });

  it("emits retrievalTrace log", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.retrievalTrace({ session: "s1", summary: "vec=5 bm25=3" });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("trace"));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("vec=5 bm25=3"));
  });

  it("truncates long strings in output", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    const longQuery = "x".repeat(200);
    logger.recallResults({ session: "s1", query: longQuery, count: 1, topScore: 0.5 });
    const output = sink.mock.calls[0][0] as string;
    // Should be truncated to 80 chars, not contain full 200-char string
    expect(output).not.toContain("x".repeat(200));
    expect(output).toContain("x".repeat(80));
  });

  it("emits salience log", () => {
    const sink = vi.fn();
    const logger = makeDebugLogger(true, sink);
    logger.salience({ session: "s1", score: 0.42, hardOverride: true, reason: "commit hash detected" });
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("salience"));
    expect(sink).toHaveBeenCalledWith(expect.stringContaining("score=0.42"));
  });
});
