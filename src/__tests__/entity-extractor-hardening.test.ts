import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractEntities } from "../entities/entity-extractor.js";
import { setCounterEmitter, resetCounterEmitter } from "../obs/counters.js";

// iter-4 (extraction-robustness): extractEntities gets the proven recipe —
// gated json_object + capture_batch_dropped (stage=entity) observability + never-throws
// (wrapped fetch + response.json + null-safe data?.choices) + per-element
// isolation. It is a one-shot session-end path: a parse/HTTP failure loses the
// whole session's entity graph + linking, previously with zero signal.

const MSGS = [{ role: "user" as const, content: "Alice works at Acme Corp on SurrealDB." }];
const ENV_KEYS = ["RUNIR_EXTRACTOR_JSON_MODE"];
const SAVED: Record<string, string | undefined> = {};

let captured: string[] = [];
let restoreEmitter: () => void;

function entResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

function bodyOf(spy: ReturnType<typeof vi.spyOn>): any {
  return JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
}

function entDropReasons(): string[] {
  return captured
    .filter((l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=entity"))
    .map((l) => (l.match(/reason=(\S+)/) ?? [])[1] ?? "");
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

describe("extractEntities — JSON-mode gating", () => {
  it("sends response_format json_object (model is openai/*)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(entResponse(JSON.stringify({ entities: [] })));
    await extractEntities(MSGS, "key");
    const body = bodyOf(spy);
    expect(body.model).toBe("openai/gpt-5.4-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.provider).toBeUndefined();
  });

  it("RUNIR_EXTRACTOR_JSON_MODE=0 disables json mode", async () => {
    process.env.RUNIR_EXTRACTOR_JSON_MODE = "0";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(entResponse(JSON.stringify({ entities: [] })));
    await extractEntities(MSGS, "key");
    expect(bodyOf(spy).response_format).toBeUndefined();
  });
});

describe("extractEntities — request timeout (Rúnir-imaf.4)", () => {
  it("aborts a stalled provider after the configured timeout and returns [] with a 'timeout' drop", async () => {
    // A provider that never responds until its AbortSignal fires. Without the
    // AbortController this await hangs FOREVER, blocking the synchronous
    // /hooks/capture + /hooks/session-end path. The 1500ms vitest cap means the
    // pre-fix (no-signal) version fails fast as a hang instead of running 5s.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      }),
    );
    const entities = await extractEntities(MSGS, "key", undefined, 10); // 10ms timeout
    expect(entities).toEqual([]);
    expect(entDropReasons()).toContain("timeout");
    // the abort signal was actually wired into the fetch
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  }, 1500);

  it("aborts a provider that sends headers then stalls the body (json read stays inside the timer)", async () => {
    // Codex caught this: clearing the timer right after fetch() leaves response.json()
    // unbounded. Here fetch resolves (headers) but the body read hangs until aborted.
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
            });
          }),
      } as unknown as Response),
    );
    const entities = await extractEntities(MSGS, "key", undefined, 10);
    expect(entities).toEqual([]);
    expect(entDropReasons()).toContain("timeout");
  }, 1500);
});

describe("extractEntities — drop observability + never-throws", () => {
  it("returns entities and emits NO drop counter on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      entResponse(JSON.stringify({ entities: [{ name: "Alice", kind: "person", context: "...", confidence: 0.95 }] })),
    );
    const entities = await extractEntities(MSGS, "key");
    expect(entities).toHaveLength(1);
    expect(entDropReasons()).toEqual([]);
  });

  it("a fetch rejection returns [] (never-throws) and records reason=fetch_error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    await expect(extractEntities(MSGS, "key")).resolves.toEqual([]);
    expect(entDropReasons()).toContain("fetch_error");
  });

  it("non-OK response returns [] and records reason=http_not_ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const entities = await extractEntities(MSGS, "key");
    expect(entities).toEqual([]);
    expect(entDropReasons()).toContain("http_not_ok");
  });

  it("a malformed HTTP body (response.json throws) returns [] and records reason=http_json_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad");
      },
    } as unknown as Response);
    await expect(extractEntities(MSGS, "key")).resolves.toEqual([]);
    expect(entDropReasons()).toContain("http_json_error");
  });

  it("a null JSON body returns [] (never-throws, null-safe data?.choices) and records parse_error", async () => {
    // null data → data?.choices is undefined → text="" → JSON.parse("") throws.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => null,
    } as unknown as Response);
    await expect(extractEntities(MSGS, "key")).resolves.toEqual([]);
    expect(entDropReasons()).toContain("parse_error");
  });

  it("non-JSON content records reason=parse_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(entResponse("not json at all"));
    const entities = await extractEntities(MSGS, "key");
    expect(entities).toEqual([]);
    expect(entDropReasons()).toContain("parse_error");
  });

  it("valid JSON with non-array entities records reason=bad_root_shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(entResponse(JSON.stringify({ entities: "nope" })));
    const entities = await extractEntities(MSGS, "key");
    expect(entities).toEqual([]);
    expect(entDropReasons()).toContain("bad_root_shape");
  });

  it("per-element isolation: a null entity element does not collapse the batch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      entResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: 0.95 },
            null,
            { name: "Acme", kind: "org", context: "...", confidence: 0.9 },
          ],
        }),
      ),
    );
    const entities = await extractEntities(MSGS, "key");
    expect(entities).toHaveLength(2);
    expect(entities.map((e) => e.name)).toEqual(["Alice", "Acme"]);
  });

  it("per-element isolation: a primitive element is skipped (not pushed as garbage)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      entResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: 0.95 },
            42,
            "not an entity",
            { name: "Acme", kind: "org", context: "...", confidence: 0.9 },
          ],
        }),
      ),
    );
    const entities = await extractEntities(MSGS, "key");
    expect(entities).toHaveLength(2);
    expect(entities.every((e) => typeof e === "object" && typeof e.name === "string")).toBe(true);
  });

  it("a throwing counter sink does not break the [] fallback", async () => {
    setCounterEmitter({
      emit: () => {
        throw new Error("sink failed");
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(entResponse("not json"));
    await expect(extractEntities(MSGS, "key")).resolves.toEqual([]);
  });
});
