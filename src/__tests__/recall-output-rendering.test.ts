/**
 * MIM-49: Recall output rendering pipeline tests.
 * Tests formatRecallInjection depth rendering, topK slicing, and scope-predicate governance filtering.
 */
import { describe, it, expect } from "vitest";
import { formatRecallInjection, toToolSearchResults } from "../recall/selection/recall-selection.js";
import { resolveScopeFilter } from "../recall/query/scope-predicate.js";
import type { SearchHit } from "../domain/memory/types.js";

function makeHit(text: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return { id: "test-id", text, score: 0.9, ...overrides };
}

// ---------------------------------------------------------------------------
// L0 depth rendering (title-only strings)
// ---------------------------------------------------------------------------
describe("L0 depth rendering", () => {
  it("single short title: appears with '- ' prefix in injection", () => {
    const result = formatRecallInjection([makeHit("User prefers Vim")], 5);
    expect(result).toContain("- User prefers Vim");
  });

  it("multiple L0 titles: each appears prefixed", () => {
    const hits = [makeHit("User prefers Vim"), makeHit("User uses TypeScript")];
    const result = formatRecallInjection(hits, 5);
    expect(result).toContain("- User prefers Vim");
    expect(result).toContain("- User uses TypeScript");
  });

  it("L0 title does not have extra newlines within the '- ' item line", () => {
    const result = formatRecallInjection([makeHit("Short fact")], 5);
    // The text of the hit should appear exactly once, on a single line
    expect(result).toContain("- Short fact");
    expect(result).not.toContain("- Short fact\n\n");
  });
});

// ---------------------------------------------------------------------------
// L1 depth rendering (title + first sentence)
// ---------------------------------------------------------------------------
describe("L1 depth rendering", () => {
  it("title plus first sentence: both present in injection", () => {
    const text = "User prefers dark mode. This applies to all editors and terminals.";
    const result = formatRecallInjection([makeHit(text, { l0: "Dark mode preference" })], 5, "l1");
    expect(result).toContain("Dark mode preference");
    expect(result).toContain("User prefers dark mode.");
  });

  it("uses stored l0 instead of recomputing from l2 when provided", () => {
    const text = "The memories table uses payload.l2 for full text. Additional details follow.";
    const result = formatRecallInjection([makeHit(text, { l0: "Current schema summary" })], 5, "l1");
    expect(result).toContain("Current schema summary");
    expect(result).toContain("The memories table uses payload.l2 for full text.");
  });

  it("sentence boundary preserved in output", () => {
    const text = "Server runs on port 7700. It uses SurrealDB as backend.";
    const result = formatRecallInjection([makeHit(text, { l0: "Runir server config" })], 5, "l1");
    expect(result).toContain("Runir server config");
    expect(result).toContain("Server runs on port 7700.");
  });
});

// ---------------------------------------------------------------------------
// L2 / full depth rendering (complete memory text)
// ---------------------------------------------------------------------------
describe("L2/full depth rendering", () => {
  it("multi-sentence memory: entire text present", () => {
    const text = "User works on the Runir project. It is a memory service. It uses SurrealDB. Deployed on Ubuntu 22.04.";
    const result = formatRecallInjection([makeHit(text)], 5);
    expect(result).toContain("User works on the Runir project.");
    expect(result).toContain("It is a memory service.");
    expect(result).toContain("Deployed on Ubuntu 22.04.");
  });

  it("long multiline text: preserved fully", () => {
    const text = "Line one.\nLine two.\nLine three.";
    const result = formatRecallInjection([makeHit(text)], 5);
    expect(result).toContain("Line one.");
    expect(result).toContain("Line two.");
    expect(result).toContain("Line three.");
  });
});

// ---------------------------------------------------------------------------
// prependContext / wrapper format
// ---------------------------------------------------------------------------
describe("prependContext string format", () => {
  it("starts with <relevant-memories>", () => {
    const result = formatRecallInjection([makeHit("some fact")], 5);
    expect(result).toMatch(/^<relevant-memories>/);
  });

  it("ends with </relevant-memories>", () => {
    const result = formatRecallInjection([makeHit("some fact")], 5);
    expect(result).toMatch(/<\/relevant-memories>$/);
  });

  it("contains [UNTRUSTED DATA] warning", () => {
    const result = formatRecallInjection([makeHit("some fact")], 5);
    expect(result).toContain("[UNTRUSTED DATA");
  });

  it("contains [END UNTRUSTED DATA] closing marker", () => {
    const result = formatRecallInjection([makeHit("some fact")], 5);
    expect(result).toContain("[END UNTRUSTED DATA]");
  });

  it("returns null for empty results (no wrapper produced)", () => {
    expect(formatRecallInjection([], 5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// topK slicing
// ---------------------------------------------------------------------------
describe("topK slicing", () => {
  it("topK=3 with 10 results: exactly 3 memory lines in output", () => {
    const hits = Array.from({ length: 10 }, (_, i) => makeHit(`Memory item ${i}`));
    const result = formatRecallInjection(hits, 3)!;
    // Count "- Memory item" occurrences
    const count = (result.match(/^- Memory item/gm) ?? []).length;
    expect(count).toBe(3);
  });

  it("topK=1: only first result included", () => {
    const hits = [makeHit("First"), makeHit("Second"), makeHit("Third")];
    const result = formatRecallInjection(hits, 1)!;
    expect(result).toContain("- First");
    expect(result).not.toContain("- Second");
    expect(result).not.toContain("- Third");
  });

  it("topK larger than results: all results included", () => {
    const hits = [makeHit("A"), makeHit("B")];
    const result = formatRecallInjection(hits, 100)!;
    expect(result).toContain("- A");
    expect(result).toContain("- B");
  });
});

// ---------------------------------------------------------------------------
// Scope predicate WHERE-clause generation
// ---------------------------------------------------------------------------
describe("scope predicate WHERE-clause generation", () => {
  it("scope='session' with sessionId: generated WHERE clause enforces session isolation", () => {
    const sf = resolveScopeFilter("session", "sess-abc");
    expect(sf.whereClause).toContain("session_id");
    // Must NOT widen to user scope
    expect(sf.whereClause).not.toContain("scope = NONE");
    expect(sf.vars.sessionId).toBe("sess-abc");
  });

  it("scope='session' without sessionId: generated WHERE clause is deny-all", () => {
    const sf = resolveScopeFilter("session", undefined);
    expect(sf.whereClause).toContain("false");
    // Must not be empty string (which would be allow-all)
    expect(sf.whereClause).not.toBe("");
  });

  it("scope='user': generated WHERE clause includes legacy (scope=NONE) records", () => {
    const sf = resolveScopeFilter("user", "sess-xyz");
    expect(sf.whereClause).toContain("scope = NONE");
    expect(sf.whereClause).toContain("scope = $scopeVal");
  });

  it("scope='user': generated WHERE clause does NOT include session-scoped memories", () => {
    const sf = resolveScopeFilter("user", "sess-xyz");
    // Session memories must be excluded
    expect(sf.whereClause).not.toMatch(/scope = .session/);
    expect(sf.whereClause).not.toContain("session_id");
  });

  it("scope='all': generated WHERE clause is empty (no filtering — admin bypass)", () => {
    const sf = resolveScopeFilter("all", "sess-xyz");
    expect(sf.whereClause).toBe("");
  });

  it("unknown scope 'custom-scope': generated WHERE clause falls back to default retrieval", () => {
    const sf = resolveScopeFilter("custom-scope", "sess-123");
    expect(sf.whereClause).not.toBe("");
    expect(sf.whereClause).toContain("scope = NONE");
  });
});

// ---------------------------------------------------------------------------
// Sanitization in pipeline
// ---------------------------------------------------------------------------
describe("sanitization in recall pipeline", () => {
  it("null bytes in text are stripped before injection", () => {
    const result = formatRecallInjection([makeHit("hello\0world")], 5)!;
    expect(result).not.toContain("\0");
    expect(result).toContain("helloworld");
  });

  it("ANSI escape codes stripped", () => {
    const result = formatRecallInjection([makeHit("\x1b[31mred text\x1b[0m")], 5)!;
    expect(result).not.toContain("\x1b[");
    expect(result).toContain("red text");
  });

  it("blockquote markers stripped", () => {
    const result = formatRecallInjection([makeHit(">> injected content")], 5)!;
    expect(result).not.toContain(">>");
    expect(result).toContain("injected content");
  });
});

// ---------------------------------------------------------------------------
// Empty-text filtering (Rúnir-77j/91h)
// ---------------------------------------------------------------------------
describe("empty-text filtering", () => {
  it('formatRecallInjection excludes results with empty text', () => {
    const results: SearchHit[] = [
      { id: '1', text: 'real memory content', score: 0.9, createdAt: undefined, updatedAt: undefined },
      { id: '2', text: '', score: 0.85, createdAt: undefined, updatedAt: undefined },
      { id: '3', text: '   ', score: 0.8, createdAt: undefined, updatedAt: undefined },
      { id: '4', text: 'another real memory', score: 0.7, createdAt: undefined, updatedAt: undefined },
    ];
    const result = formatRecallInjection(results, 5);
    expect(result).not.toBeNull();
    expect(result).toContain('real memory content');
    expect(result).toContain('another real memory');
    // Empty-text results must not produce empty bullet lines
    expect(result).not.toMatch(/^- $/m);
    expect(result).not.toMatch(/^- \s*$/m);
  });

  it('formatRecallInjection excludes results with text: undefined', () => {
    const results: SearchHit[] = [
      { id: '1', text: 'real memory content', score: 0.9 },
      { id: '2', text: undefined as unknown as string, score: 0.85 },
      { id: '3', text: 'another real memory', score: 0.7 },
    ];
    const result = formatRecallInjection(results, 5);
    expect(result).not.toBeNull();
    expect(result).toContain('real memory content');
    expect(result).toContain('another real memory');
    // The undefined-text result must not produce an empty bullet line
    expect(result).not.toMatch(/^- $/m);
    expect(result).not.toMatch(/^- \s*$/m);
  });
});

// ---------------------------------------------------------------------------
// MIM-69 Task 10: formatRecallInjection with depth parameter
// ---------------------------------------------------------------------------
describe("formatRecallInjection depth-aware rendering (MIM-69)", () => {
  it("depth='l0' produces only first-sentence bullets", () => {
    const hit = makeHit("First sentence here. Second sentence with more detail.", { id: "l0-test" });
    const result = formatRecallInjection([hit], 5, "l0");
    expect(result).toContain("- First sentence here.");
    expect(result).not.toContain("Second sentence with more detail.");
  });

  it("depth='l1' produces abstract + first sentence", () => {
    const hit = makeHit("Abstract line. Body sentence with detail. Even more detail.", { id: "l1-test" });
    const result = formatRecallInjection([hit], 5, "l1");
    expect(result).toContain("Abstract line.");
    // l1 = first sentence of text (which for text without separate l0 is the first sentence)
    expect(result).not.toBeNull();
  });

  it("depth='full' or depth=undefined produces full text (backward compatible)", () => {
    const hit = makeHit("Full text. With multiple sentences. And detail.", { id: "full-test" });
    const resultFull = formatRecallInjection([hit], 5, "full");
    const resultUndef = formatRecallInjection([hit], 5);
    expect(resultFull).toContain("Full text. With multiple sentences. And detail.");
    expect(resultUndef).toContain("Full text. With multiple sentences. And detail.");
  });
});

// ---------------------------------------------------------------------------
// toToolSearchResults
// ---------------------------------------------------------------------------
describe("toToolSearchResults", () => {
  it("maps SearchHit to tool result shape with id, memory, score", () => {
    const hit: SearchHit = { id: "mem-1", text: "Some fact", score: 0.85, createdAt: "2026-01-01T00:00:00Z" };
    const { results } = toToolSearchResults([hit], 10);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("mem-1");
    expect(results[0].memory).toBe("Some fact");
    expect(results[0].score).toBe(0.85);
  });

  it("clamps to limit", () => {
    const hits = Array.from({ length: 10 }, (_, i) => makeHit(`fact ${i}`, { id: `m-${i}` }));
    const { results } = toToolSearchResults(hits, 3);
    expect(results).toHaveLength(3);
  });
});
