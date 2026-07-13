import { describe, it, expect } from "vitest";

/**
 * Containerized integration test (bead Rúnir-r9pn.16).
 *
 * Verifies that the docker-compose.test.yml stack came up cleanly and both
 * services respond on their healthcheck endpoints. This is the "real-dep" lane
 * that `npm run test:ci:slow` exercises — when Docker isn't available the
 * suite must self-skip rather than fail (per AGENTS.md Test Dependencies
 * directive: agents start Docker themselves; CI just reports the absence
 * cleanly).
 *
 * Env contract:
 *   - RUNIR_TEST_SLOW_LANE=1 → enable the lane (set by `npm run test:ci:slow`)
 *   - RUNIR_TEST_SURREAL_URL → optional override of the SurrealDB URL
 *                              (default: http://localhost:18000)
 *   - RUNIR_TEST_OLLAMA_URL  → optional override of the Ollama URL
 *                              (default: http://localhost:11434)
 */

const SLOW_LANE_ENABLED = process.env.RUNIR_TEST_SLOW_LANE === "1";
const SURREAL_URL = process.env.RUNIR_TEST_SURREAL_URL ?? "http://localhost:18000";
const OLLAMA_URL = process.env.RUNIR_TEST_OLLAMA_URL ?? "http://localhost:11434";

async function reachable(url: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!SLOW_LANE_ENABLED)("test:ci:slow containerized deps", () => {
  it("SurrealDB container responds on /health", async () => {
    const ok = await reachable(`${SURREAL_URL}/health`);
    expect(ok).toBe(true);
  });

  it("Ollama container responds on /api/tags", async () => {
    const ok = await reachable(`${OLLAMA_URL}/api/tags`);
    expect(ok).toBe(true);
  });
});
