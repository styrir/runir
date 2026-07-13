import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { segmentAndSummarize } from "../capture/extraction/capture.js";
import { setCounterEmitter, resetCounterEmitter } from "../obs/counters.js";

// iter-3 (extraction-robustness): segmentAndSummarize gets the proven iter-1
// recipe — gated json_object + recordCounter drop observability. Its drops
// previously surfaced only through an OPTIONAL logger callback (prod-invisible),
// so a fenced/malformed topics reply silently yielded no session summary.

const MSGS = [{ role: "user" as const, content: "Let's talk about Runir and then about SurrealDB indexing." }];
const ENV_KEYS = ["RUNIR_EXTRACTOR_MODEL", "RUNIR_EXTRACTOR_SEED", "RUNIR_EXTRACTOR_JSON_MODE"];
const SAVED: Record<string, string | undefined> = {};

let captured: string[] = [];
let restoreEmitter: () => void;

function segResponse(content: string): Response {
  return {
    ok: true,
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

function bodyOf(spy: ReturnType<typeof vi.spyOn>): any {
  return JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
}

function segDropReasons(): string[] {
  return captured
    .filter((l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=segment"))
    .map((l) => (l.match(/reason=(\S+)/) ?? [])[1] ?? "");
}

function segDropCount(reason: string): number {
  return captured.filter(
    (l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=segment") && l.includes(`reason=${reason}`),
  ).length;
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  captured = [];
  restoreEmitter = setCounterEmitter({ emit: (l) => captured.push(l) });
});

afterEach(() => {
  restoreEmitter();
  resetCounterEmitter();
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
});

describe("segmentAndSummarize — JSON-mode gating", () => {
  it("default model (openai/*) sends response_format json_object", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(segResponse(JSON.stringify({ topics: [] })));
    await segmentAndSummarize(MSGS, "key");
    const body = bodyOf(spy);
    expect(body.model).toBe("openai/gpt-5.4-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.provider).toBeUndefined();
  });

  it("Anthropic override does NOT send response_format", async () => {
    process.env.RUNIR_EXTRACTOR_MODEL = "anthropic/claude-sonnet-4.6";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(segResponse(JSON.stringify({ topics: [] })));
    await segmentAndSummarize(MSGS, "key");
    expect(bodyOf(spy).response_format).toBeUndefined();
  });
});

describe("segmentAndSummarize — drop observability + never-throws", () => {
  it("returns topics and emits NO drop counter on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      segResponse(JSON.stringify({ topics: [{ title: "Runir", summary: "Discussed Runir." }] })),
    );
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result.topics).toHaveLength(1);
    expect(segDropReasons()).toEqual([]);
  });

  it("non-OK response returns {topics:[]} and records reason=http_not_ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "err",
      text: async () => "",
    } as unknown as Response);
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result).toEqual({ topics: [] });
    expect(segDropReasons()).toContain("http_not_ok");
  });

  it("malformed HTTP body records reason=http_json_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "<html>not json</html>",
    } as unknown as Response);
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result).toEqual({ topics: [] });
    expect(segDropReasons()).toContain("http_json_error");
  });

  it("a null HTTP body (text()=>'null') returns {topics:[]} (never-throws) and records missing_choices", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "null",
    } as unknown as Response);
    await expect(segmentAndSummarize(MSGS, "key")).resolves.toEqual({ topics: [] });
    expect(segDropReasons()).toContain("missing_choices");
  });

  it("missing choices records reason=missing_choices", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [] }),
    } as unknown as Response);
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result).toEqual({ topics: [] });
    expect(segDropReasons()).toContain("missing_choices");
  });

  it("content that is not JSON records reason=content_parse_error", async () => {
    // Use input unrepairable by jsonrepair (mismatched braces + unterminated string)
    // so JSONRepairError propagates to the outer catch → content_parse_error.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(segResponse('}{topics"'));
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result).toEqual({ topics: [] });
    expect(segDropReasons()).toContain("content_parse_error");
  });

  it("valid JSON with non-array topics records reason=bad_topics_shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(segResponse(JSON.stringify({ topics: "nope" })));
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result).toEqual({ topics: [] });
    expect(segDropReasons()).toContain("bad_topics_shape");
  });

  it("a throwing counter sink does not break the {topics:[]} fallback", async () => {
    setCounterEmitter({
      emit: () => {
        throw new Error("sink failed");
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(segResponse("not json"));
    await expect(segmentAndSummarize(MSGS, "key")).resolves.toEqual({ topics: [] });
  });

  it("AbortError records exactly one reason=timeout", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result).toEqual({ topics: [] });
    expect(segDropCount("timeout")).toBe(1);
  });

  it("generic fetch rejection records exactly one reason=fetch_error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result).toEqual({ topics: [] });
    expect(segDropCount("fetch_error")).toBe(1);
  });

  it("a rejecting response.text() returns {topics:[]} (never-throws) and records http_read_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => {
        throw new Error("stream failed");
      },
    } as unknown as Response);
    await expect(segmentAndSummarize(MSGS, "key")).resolves.toEqual({ topics: [] });
    expect(segDropCount("http_read_error")).toBe(1);
  });

  it("a non-string message.content does NOT throw (coerced) and records content_parse_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      // content is an object, not a string — would crash text.match/text.slice
      text: async () => JSON.stringify({ choices: [{ message: { content: { not: "a string" } } }] }),
    } as unknown as Response);
    await expect(segmentAndSummarize(MSGS, "key")).resolves.toEqual({ topics: [] });
    expect(segDropCount("content_parse_error")).toBe(1);
  });

  it("array-shaped topics with a malformed element: valid siblings survive, bad element counted once", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      segResponse(
        JSON.stringify({
          topics: [
            { title: "Runir", summary: "Discussed Runir architecture." },
            { title: "only title, no summary" }, // malformed — caller would crash on .summary.trim()
          ],
        }),
      ),
    );
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0].title).toBe("Runir");
    expect(segDropCount("bad_topics_shape")).toBe(1);
  });

  it("an all-malformed topics array yields {topics:[]} and one bad_topics_shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      segResponse(JSON.stringify({ topics: [{ title: "no summary" }, { summary: "no title" }] })),
    );
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result).toEqual({ topics: [] });
    expect(segDropCount("bad_topics_shape")).toBe(1);
  });

  it("a fully valid topics array emits NO drop counter (exact-zero)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      segResponse(JSON.stringify({ topics: [{ title: "A", summary: "sa" }, { title: "B", summary: "sb" }] })),
    );
    const result = await segmentAndSummarize(MSGS, "key");
    expect(result.topics).toHaveLength(2);
    expect(segDropCount("bad_topics_shape")).toBe(0);
    expect(segDropReasons()).toEqual([]);
  });
});

describe("segmentAndSummarize — body-stall timeout (Rúnir-imaf.10)", () => {
  // Same body-stall class as imaf.4/imaf.10's extractMemories: a provider that
  // sends 200 headers then stalls the BODY. The pre-fix clearTimeout ran before
  // response.text(), leaving the body read unbounded — which hung the synchronous
  // /hooks/session-end path forever. The 1500ms vitest cap makes the pre-fix
  // (timer-already-cleared) version fail fast as a hang.
  it("aborts a provider that stalls the body after headers and records a timeout drop", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      Promise.resolve({
        ok: true,
        text: () =>
          new Promise((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      } as unknown as Response),
    );
    const result = await segmentAndSummarize(MSGS, "key", undefined, { timeoutMs: 10 });
    expect(result).toEqual({ topics: [] });
    expect(segDropReasons()).toContain("timeout");
  }, 1500);
});
