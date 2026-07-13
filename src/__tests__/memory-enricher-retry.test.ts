/**
 * memory-enricher-retry.test.ts — Code-8rfe
 * Tests for retry logic in callGeminiFlash.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGeminiFlash } from "../capture/enrichment/memory-enricher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(payload: object): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(payload),
          },
        },
      ],
    }),
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body = ""): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callGeminiFlash retry logic", () => {
  beforeEach(() => {
    // Set 0ms delay so retries are instant (no fake timers needed)
    process.env.ENRICH_MAX_RETRIES = "3";
    process.env.ENRICH_RETRY_DELAY_MS = "0";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENRICH_MAX_RETRIES;
    delete process.env.ENRICH_RETRY_DELAY_MS;
  });

  it("retries on 429 and succeeds on the 3rd attempt", async () => {
    const successPayload = { l0: "Test Title", l1: "Test summary.", para_hint: "resource" };
    let callCount = 0;

    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        return makeErrorResponse(429, "rate limited");
      }
      return makeOkResponse(successPayload);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await callGeminiFlash("test prompt", "test-api-key");

    expect(result).not.toBeNull();
    expect(result!.l0).toBe("Test Title");
    expect(result!.l1).toBe("Test summary.");
    expect(result!.para_hint).toBe("resource");
    expect(callCount).toBe(3);
  });

  it("gives up after max retries and throws an error", async () => {
    process.env.ENRICH_MAX_RETRIES = "2";

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      return makeErrorResponse(429, "rate limited always");
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(callGeminiFlash("test prompt", "test-api-key")).rejects.toThrow(/429/);
    // maxRetries=2 means attempts 0, 1, 2 => 3 total calls
    expect(callCount).toBe(3);
  });

  it("does NOT retry on 400 bad request — throws immediately", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      return makeErrorResponse(400, "bad request");
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(callGeminiFlash("test prompt", "test-api-key")).rejects.toThrow(/400/);
    // Should fail immediately — only 1 call, no retries
    expect(callCount).toBe(1);
  });
});
