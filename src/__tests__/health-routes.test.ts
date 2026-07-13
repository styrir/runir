import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// Rúnir-pn1l.13.7 D7 / P1#5 test 13: /health supersessionJudge counters must
// reflect REAL increments from the wrapper — not hard-coded zeros.

const mockCallLlmGateway = vi.fn();
vi.mock("../shared/llm-gateway-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, callLlmGateway: (...a: unknown[]) => mockCallLlmGateway(...a) };
});

import { buildSupersessionJudge } from "../app/supersession-judge.js";
import {
  getLedgerWriteFailures,
  noteLedgerWriteFailure,
  resetLedgerWriteFailuresForTests,
} from "../storage/surreal/supersession-judge-ledger.js";
import { LlmGatewayError } from "../shared/llm-gateway-client.js";

// Build a real handle so counters are live.
const liveJudge = buildSupersessionJudge({ apiKey: "health-test-key" });

const mocks = vi.hoisted(() => ({
  probeDatabaseReady: vi.fn(),
  getBootstrapReadinessReport: vi.fn(),
}));

vi.mock("../app/runtime.js", () => ({
  cfg: {
    userId: "owner",
    reranker: { provider: "local" },
    topK: 5,
  },
  db: {},
  // Live handle — getCounters() reflects real resolution activity.
  get supersessionJudge() {
    return liveJudge;
  },
}));

vi.mock("../app/readiness.js", () => ({
  probeDatabaseReady: mocks.probeDatabaseReady,
  getBootstrapReadinessReport: mocks.getBootstrapReadinessReport,
}));

import { registerHealthRoutes } from "../app/routes/health.js";

function makeApp() {
  const app = new Hono();
  registerHealthRoutes(app);
  return app;
}

describe("health routes", () => {
  beforeEach(() => {
    mocks.probeDatabaseReady.mockReset();
    mocks.getBootstrapReadinessReport.mockReset();
    mocks.getBootstrapReadinessReport.mockReturnValue({
      ready: true,
      checkedAt: "2026-04-18T00:00:00.000Z",
      checks: [{ name: "phase2-schema", ok: true }],
    });
    mockCallLlmGateway.mockReset();
    resetLedgerWriteFailuresForTests();
  });

  afterEach(() => {
    resetLedgerWriteFailuresForTests();
  });

  it("/health returns shallow service status with supersessionJudge block", async () => {
    const app = makeApp();
    const response = await app.request("/health");
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.userId).toBe("owner");
    expect(json.reranker).toBe("local");
    expect(json.topK).toBe(5);
    expect(json.supersessionJudge).toEqual(
      expect.objectContaining({
        verdict: expect.any(Number),
        unavailable: expect.any(Number),
        transport_error: expect.any(Number),
        invalid_response: expect.any(Number),
        vetoed: expect.any(Number),
        confirmed: expect.any(Number),
        duplicate: expect.any(Number),
        ledger_write_failures: expect.any(Number),
      }),
    );
  });

  it("/health reflects REAL counter increments after driving the judge wrapper (P1#5 test 13)", async () => {
    const app = makeApp();
    const before = (await (await app.request("/health")).json()).supersessionJudge;

    // Drive a successful verdict through the real wrapper.
    mockCallLlmGateway.mockResolvedValueOnce(
      JSON.stringify({ verdict: "supersede", confidence: 0.9 }),
    );
    await liveJudge.judge("old fact", "new fact");
    liveJudge.noteResolution("confirmed");

    // Drive a transport_error class.
    mockCallLlmGateway.mockRejectedValueOnce(new LlmGatewayError("503", 503, "http"));
    await liveJudge.judge("old", "new");

    // Drive a ledger failure via the module-owned counter (handle-independent).
    noteLedgerWriteFailure("test ledger fail");

    const after = (await (await app.request("/health")).json()).supersessionJudge;

    expect(after.verdict).toBe(before.verdict + 1);
    expect(after.transport_error).toBe(before.transport_error + 1);
    expect(after.confirmed).toBe(before.confirmed + 1);
    expect(after.ledger_write_failures).toBe(before.ledger_write_failures + 1);
    // Sanity: module counter agrees with /health surface.
    expect(getLedgerWriteFailures()).toBe(after.ledger_write_failures);
    // Not hard-coded zeros after real activity.
    expect(after.verdict + after.transport_error + after.confirmed + after.ledger_write_failures).toBeGreaterThan(0);
  });

  it("/ready returns 200 when bootstrap and db checks are ready", async () => {
    mocks.probeDatabaseReady.mockResolvedValue(undefined);
    const app = makeApp();

    const response = await app.request("/ready");
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("ready");
    expect(json.bootstrap.ready).toBe(true);
    expect(json.db.ok).toBe(true);
  });

  it("/ready returns 503 when bootstrap checks failed earlier", async () => {
    mocks.probeDatabaseReady.mockResolvedValue(undefined);
    mocks.getBootstrapReadinessReport.mockReturnValue({
      ready: false,
      checkedAt: "2026-04-18T00:00:00.000Z",
      checks: [{ name: "phase2-schema", ok: false, details: "DDL failed" }],
    });
    const app = makeApp();

    const response = await app.request("/ready");
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.status).toBe("not_ready");
    expect(json.bootstrap.checks[0]).toEqual(
      expect.objectContaining({ name: "phase2-schema", ok: false }),
    );
  });

  it("/ready returns 503 when database probe fails", async () => {
    mocks.probeDatabaseReady.mockRejectedValue(new Error("db unavailable"));
    const app = makeApp();

    const response = await app.request("/ready");
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.status).toBe("not_ready");
    expect(json.db).toEqual(expect.objectContaining({
      ok: false,
      error: "db unavailable",
    }));
  });
});
