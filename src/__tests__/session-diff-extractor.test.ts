/**
 * Tests for session-diff-extractor.ts (MIM-63 / Code-fdu8)
 *
 * The server module only formats and validates — no git shell-outs.
 * Git collection has moved to the hook script (client side).
 */
import { describe, it, expect } from "vitest";
import {
  buildSyntheticBlock,
  parseGitCommits,
  buildGitDiffContext,
  SPARSE_SESSION_THRESHOLD,
  type CommitEntry,
} from "../capture/continuity/session-diff-extractor.js";

// ---------------------------------------------------------------------------
// SPARSE_SESSION_THRESHOLD
// ---------------------------------------------------------------------------
describe("SPARSE_SESSION_THRESHOLD", () => {
  it("is 10", () => {
    expect(SPARSE_SESSION_THRESHOLD).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// buildSyntheticBlock
// ---------------------------------------------------------------------------
describe("buildSyntheticBlock", () => {
  it("returns empty string for empty array", () => {
    expect(buildSyntheticBlock([])).toBe("");
  });

  it("includes the header label", () => {
    const entry: CommitEntry = {
      hash: "abc123def456",
      subject: "feat: add salience scorer",
      statSummary: "src/session-salience.ts | 10 +++++",
      diffSnippet: "+export function scoreSessionSalience() {}",
    };
    expect(buildSyntheticBlock([entry])).toContain("[Git commits during this session:]");
  });

  it("includes abbreviated hash and subject", () => {
    const entry: CommitEntry = {
      hash: "abc123def456",
      subject: "fix: restore go CLI artifact regex",
      statSummary: "",
      diffSnippet: "",
    };
    const block = buildSyntheticBlock([entry]);
    expect(block).toContain("abc123def456".slice(0, 12));
    expect(block).toContain("fix: restore go CLI artifact regex");
  });

  it("includes stat summary when present", () => {
    const entry: CommitEntry = {
      hash: "aaa111",
      subject: "chore: cleanup",
      statSummary: "src/foo.ts | 3 +++",
      diffSnippet: "",
    };
    expect(buildSyntheticBlock([entry])).toContain("src/foo.ts | 3 +++");
  });

  it("includes diff snippet when present", () => {
    const entry: CommitEntry = {
      hash: "bbb222",
      subject: "feat: new fn",
      statSummary: "",
      diffSnippet: "+export const foo = () => 42;",
    };
    expect(buildSyntheticBlock([entry])).toContain("+export const foo = () => 42;");
  });

  it("separates multiple commits with ---", () => {
    const entries: CommitEntry[] = [
      { hash: "aaa111", subject: "first", statSummary: "", diffSnippet: "" },
      { hash: "bbb222", subject: "second", statSummary: "", diffSnippet: "" },
    ];
    const block = buildSyntheticBlock(entries);
    expect(block).toContain("first");
    expect(block).toContain("second");
    expect(block.split("---").length).toBeGreaterThanOrEqual(2);
  });

  it("skips entries with missing hash or subject", () => {
    const entries: CommitEntry[] = [
      { hash: "", subject: "no hash", statSummary: "", diffSnippet: "" },
      { hash: "abc123", subject: "", statSummary: "", diffSnippet: "" },
      { hash: "def456", subject: "valid", statSummary: "", diffSnippet: "" },
    ];
    const block = buildSyntheticBlock(entries);
    expect(block).toContain("valid");
    expect(block).not.toContain("no hash");
  });

  it("returns empty string if all entries are invalid", () => {
    const entries: CommitEntry[] = [
      { hash: "", subject: "no hash", statSummary: "", diffSnippet: "" },
    ];
    expect(buildSyntheticBlock(entries)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseGitCommits — input validation / coercion
// ---------------------------------------------------------------------------
describe("parseGitCommits", () => {
  it("returns [] for undefined input", () => {
    expect(parseGitCommits(undefined)).toEqual([]);
  });

  it("returns [] for null input", () => {
    expect(parseGitCommits(null)).toEqual([]);
  });

  it("returns [] for non-array input", () => {
    expect(parseGitCommits("string")).toEqual([]);
    expect(parseGitCommits(42)).toEqual([]);
    expect(parseGitCommits({})).toEqual([]);
  });

  it("returns [] for empty array", () => {
    expect(parseGitCommits([])).toEqual([]);
  });

  it("parses a valid commit entry", () => {
    const raw = [{ hash: "abc123", subject: "feat: foo", statSummary: "1 file", diffSnippet: "+x" }];
    const result = parseGitCommits(raw);
    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe("abc123");
    expect(result[0].subject).toBe("feat: foo");
  });

  it("drops entries missing hash", () => {
    const raw = [{ hash: "", subject: "feat: foo", statSummary: "", diffSnippet: "" }];
    expect(parseGitCommits(raw)).toHaveLength(0);
  });

  it("drops entries missing subject", () => {
    const raw = [{ hash: "abc123", subject: "", statSummary: "", diffSnippet: "" }];
    expect(parseGitCommits(raw)).toHaveLength(0);
  });

  it("coerces non-string fields to empty string", () => {
    const raw = [{ hash: "abc123", subject: "feat", statSummary: null, diffSnippet: 99 }];
    const result = parseGitCommits(raw);
    expect(result).toHaveLength(1);
    expect(result[0].statSummary).toBe("");
    expect(result[0].diffSnippet).toBe("");
  });

  it("drops non-object array entries", () => {
    const raw = ["string-entry", 42, null, { hash: "abc123", subject: "valid" }];
    const result = parseGitCommits(raw);
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// buildGitDiffContext
// ---------------------------------------------------------------------------
describe("buildGitDiffContext", () => {
  it("returns null for empty commits", () => {
    expect(buildGitDiffContext([])).toBeNull();
  });

  it("returns null if all commits produce empty block", () => {
    // entries with empty hash/subject are skipped by buildSyntheticBlock
    const commits: CommitEntry[] = [
      { hash: "", subject: "", statSummary: "", diffSnippet: "" },
    ];
    expect(buildGitDiffContext(commits)).toBeNull();
  });

  it("returns a GitDiffContext for valid commits", () => {
    const commits: CommitEntry[] = [
      { hash: "abc123def456", subject: "feat: something", statSummary: "1 file", diffSnippet: "+x" },
    ];
    const ctx = buildGitDiffContext(commits);
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(1);
    expect(ctx!.syntheticBlock).toContain("[Git commits during this session:]");
    expect(ctx!.syntheticBlock).toContain("feat: something");
  });

  it("never throws", () => {
    expect(() => buildGitDiffContext([])).not.toThrow();
    expect(() => buildGitDiffContext([{ hash: "x", subject: "y", statSummary: "", diffSnippet: "" }])).not.toThrow();
  });
});
