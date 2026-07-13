/**
 * session-diff-extractor.ts
 *
 * MIM-63 / Code-fdu8: Git-diff context formatting for agentic sessions.
 *
 * The CLIENT (hook script) collects git evidence locally — it has direct access
 * to the repo on the same machine. This module lives on the SERVER and is
 * responsible only for:
 *   1. Defining the CommitEntry type that the client sends in body.gitCommits
 *   2. Building the synthetic context block from those entries
 *   3. Exposing the injection policy (sparse-session threshold)
 *
 * The server never shells out to git. No RUNIR_GIT_REPO_PATH env var needed.
 */

/** Structured commit evidence sent by the client in body.gitCommits. */
export interface CommitEntry {
  hash: string;
  subject: string;
  statSummary: string;
  diffSnippet: string;
}

/** Result of processing client-supplied git evidence. */
export interface GitDiffContext {
  commits: CommitEntry[];
  syntheticBlock: string;
}

/** Sessions with fewer compressed messages than this threshold are eligible for git augmentation. */
export const SPARSE_SESSION_THRESHOLD = 10;

/**
 * Build the synthetic context block from client-supplied commit entries.
 * Returns empty string if commits array is empty or invalid.
 * Format is labeled so the extraction LLM treats it as artifact context,
 * not user instructions.
 */
export function buildSyntheticBlock(commits: CommitEntry[]): string {
  if (!commits || commits.length === 0) return "";

  const lines: string[] = [];
  lines.push("[Git commits during this session:]");
  lines.push("");

  for (const c of commits) {
    if (!c.hash || !c.subject) continue;
    lines.push(`Commit: ${c.hash.slice(0, 12)}`);
    lines.push(`Message: ${c.subject}`);
    if (c.statSummary) {
      lines.push("Changes:");
      lines.push(c.statSummary);
    }
    if (c.diffSnippet) {
      lines.push("Diff (src/ files, truncated):");
      lines.push(c.diffSnippet);
    }
    lines.push("---");
  }

  // If only the header was emitted (all entries invalid), return empty
  if (lines.length <= 2) return "";

  return lines.join("\n");
}

/**
 * Validate and coerce a raw body.gitCommits value into a CommitEntry[].
 * Silently drops malformed entries. Returns [] if input is not an array.
 * This keeps the server safe from malformed client payloads.
 */
export function parseGitCommits(raw: unknown): CommitEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      hash: typeof e.hash === "string" ? e.hash : "",
      subject: typeof e.subject === "string" ? e.subject : "",
      statSummary: typeof e.statSummary === "string" ? e.statSummary : "",
      diffSnippet: typeof e.diffSnippet === "string" ? e.diffSnippet : "",
    }))
    .filter((e) => e.hash.length > 0 && e.subject.length > 0);
}

/**
 * Given parsed commits, returns a GitDiffContext ready to inject, or null
 * if there is nothing useful to inject.
 */
export function buildGitDiffContext(commits: CommitEntry[]): GitDiffContext | null {
  if (commits.length === 0) return null;
  const syntheticBlock = buildSyntheticBlock(commits);
  if (!syntheticBlock) return null;
  return { commits, syntheticBlock };
}
