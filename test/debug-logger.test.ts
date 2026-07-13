import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ===========================================================================
// TASK 6: Unit tests for src/debug-logger.ts (no route mocking needed)
// ===========================================================================

import { makeDebugLogger } from "../src/shared/debug-logger.js";

describe("debug-logger unit tests", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enabled=false — calling any method emits nothing", () => {
    const logger = makeDebugLogger(false);
    logger.watermark({ session: "s1", prior: 0, incoming: 5, toProcess: 5 });
    logger.normalize({ session: "s1", count: 3 });
    logger.segmentation({ session: "s1", topics: 2, titles: "A, B" });
    logger.factExtraction({ session: "s1", count: 1, facts: [{ conf: 0.9, text: "hello" }] });
    logger.arbitrationOutcome({ session: "s1", outcome: "create", text: "hello" });
    logger.entityExtraction({ session: "s1", count: 1, names: "Foo" });
    logger.entityOutcome({ session: "s1", name: "Foo", outcome: "create" });
    logger.recallResults({ session: "s1", query: "test", count: 5, topScore: 0.9 });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("enabled=true no sink — watermark() emits a line to console.log starting with '[debug]'", () => {
    const logger = makeDebugLogger(true);
    logger.watermark({ session: "s1", prior: 0, incoming: 5, toProcess: 5 });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0]![0]).toMatch(/^\[debug\]/);
  });

  it("enabled=true no sink — factExtraction() emits line containing 'facts' and truncated text", () => {
    const logger = makeDebugLogger(true);
    logger.factExtraction({
      session: "s1",
      count: 1,
      facts: [{ conf: 0.92, text: "This is a fact about something important" }],
    });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const line = consoleSpy.mock.calls[0]![0] as string;
    expect(line).toContain("facts");
    expect(line).toContain("0.92");
  });

  it("enabled=true with sink — emits to sink not console.log", () => {
    const lines: string[] = [];
    const sink = (line: string) => lines.push(line);
    const logger = makeDebugLogger(true, sink);
    logger.watermark({ session: "s1", prior: 0, incoming: 5, toProcess: 5 });
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[debug\]/);
  });

  it("text fields truncated to 80 chars", () => {
    const longText = "A".repeat(200);
    const lines: string[] = [];
    const logger = makeDebugLogger(true, (line) => lines.push(line));
    logger.arbitrationOutcome({ session: "s1", outcome: "create", text: longText });
    const line = lines[0]!;
    // The text field is formatted as text="<truncated>" — extract that value
    const match = line.match(/text="([^"]*)"/);
    expect(match).toBeTruthy();
    // truncated value should be <= 80 chars
    expect(match![1]!.length).toBeLessThanOrEqual(80);
  });

  it("each method produces a line containing '[debug]'", () => {
    const lines: string[] = [];
    const logger = makeDebugLogger(true, (line) => lines.push(line));
    logger.watermark({ session: "s1", prior: 0, incoming: 5, toProcess: 5 });
    logger.normalize({ session: "s1", count: 3 });
    logger.segmentation({ session: "s1", topics: 2, titles: "A, B" });
    logger.factExtraction({ session: "s1", count: 1, facts: [{ conf: 0.9, text: "hello" }] });
    logger.arbitrationOutcome({ session: "s1", outcome: "create", text: "hello" });
    logger.entityExtraction({ session: "s1", count: 1, names: "Foo" });
    logger.entityOutcome({ session: "s1", name: "Foo", outcome: "create" });
    logger.recallResults({ session: "s1", query: "test", count: 5, topScore: 0.9 });
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(line).toContain("[debug]");
    }
  });
});
