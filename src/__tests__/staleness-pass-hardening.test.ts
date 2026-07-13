import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same dependency mocks as staleness-pass.test.ts so runStalenessCoreNoLock
// reaches the LLM call deterministically.
vi.mock("../lifecycle/semion/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  writeStalenessBacklog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../storage/surreal/surreal-store.js", () => ({
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: vi.fn(),
  extractId: vi.fn((id: unknown) => String(id).replace(/^[^:]+:/, "").replace(/[⟨⟩]/g, "")),
}));
vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));
vi.mock("../storage/writes/write-arbitrator.js", () => ({
  deriveStatementKey: vi.fn().mockImplementation((text: string) => text),
}));

import { runStalenessCoreNoLock } from "../lifecycle/semion/staleness-pass.js";
import { setCounterEmitter, resetCounterEmitter } from "../obs/counters.js";

const ENV_KEYS = ["RUNIR_EXTRACTOR_JSON_MODE"];
const SAVED: Record<string, string | undefined> = {};
let captured: string[] = [];
let restoreEmitter: () => void;

const BASE_OPTS = {
  userId: "user-1",
  scope: "user" as const,
  sessionId: "sess-1",
  facts: [{ text: "Server runs on port 7700", confidence: 0.9, replacementMemoryId: "mem:new1" }],
  apiKey: "test-key",
  embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
  logger: vi.fn(),
};

/** db whose first (bm25) query returns one candidate so the LLM call runs. */
function dbWithCandidate() {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce([[{ id: "old-1", text: "old fact", userId: "user-1", scope: "user" }]])
      .mockResolvedValue([[]]),
  };
}

function stalenessDropReasons(): string[] {
  return captured
    .filter((l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=staleness"))
    .map((l) => (l.match(/reason=(\S+)/) ?? [])[1] ?? "");
}

function stalenessDropCount(reason: string): number {
  return captured.filter(
    (l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=staleness") && l.includes(`reason=${reason}`),
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  captured = [];
  restoreEmitter = setCounterEmitter({ emit: (l) => captured.push(l) });
});

afterEach(() => {
  restoreEmitter();
  resetCounterEmitter();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
});

describe("runStalenessCoreNoLock — JSON-mode gating", () => {
  it("sends response_format json_object (model is openai/*)", async () => {
    // The default staleness model is flash-lite (non-openai → gated off);
    // pin an openai/* model to exercise the json-mode branch.
    process.env.RUNIR_STALENESS_MODEL = "openai/gpt-5.4-mini";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ stale: [] }) } }] }),
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    } finally {
      delete process.env.RUNIR_STALENESS_MODEL;
    }
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("openai/gpt-5.4-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("RUNIR_EXTRACTOR_JSON_MODE=0 disables json mode", async () => {
    process.env.RUNIR_EXTRACTOR_JSON_MODE = "0";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ stale: [] }) } }] }),
    });
    vi.stubGlobal("fetch", mockFetch);
    await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).response_format).toBeUndefined();
  });
});

describe("runStalenessCoreNoLock — drop observability + never-throws", () => {
  it("a fetch rejection does not throw and records reason=fetch_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("fetch_error")).toBe(1);
  });

  it("non-OK response records reason=http_not_ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("http_not_ok")).toBe(1);
  });

  it("a malformed HTTP body (response.json throws) records reason=http_json_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("bad");
        },
      }),
    );
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("http_json_error")).toBe(1);
  });

  it("a null JSON body does not throw (null-safe body?.choices) and records invalid_json", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => null }));
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("invalid_json")).toBe(1);
  });

  it("content that does not contain {stale:[]} records reason=invalid_json", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "totally not json" } }] }),
      }),
    );
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("invalid_json")).toBe(1);
  });

  it("a non-string message.content does NOT throw (coerced) and records invalid_json", async () => {
    // content is an object — `?? "{}"` would NOT catch it, and parseStalenessEntries'
    // text.trim() would throw out of the staleness pass.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: { stale: [] } } }] }),
      }),
    );
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("invalid_json")).toBe(1);
  });

  it("a throwing counter sink does not break the staleness pass", async () => {
    setCounterEmitter({
      emit: () => {
        throw new Error("sink failed");
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
  });

  it("a null entry in a valid stale array does NOT throw and records malformed_entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ stale: [null] }) } }] }),
      }),
    );
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("malformed_entry")).toBe(1);
  });

  it("per-entry isolation: a valid stale entry survives a malformed sibling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  stale: [null, { existingId: "old-1", reason: "outdated", supersededByNewFactIndex: 0 }],
                }),
              },
            },
          ],
        }),
      }),
    );
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(1);
    expect(stalenessDropCount("malformed_entry")).toBe(1);
  });

  it("a non-integer supersededByNewFactIndex (array-property like 'length') does NOT throw and records malformed_entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  stale: [{ existingId: "old-1", reason: "bad index", supersededByNewFactIndex: "length" }],
                }),
              },
            },
          ],
        }),
      }),
    );
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("malformed_entry")).toBe(1);
  });

  it("a non-string existingId (e.g. an array) does NOT throw and records malformed_entry", async () => {
    // String(["old-1"]) === "old-1" so it would pass the candidate lookup, but
    // the raw array would reach the DB write { id: ["old-1"] } and throw.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  stale: [{ existingId: ["old-1"], reason: "array id", supersededByNewFactIndex: 0 }],
                }),
              },
            },
          ],
        }),
      }),
    );
    const result = await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(result.superseded).toBe(0);
    expect(stalenessDropCount("malformed_entry")).toBe(1);
  });

  it("a successful staleness response emits NO drop counter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ stale: [] }) } }] }),
      }),
    );
    await runStalenessCoreNoLock({ ...BASE_OPTS, db: dbWithCandidate() as any });
    expect(stalenessDropReasons()).toEqual([]);
  });
});
