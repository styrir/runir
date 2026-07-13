import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Rúnir-pn1l Layer 2 / 13.7 — the infra factory that composes the pure prompt/parse
// helpers with the LLM gateway and returns a HANDLE (D4) with discriminated outcomes
// (D0) and counters (D7). Lives in src/app/ (not storage/) to keep the arbitrator
// core framework-independent.

const mockCallLlmGateway = vi.fn();
vi.mock("../shared/llm-gateway-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, callLlmGateway: (...a: unknown[]) => mockCallLlmGateway(...a) };
});

import { LlmGatewayError } from "../shared/llm-gateway-client.js";
import { buildSupersessionJudge } from "../app/supersession-judge.js";
import {
  DEFAULT_JUDGE_CONFIDENCE_FLOOR,
  JUDGE_PROMPT_VERSION,
  judgePromptSha256,
} from "../storage/writes/supersession-judge.js";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RUNIR_SUPERSEDE_JUDGE_MODEL;
  delete process.env.RUNIR_LLM_JSON_MODE;
  delete process.env.RUNIR_LLM_BASE_URL;
  delete process.env.RUNIR_LLM_TIMEOUT_MS;
});

afterEach(() => {
  delete process.env.RUNIR_SUPERSEDE_JUDGE_MODEL;
  delete process.env.RUNIR_LLM_JSON_MODE;
  delete process.env.RUNIR_LLM_BASE_URL;
  delete process.env.RUNIR_LLM_TIMEOUT_MS;
});

describe("buildSupersessionJudge (handle)", () => {
  it("calls the gateway with OLD/NEW messages, temperature 0.1, and effective json mode", async () => {
    mockCallLlmGateway.mockResolvedValue(JSON.stringify({ verdict: "supersede", confidence: 0.9 }));
    const handle = buildSupersessionJudge({ apiKey: "k" });
    const outcome = await handle.judge("old fact", "new fact");
    expect(outcome).toEqual({
      status: "verdict",
      verdict: { verdict: "supersede", confidence: 0.9 },
    });
    const opts = mockCallLlmGateway.mock.calls[0][0];
    expect(opts.temperature).toBe(0.1);
    // Construction-time effective config threaded as effectiveJsonMode (P0#1).
    expect(opts.effectiveJsonMode).toBe(true);
    expect(typeof opts.baseUrl).toBe("string");
    expect(opts.apiKey).toBe("k");
    const user = opts.messages.find((m: { role: string }) => m.role === "user");
    expect(user.content).toContain("old fact");
    expect(user.content).toContain("new fact");
    expect(handle.getCounters().verdict).toBe(1);
  });

  it("defaults to the gemini flash-lite judge model, overridable by env", async () => {
    mockCallLlmGateway.mockResolvedValue(JSON.stringify({ verdict: "independent", confidence: 0.9 }));
    const handle = buildSupersessionJudge({ apiKey: "k" });
    await handle.judge("a", "b");
    expect(mockCallLlmGateway.mock.calls[0][0].model).toBe("vertex/gemini-3.1-flash-lite@us");

    process.env.RUNIR_SUPERSEDE_JUDGE_MODEL = "custom/model";
    const handle2 = buildSupersessionJudge({ apiKey: "k" });
    await handle2.judge("a", "b");
    expect(mockCallLlmGateway.mock.calls[1][0].model).toBe("custom/model");
  });

  // ── D0 / r3-#6 factory classification mapping (test 15) ──────────────────

  it("maps gateway kind:shape → invalid_response", async () => {
    mockCallLlmGateway.mockRejectedValue(new LlmGatewayError("bad envelope", 200, "shape"));
    const handle = buildSupersessionJudge({ apiKey: "k" });
    const outcome = await handle.judge("old", "new");
    expect(outcome.status).toBe("invalid_response");
    expect(handle.getCounters().invalid_response).toBe(1);
  });

  it("maps gateway kind:http → transport_error", async () => {
    mockCallLlmGateway.mockRejectedValue(new LlmGatewayError("500", 500, "http"));
    const handle = buildSupersessionJudge({ apiKey: "k" });
    const outcome = await handle.judge("old", "new");
    expect(outcome).toEqual({ status: "transport_error", detail: expect.stringContaining("500") });
    expect(handle.getCounters().transport_error).toBe(1);
  });

  it("maps gateway kind:timeout → transport_error", async () => {
    mockCallLlmGateway.mockRejectedValue(new LlmGatewayError("timed out", undefined, "timeout"));
    const handle = buildSupersessionJudge({ apiKey: "k" });
    const outcome = await handle.judge("old", "new");
    expect(outcome.status).toBe("transport_error");
    expect(handle.getCounters().transport_error).toBe(1);
  });

  it("maps gateway kind:network → transport_error", async () => {
    mockCallLlmGateway.mockRejectedValue(new LlmGatewayError("ECONNRESET", undefined, "network"));
    const handle = buildSupersessionJudge({ apiKey: "k" });
    const outcome = await handle.judge("old", "new");
    expect(outcome.status).toBe("transport_error");
    expect(handle.getCounters().transport_error).toBe(1);
  });

  it("empty key → unavailable without calling the gateway", async () => {
    const handle = buildSupersessionJudge({ apiKey: "" });
    const outcome = await handle.judge("old", "new");
    expect(outcome).toEqual({ status: "unavailable" });
    expect(mockCallLlmGateway).not.toHaveBeenCalled();
    expect(handle.getCounters().unavailable).toBe(1);
  });

  it("gateway-OK content failing parseJudgeVerdictRaw → invalid_response", async () => {
    mockCallLlmGateway.mockResolvedValue("not json at all");
    const handle = buildSupersessionJudge({ apiKey: "k" });
    const outcome = await handle.judge("old", "new");
    expect(outcome.status).toBe("invalid_response");
    if (outcome.status === "invalid_response") {
      expect(outcome.detail).toBe("malformed_json");
    }
    expect(handle.getCounters().invalid_response).toBe(1);
  });

  it("unknown error → transport_error (never verdict)", async () => {
    mockCallLlmGateway.mockRejectedValue(new Error("mystery"));
    const handle = buildSupersessionJudge({ apiKey: "k" });
    const outcome = await handle.judge("old", "new");
    expect(outcome.status).toBe("transport_error");
    expect(handle.getCounters().transport_error).toBe(1);
    expect(handle.getCounters().verdict).toBe(0);
  });

  // ── D4 / D6 / test 16: effective config identity + fetch observation ─────

  it("identity records EFFECTIVE config: RUNIR_LLM_JSON_MODE=0 ⇒ effectiveJsonMode:false in identity AND the gateway call", async () => {
    process.env.RUNIR_LLM_JSON_MODE = "0";
    process.env.RUNIR_LLM_BASE_URL = "http://localhost:7811";
    mockCallLlmGateway.mockResolvedValue(JSON.stringify({ verdict: "independent", confidence: 0.9 }));
    const handle = buildSupersessionJudge({ apiKey: "k", timeoutMs: 12_000, confidenceFloor: 0.7 });
    expect(handle.identity.effectiveJsonMode).toBe(false);
    expect(handle.identity.baseUrl).toBe("http://localhost:7811");
    expect(handle.identity.timeoutMs).toBe(12_000);
    expect(handle.identity.confidenceFloor).toBe(0.7);
    expect(handle.identity.temperature).toBe(0.1);
    expect(handle.identity.promptVersion).toBe(JUDGE_PROMPT_VERSION);
    expect(handle.identity.promptSha256).toBe(judgePromptSha256());
    await handle.judge("a", "b");
    // Factory threads construction-time values via baseUrl + effectiveJsonMode
    // (not just jsonMode) so the gateway cannot re-resolve from env (P0#1).
    expect(mockCallLlmGateway.mock.calls[0][0].baseUrl).toBe("http://localhost:7811");
    expect(mockCallLlmGateway.mock.calls[0][0].effectiveJsonMode).toBe(false);
    expect(mockCallLlmGateway.mock.calls[0][0].timeoutMs).toBe(12_000);
  });

  it("sub-floor supersede stays a verdict (floor is the resolver's job, not the factory)", async () => {
    mockCallLlmGateway.mockResolvedValue(
      JSON.stringify({ verdict: "supersede", confidence: DEFAULT_JUDGE_CONFIDENCE_FLOOR - 0.1 }),
    );
    const handle = buildSupersessionJudge({ apiKey: "k", confidenceFloor: 0.6 });
    const outcome = await handle.judge("old", "new");
    expect(outcome.status).toBe("verdict");
    if (outcome.status === "verdict") {
      expect(outcome.verdict.verdict).toBe("supersede");
      expect(outcome.verdict.confidence).toBeCloseTo(0.5);
    }
  });
});

// P0#1 / test 16: factory threads baseUrl + effectiveJsonMode; gateway client
// (llm-gateway-client.test.ts) proves those fields bind the actual fetch URL/body
// env-independently. Combined: construction identity == request identity.
describe("handle identity threaded to gateway opts after env mutates (P0#1)", () => {
  it("factory passes construction-time baseUrl + effectiveJsonMode even if env changes before judge()", async () => {
    process.env.RUNIR_LLM_BASE_URL = "http://judge-identity.test";
    process.env.RUNIR_LLM_JSON_MODE = "1"; // effective true
    mockCallLlmGateway.mockResolvedValue(
      JSON.stringify({ verdict: "independent", confidence: 0.9 }),
    );
    const handle = buildSupersessionJudge({ apiKey: "k", timeoutMs: 9_001 });
    expect(handle.identity.baseUrl).toBe("http://judge-identity.test");
    expect(handle.identity.effectiveJsonMode).toBe(true);

    // Env MUTATES between construction and call.
    process.env.RUNIR_LLM_BASE_URL = "http://mutated-after-construct.example";
    process.env.RUNIR_LLM_JSON_MODE = "0";

    await handle.judge("a", "b");
    const opts = mockCallLlmGateway.mock.calls[0][0];
    // Factory must pass the construction-time values, not re-read env.
    expect(opts.baseUrl).toBe("http://judge-identity.test");
    expect(opts.effectiveJsonMode).toBe(true);
    expect(opts.timeoutMs).toBe(9_001);
    expect(opts.baseUrl).not.toBe("http://mutated-after-construct.example");
  });
});
