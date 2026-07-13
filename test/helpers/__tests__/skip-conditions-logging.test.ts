import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { claudeHooksAvailable, getSkipLogPath } from "../skip-conditions.js";

/**
 * Pre-mortem 5 mitigation test (bead Rúnir-r9pn.7).
 *
 * Asserts that test-skip events are emitted to `.pipeline/test-skips/*.jsonl`
 * so CI can detect skip-rate regressions (a test silently going from
 * "always runs" to "always skips" is a coverage loss we can't see from
 * green CI alone).
 */

describe("skip-conditions structured logging", () => {
  const originalEnv = process.env.RUNIR_CLAUDE_HOOKS_INSTALLED;
  const originalDisableLog = process.env.RUNIR_TEST_SKIP_LOG_DISABLED;
  const logPath = getSkipLogPath();

  beforeEach(() => {
    delete process.env.RUNIR_CLAUDE_HOOKS_INSTALLED;
    delete process.env.RUNIR_TEST_SKIP_LOG_DISABLED;
    if (existsSync(logPath)) rmSync(logPath);
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.RUNIR_CLAUDE_HOOKS_INSTALLED = originalEnv;
    if (originalDisableLog !== undefined) process.env.RUNIR_TEST_SKIP_LOG_DISABLED = originalDisableLog;
  });

  it("emits a JSONL skip event when env gate is missing", () => {
    const ok = claudeHooksAvailable("lib/state.sh");
    expect(ok).toBe(false);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    const events = content.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const matching = events.find((e) => e.reason.includes("RUNIR_CLAUDE_HOOKS_INSTALLED"));
    expect(matching).toBeDefined();
    expect(matching.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(matching.run_id).toBeTruthy();
    expect(matching.label).toContain("lib/state.sh");
  });

  it("does NOT write a log entry when RUNIR_TEST_SKIP_LOG_DISABLED=1", () => {
    process.env.RUNIR_TEST_SKIP_LOG_DISABLED = "1";
    claudeHooksAvailable("lib/state.sh");
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, "utf8").trim();
      expect(content).toBe("");
    }
  });

  it("skip path returns a stable run-id-scoped JSONL location", () => {
    expect(logPath).toMatch(/\.pipeline\/test-skips\/.+\.jsonl$/);
  });
});
