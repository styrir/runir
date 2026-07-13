import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Skip-condition helpers for tests that depend on the locally-installed
 * Claude Code hooks (`~/.claude/hooks/...`). Gap 4 of test-harness-depth-plan.
 *
 * Pre-mortem mitigation 5: `existsSync` can return false transiently on slow
 * filesystems (network mounts, FUSE, sandboxed dev containers). The retry
 * wrapper here distinguishes "definitely missing" from "transiently unavailable"
 * by giving the FS up to 3 attempts × 50ms before declaring absence.
 *
 * Skip events are appended to `.pipeline/test-skips/<run-id>.jsonl` so CI can
 * detect when a test's skip rate changes — a skip-rate regression is itself
 * a regression (a test silently goes from "always runs" to "always skips"
 * is a coverage loss we can't see from green CI alone).
 */

const CLAUDE_HOOKS_DIR = path.join(os.homedir(), ".claude", "hooks");

const SKIP_LOG_DIR = path.join(process.cwd(), ".pipeline", "test-skips");
const RUN_ID = process.env.RUNIR_TEST_RUN_ID ?? `local-${process.pid}-${Date.now()}`;
const SKIP_LOG_PATH = path.join(SKIP_LOG_DIR, `${RUN_ID}.jsonl`);

let skipLogInitialized = false;
function initSkipLog(): void {
  if (skipLogInitialized) return;
  try {
    mkdirSync(SKIP_LOG_DIR, { recursive: true });
    skipLogInitialized = true;
  } catch {
    // If we can't create the dir (read-only FS, sandboxing), proceed without
    // structured logging — the test will still skip correctly via the boolean
    // return value; observability is best-effort.
    skipLogInitialized = true;
  }
}

function logSkip(label: string, reason: string): void {
  initSkipLog();
  if (process.env.RUNIR_TEST_SKIP_LOG_DISABLED === "1") return;
  try {
    const event = {
      timestamp: new Date().toISOString(),
      run_id: RUN_ID,
      label,
      reason,
    };
    appendFileSync(SKIP_LOG_PATH, JSON.stringify(event) + "\n");
  } catch {
    // Best-effort. Never fail a test because we couldn't write the log.
  }
}

function existsWithRetry(p: string, attempts = 3, delayMs = 50): boolean {
  for (let i = 0; i < attempts; i++) {
    if (existsSync(p)) return true;
    if (i < attempts - 1) {
      // Tiny synchronous delay — total budget ≤150ms per call.
      const target = Date.now() + delayMs;
      while (Date.now() < target) {
        /* spin */
      }
    }
  }
  return false;
}

export function claudeHooksAvailable(...relativePaths: string[]): boolean {
  if (process.env.RUNIR_CLAUDE_HOOKS_INSTALLED !== "1") {
    logSkip(
      relativePaths.join(",") || "claudeHooks",
      "RUNIR_CLAUDE_HOOKS_INSTALLED env var not set to '1'",
    );
    return false;
  }
  const missing = relativePaths.filter((rel) => !existsWithRetry(path.join(CLAUDE_HOOKS_DIR, rel)));
  if (missing.length > 0) {
    logSkip(relativePaths.join(","), `missing ~/.claude/hooks/${missing.join(", ")}`);
    return false;
  }
  return true;
}

export function bashAvailable(): boolean {
  const ok = existsWithRetry("/bin/bash") || existsWithRetry("/usr/bin/bash");
  if (!ok) logSkip("bash", "neither /bin/bash nor /usr/bin/bash present");
  return ok;
}

export function skipReason(label: string, requiredPaths: string[]): string {
  const missing = requiredPaths.filter((rel) => !existsWithRetry(path.join(CLAUDE_HOOKS_DIR, rel)));
  if (missing.length > 0) {
    return `${label}: missing ~/.claude/hooks/${missing.join(", ")}`;
  }
  if (process.env.RUNIR_CLAUDE_HOOKS_INSTALLED !== "1") {
    return `${label}: RUNIR_CLAUDE_HOOKS_INSTALLED env var not set to "1"`;
  }
  return "";
}

/**
 * Test-only accessor for the structured skip log path. CI scripts can read
 * this to aggregate skip-rate per test and detect regressions.
 */
export function getSkipLogPath(): string {
  return SKIP_LOG_PATH;
}
