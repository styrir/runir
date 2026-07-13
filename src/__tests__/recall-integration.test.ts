/**
 * recall-integration.test.ts
 *
 * Live integration tests for the recall pipeline. Pure HTTP client —
 * hits the running Rúnir service exactly as OpenClaw does, no credentials.
 *
 * TWO SUITES:
 *
 * 1. recall-quality-audit — fires the 5 standard queries, asserts count > 0,
 *    bullets returned, continuitySource shape. Writes a dated JSON baseline
 *    to docs/testing/recall-quality-baseline-YYYY-MM-DD.json.
 *
 * 2. session-opener-probe — fires the session_opener prompt, asserts
 *    prependContext is non-null and non-empty, writes a dated markdown
 *    artifact to docs/testing/runir-recall-quality-sample-YYYY-MM-DD.md.
 *
 * SKIP: Tests skip automatically if the service is not reachable.
 *       No credentials required. Defaults to https://runir.styrir.com.
 *       Override with RUNIR_SERVICE_URL env var.
 *
 * PASS CRITERIA:
 *   - Every standard query returns count >= 1 and at least 1 bullet
 *   - session_opener returns count >= 1 and non-null prependContext
 *   - continuitySource is one of: "deterministic" | "embedder" | null
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVICE_URL = process.env.RUNIR_SERVICE_URL ?? "https://runir.styrir.com";
const RUN_LIVE_RECALL_TESTS = process.env.RUNIR_LIVE_TESTS === "1";
// Production service uses "owner" as the default userId — resolved via RUNIR_USER_ID on the server.
// Do not pass userId in requests; let the server resolve it from its own config.
const USER_ID     = process.env.RUNIR_TEST_USER_ID ?? undefined;
const RUNIR_PATH  = "/Users/brooks/Code/runir";
const OUTPUT_DIR  = "docs/testing";
const TODAY       = new Date().toISOString().split("T")[0];

const STANDARD_QUERIES = [
  { name: "current_status", prompt: "what are we working on in runir" },
  { name: "architecture",   prompt: "write arbitration memory pipeline" },
  { name: "debugging",      prompt: "test failures vitest mocking" },
  { name: "schema",         prompt: "SurrealDB payload schema SearchHit" },
  { name: "recent_work",    prompt: "MIM-71 state lane continuity wiring" },
] as const;

const SESSION_OPENER_PROMPT = "let's continue where we left off";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RecallResponse = {
  prependContext: string | null;
  count: number;
  continuitySource?: string;
  sessionOpener?: {
    intent: string;
    confidence: string;
    focus: string[];
    state: string[];
    env: string[];
    next: string[];
    evidenceTitles: string[];
  };
};

function hasStructuredSessionOpener(resp: RecallResponse): boolean {
  return !!resp.sessionOpener && !!resp.prependContext?.includes("session_opener:");
}

async function checkReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function recallQuery(prompt: string): Promise<RecallResponse> {
  const body: Record<string, unknown> = { prompt, path: RUNIR_PATH };
  if (USER_ID) body.userId = USER_ID;
  const res = await fetch(`${SERVICE_URL}/hooks/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/hooks/recall returned HTTP ${res.status}`);
  return res.json() as Promise<RecallResponse>;
}

function extractBullets(prependContext: string | null, count: number): string[] {
  if (!prependContext || count === 0) return [];
  const body = prependContext
    .split("The following memories may be relevant to this conversation:\n")[1]
    ?.split("\n[END UNTRUSTED DATA]")[0] ?? "";
  if (!body) return [];
  const parts = body.startsWith("- ") ? body.slice(2).split("\n- ") : body.split("\n- ");
  return parts.filter(Boolean).slice(0, count);
}

// ---------------------------------------------------------------------------
// Suite 1: Recall Quality Audit (5 standard queries)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_LIVE_RECALL_TESTS)(`recall-quality-audit [${SERVICE_URL}]`, () => {
  let reachable = false;

  beforeAll(async () => {
    reachable = RUN_LIVE_RECALL_TESTS && await checkReachable();
  }, 8000);

  type QueryResult = {
    name: string;
    prompt: string;
    count: number;
    bullets_returned: number;
    continuity_source: string | null;
    passed: boolean;
  };

  const results: Record<string, QueryResult> = {};

  for (const q of STANDARD_QUERIES) {
    it(`[${q.name}] count >= 1 and at least 1 bullet returned`, async () => {
      if (!reachable) return; // soft skip — don't fail if service is down

      const resp    = await recallQuery(q.prompt);
      const bullets = extractBullets(resp.prependContext, resp.count);
      const cs      = resp.continuitySource ?? null;

      results[q.name] = {
        name: q.name,
        prompt: q.prompt,
        count: resp.count,
        bullets_returned: bullets.length,
        continuity_source: cs,
        passed: resp.count >= 1 && bullets.length >= 1,
      };

      expect(resp.count,    `${q.name}: count should be >= 1`).toBeGreaterThanOrEqual(1);
      expect(bullets.length, `${q.name}: at least 1 bullet in prependContext`).toBeGreaterThanOrEqual(1);
      expect(["deterministic", "embedder", null], `${q.name}: continuitySource must be a known value`).toContain(cs);
    }, 15000);
  }

  it("writes dated JSON baseline to docs/testing/", async () => {
    if (!reachable) return;

    const artifact = {
      captured_at: new Date().toISOString(),
      service_url: SERVICE_URL,
      user_id: USER_ID,
      label: `recall-quality-audit — ${TODAY}`,
      recall_quality: results,
    };

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outPath = path.join(OUTPUT_DIR, `recall-quality-baseline-${TODAY}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));

    expect(fs.existsSync(outPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    expect(written.recall_quality).toBeDefined();
  }, 5000);
});

// ---------------------------------------------------------------------------
// Suite 2: Session-Opener Probe (what the model sees on session start)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_LIVE_RECALL_TESTS)(`session-opener-probe [${SERVICE_URL}]`, () => {
  let reachable = false;
  let resp: RecallResponse;

  beforeAll(async () => {
    reachable = RUN_LIVE_RECALL_TESTS && await checkReachable();
  }, 8000);

  it("fires session_opener recall — count >= 1, prependContext non-null", async () => {
    if (!reachable) return;

    resp = await recallQuery(SESSION_OPENER_PROMPT);

    expect(resp.count, "session_opener: count should be >= 1").toBeGreaterThanOrEqual(1);
    expect(resp.prependContext, "session_opener: prependContext must not be null").not.toBeNull();

    if (hasStructuredSessionOpener(resp)) {
      expect(resp.sessionOpener?.intent).toBe("continue_previous_work");
      expect(resp.prependContext).toContain("session_opener:");
    } else {
      const bullets = extractBullets(resp.prependContext, resp.count);
      expect(bullets.length, "session_opener: legacy prependContext should still contain at least 1 bullet").toBeGreaterThanOrEqual(1);
    }
  }, 15000);

  it("continuitySource is a known value (deterministic | embedder | null)", () => {
    if (!reachable) return;
    expect(["deterministic", "embedder", null]).toContain(resp?.continuitySource ?? null);
  });

  it("writes dated artifacts containing exactly what the model receives plus the structured response", () => {
    if (!reachable) return;

    // Write the raw prependContext exactly as injected — no reformatting, no wrapper.
    // This is what the model sees. Nothing more, nothing less.
    const output = resp?.prependContext ?? "(null — nothing injected)";

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outPath = path.join(OUTPUT_DIR, `runir-recall-quality-sample-${TODAY}.md`);
    const jsonPath = path.join(OUTPUT_DIR, `runir-recall-quality-sample-${TODAY}.json`);
    fs.writeFileSync(outPath, output);
    fs.writeFileSync(jsonPath, JSON.stringify(resp, null, 2));

    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(output).not.toBe("(null — nothing injected)");
  });
});
