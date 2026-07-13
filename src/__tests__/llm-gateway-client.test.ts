import { describe, it, expect, vi, afterEach } from "vitest";
import {
  callLlmGateway,
  LlmGatewayError,
  isRetryableLlmGatewayError,
  stripJsonFences,
} from "../shared/llm-gateway-client.js";

function okResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  } as unknown as Response;
}

const BASE_OPTS = {
  model: "vertex/gemini-3.1-flash-lite@us",
  apiKey: "test-key",
  messages: [{ role: "user" as const, content: "hello" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RUNIR_LLM_JSON_MODE;
  delete process.env.RUNIR_LLM_BASE_URL;
});

describe("callLlmGateway", () => {
  it("returns choices[0].message.content on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callLlmGateway(BASE_OPTS)).resolves.toBe('{"ok":true}');
  });

  it("throws LlmGatewayError with status and kind=http on non-ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "upstream sad",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const err = await callLlmGateway(BASE_OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(LlmGatewayError);
    expect(err.status).toBe(503);
    expect(err.kind).toBe("http");
  });

  it("aborts at timeoutMs and throws kind=timeout", async () => {
    // fetch that only settles when its signal aborts
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("AbortError")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const err = await callLlmGateway({ ...BASE_OPTS, timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmGatewayError);
    expect(err.kind).toBe("timeout");
    expect(String(err.message)).toContain("timed out after 20ms");
  });

  it("classifies non-abort fetch failures as kind=network", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    const err = await callLlmGateway(BASE_OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(LlmGatewayError);
    expect(err.kind).toBe("network");
  });

  it("sends response_format json_object when jsonMode is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await callLlmGateway({ ...BASE_OPTS, jsonMode: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format without jsonMode, and when RUNIR_LLM_JSON_MODE=0", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await callLlmGateway(BASE_OPTS);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).response_format).toBeUndefined();

    process.env.RUNIR_LLM_JSON_MODE = "0";
    await callLlmGateway({ ...BASE_OPTS, jsonMode: true });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).response_format).toBeUndefined();
  });

  it("effectiveJsonMode is used EXACTLY — env-independent; takes precedence over jsonMode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("{}"));
    vi.stubGlobal("fetch", fetchMock);
    process.env.RUNIR_LLM_JSON_MODE = "0";
    // explicit true must win even when kill-switch env is set
    await callLlmGateway({ ...BASE_OPTS, jsonMode: false, effectiveJsonMode: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).response_format).toEqual({
      type: "json_object",
    });
    // explicit false must omit even when env would allow jsonMode
    delete process.env.RUNIR_LLM_JSON_MODE;
    await callLlmGateway({ ...BASE_OPTS, jsonMode: true, effectiveJsonMode: false });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).response_format).toBeUndefined();
  });

  it("baseUrl option is used EXACTLY — env-independent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("{}"));
    vi.stubGlobal("fetch", fetchMock);
    process.env.RUNIR_LLM_BASE_URL = "http://env-default.example";
    await callLlmGateway({ ...BASE_OPTS, baseUrl: "http://bound-identity.example" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://bound-identity.example/chat/completions");
  });

  it("construction-time identity survives env mutation at call time (fetch URL + body)", async () => {
    // End-to-end for P0#1: mock global fetch (not the gateway module) and prove
    // the request matches the recorded identity even when env changes mid-flight.
    const fetchMock = vi.fn().mockResolvedValue(okResponse("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const boundBase = "http://judge-identity.test";
    const boundJson = true;
    process.env.RUNIR_LLM_BASE_URL = "http://mutated-after-construct.example";
    process.env.RUNIR_LLM_JSON_MODE = "0";
    await callLlmGateway({
      ...BASE_OPTS,
      baseUrl: boundBase,
      effectiveJsonMode: boundJson,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(`${boundBase}/chat/completions`);
    expect(url).not.toContain("mutated-after-construct");
    expect(JSON.parse(init.body).response_format).toEqual({ type: "json_object" });
  });

  it("throws kind=shape when content is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: {} }] }),
      text: async () => "",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const err = await callLlmGateway(BASE_OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(LlmGatewayError);
    expect(err.kind).toBe("shape");
  });
});

describe("isRetryableLlmGatewayError", () => {
  it("retries network, timeout, 429, and 5xx; not 400 or foreign errors", () => {
    expect(isRetryableLlmGatewayError(new LlmGatewayError("x", undefined, "network"))).toBe(true);
    expect(isRetryableLlmGatewayError(new LlmGatewayError("x", undefined, "timeout"))).toBe(true);
    expect(isRetryableLlmGatewayError(new LlmGatewayError("x", 429, "http"))).toBe(true);
    expect(isRetryableLlmGatewayError(new LlmGatewayError("x", 503, "http"))).toBe(true);
    expect(isRetryableLlmGatewayError(new LlmGatewayError("x", 400, "http"))).toBe(false);
    expect(isRetryableLlmGatewayError(new LlmGatewayError("x", 200, "shape"))).toBe(false);
    expect(isRetryableLlmGatewayError(new Error("plain"))).toBe(false);
  });
});

describe("stripJsonFences", () => {
  it("strips a json fence wrapper and leaves bare JSON alone", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });
});
