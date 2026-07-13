import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractMemories } from "../capture/extraction/capture.js";
import type { CaptureMessage } from "../domain/memory/types.js";

const TEST_MESSAGES: CaptureMessage[] = [
  { role: "user", content: "Hello, how are you?" },
  { role: "assistant", content: "I'm doing well, thanks!" },
];

const TEST_PROMPT = "Extract facts from this conversation.";

describe("extractMemories timeout (MIM-41)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("aborts and returns [] with console.warn on timeout", async () => {
    // Mock fetch to hang indefinitely (never resolves until aborted)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }
      });
    });

    try {
      const result = await extractMemories(
        TEST_MESSAGES,
        TEST_PROMPT,
        "fake-api-key",
        new Date().toISOString(),
        undefined,
        { timeoutMs: 1 },
      );

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("extractMemories fetch aborted"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Rúnir-imaf.10: a provider that sends 200 headers then stalls the BODY. The
  // pre-fix clearTimeout ran before response.json(), leaving the body read
  // unbounded — this hung the synchronous /hooks/capture + /hooks/session-end
  // path forever. The 1500ms vitest cap makes the pre-fix (timer-already-cleared)
  // version fail fast as a hang instead of hanging the whole suite.
  it("aborts a provider that stalls the body after headers (json read stays inside the timer)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      } as unknown as Response),
    );

    try {
      const result = await extractMemories(
        TEST_MESSAGES,
        TEST_PROMPT,
        "fake-api-key",
        new Date().toISOString(),
        undefined,
        { timeoutMs: 10 },
      );
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("extractMemories body read aborted"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 1500);

  it("uses opts.model in the request body", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"facts": []}' } }],
      }), { status: 200 });
    });

    try {
      await extractMemories(
        TEST_MESSAGES,
        TEST_PROMPT,
        "fake-api-key",
        new Date().toISOString(),
        undefined,
        { model: "custom/model-v2" },
      );

      expect(capturedBody.model).toBe("custom/model-v2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses default model when opts.model is not provided", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"facts": []}' } }],
      }), { status: 200 });
    });

    try {
      await extractMemories(
        TEST_MESSAGES,
        TEST_PROMPT,
        "fake-api-key",
        new Date().toISOString(),
        undefined,
        { timeoutMs: 5000 },
      );

      expect(capturedBody.model).toBe("openai/gpt-5.4-mini");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("existing callers with 4 args still work", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"facts": []}' } }],
      }), { status: 200 });
    });

    try {
      // 4-arg call: messages, prompt, apiKey, timestamp
      const result = await extractMemories(
        TEST_MESSAGES,
        TEST_PROMPT,
        "fake-api-key",
        new Date().toISOString(),
      );
      expect(result).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("existing callers with 5 args (onReject) still work", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"facts": []}' } }],
      }), { status: 200 });
    });

    try {
      const onReject = vi.fn();
      // 5-arg call: messages, prompt, apiKey, timestamp, onReject
      const result = await extractMemories(
        TEST_MESSAGES,
        TEST_PROMPT,
        "fake-api-key",
        new Date().toISOString(),
        onReject,
      );
      expect(result).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("logs non-abort fetch errors with console.warn", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });

    try {
      const result = await extractMemories(
        TEST_MESSAGES,
        TEST_PROMPT,
        "fake-api-key",
        new Date().toISOString(),
        undefined,
        { timeoutMs: 5000 },
      );

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("extractMemories fetch error"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // G002: env-var-driven extractor model + seed for benchmark sweeps.
  it("G002: RUNIR_EXTRACTOR_MODEL env var overrides default model", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.RUNIR_EXTRACTOR_MODEL;
    let capturedBody: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"facts": []}' } }] }), { status: 200 });
    });
    process.env.RUNIR_EXTRACTOR_MODEL = "openai/gpt-5.5";

    try {
      await extractMemories(TEST_MESSAGES, TEST_PROMPT, "fake-api-key", new Date().toISOString(), undefined, {});
      expect(capturedBody.model).toBe("openai/gpt-5.5");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.RUNIR_EXTRACTOR_MODEL;
      else process.env.RUNIR_EXTRACTOR_MODEL = originalEnv;
    }
  });

  it("G002: opts.model takes precedence over RUNIR_EXTRACTOR_MODEL env var", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.RUNIR_EXTRACTOR_MODEL;
    let capturedBody: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"facts": []}' } }] }), { status: 200 });
    });
    process.env.RUNIR_EXTRACTOR_MODEL = "env/model";

    try {
      await extractMemories(TEST_MESSAGES, TEST_PROMPT, "fake-api-key", new Date().toISOString(), undefined, { model: "opts/model" });
      expect(capturedBody.model).toBe("opts/model");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.RUNIR_EXTRACTOR_MODEL;
      else process.env.RUNIR_EXTRACTOR_MODEL = originalEnv;
    }
  });

  it("G002: RUNIR_EXTRACTOR_SEED='' omits the seed parameter (for Anthropic models)", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.RUNIR_EXTRACTOR_SEED;
    let capturedBody: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"facts": []}' } }] }), { status: 200 });
    });
    process.env.RUNIR_EXTRACTOR_SEED = "";

    try {
      await extractMemories(TEST_MESSAGES, TEST_PROMPT, "fake-api-key", new Date().toISOString(), undefined, {});
      expect("seed" in capturedBody).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.RUNIR_EXTRACTOR_SEED;
      else process.env.RUNIR_EXTRACTOR_SEED = originalEnv;
    }
  });

  it("G002: default seed is 42 when RUNIR_EXTRACTOR_SEED is unset", async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.RUNIR_EXTRACTOR_SEED;
    let capturedBody: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"facts": []}' } }] }), { status: 200 });
    });
    delete process.env.RUNIR_EXTRACTOR_SEED;

    try {
      await extractMemories(TEST_MESSAGES, TEST_PROMPT, "fake-api-key", new Date().toISOString(), undefined, {});
      expect(capturedBody.seed).toBe(42);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.RUNIR_EXTRACTOR_SEED;
      else process.env.RUNIR_EXTRACTOR_SEED = originalEnv;
    }
  });
});
