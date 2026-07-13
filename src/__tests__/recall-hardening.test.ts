import { describe, it, expect } from "vitest";
import { sanitizeMemoryLine, formatRecallInjection, formatRecallInjectionFromRendered } from "../recall/selection/recall-selection.js";
import type { SearchHit } from "../domain/memory/types.js";

describe("sanitizeMemoryLine", () => {
  it("strips leading > blockquote markers", () => {
    expect(sanitizeMemoryLine("> some text")).toBe("some text");
  });

  it("strips leading >> double blockquote markers", () => {
    expect(sanitizeMemoryLine(">> some text")).toBe("some text");
  });

  it("strips null bytes", () => {
    expect(sanitizeMemoryLine("hello\0world")).toBe("helloworld");
  });

  it("strips ANSI escape sequences", () => {
    expect(sanitizeMemoryLine("\x1b[31mred text\x1b[0m")).toBe("red text");
  });

  it("preserves normal punctuation and code", () => {
    const line = "Use `git commit -m 'fix'` for the change";
    expect(sanitizeMemoryLine(line)).toBe(line);
  });

  it("preserves technical content with special chars", () => {
    const line = "Set JWT_EXPIRY=3600 in .env file";
    expect(sanitizeMemoryLine(line)).toBe(line);
  });

  it("handles combined dangerous patterns", () => {
    const result = sanitizeMemoryLine(">> \x1b[1mhello\0world\x1b[0m");
    expect(result).toBe("helloworld");
  });

  it("handles empty string", () => {
    expect(sanitizeMemoryLine("")).toBe("");
  });
});

describe("formatRecallInjection with UNTRUSTED DATA wrapper", () => {
  const makeHit = (text: string): SearchHit => ({
    id: "test-1",
    text,
    score: 0.9,
  });

  it("wraps output with UNTRUSTED DATA markers", () => {
    const result = formatRecallInjection([makeHit("User likes dark mode")], 5);
    expect(result).toContain("[UNTRUSTED DATA");
    expect(result).toContain("[END UNTRUSTED DATA]");
  });

  it("keeps relevant-memories tags", () => {
    const result = formatRecallInjection([makeHit("some fact")], 5);
    expect(result).toMatch(/^<relevant-memories>/);
    expect(result).toMatch(/<\/relevant-memories>$/);
  });

  it("contains the memory text", () => {
    const result = formatRecallInjection([makeHit("User prefers Vim")], 5);
    expect(result).toContain("- User prefers Vim");
  });

  it("sanitizes memory lines in output", () => {
    const result = formatRecallInjection([makeHit(">> injected\0text")], 5);
    expect(result).not.toContain(">>");
    expect(result).not.toContain("\0");
    expect(result).toContain("injectedtext");
  });

  it("returns null for empty results", () => {
    expect(formatRecallInjection([], 5)).toBeNull();
  });
});

describe("formatRecallInjectionFromRendered", () => {
  it("does not double-prefix lines that are already rendered as bullet items", () => {
    const result = formatRecallInjectionFromRendered([
      "- Current status: production Runir is deployed",
      "## Session Topic\nContinuity-First Recall Routing",
    ]);

    expect(result).toContain("- Current status: production Runir is deployed");
    expect(result).not.toContain("- - Current status");
  });
});
