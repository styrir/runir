import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractMemories } from "../capture/extraction/capture.js";
import { setCounterEmitter, resetCounterEmitter } from "../obs/counters.js";

// Iter-3 extractor hardening: structured-output (json_object) JSON mode + drop
// observability. See docs/handoffs/2026-06-01-session-handoff-compaction.md
// follow-up #2 and the Codex critic review
// (.omc/artifacts/ask/codex-...2026-06-01T03-55-15*.md): gate response_format
// AND provider.require_parameters together behind a model-capability check, and
// make every silent batch-drop observable through the recordCounter seam.

const MSGS = [{ role: "user" as const, content: "hi there, some content to extract" }];
const ENV_KEYS = ["RUNIR_EXTRACTOR_MODEL", "RUNIR_EXTRACTOR_SEED", "RUNIR_EXTRACTOR_JSON_MODE"];
const SAVED: Record<string, string | undefined> = {};

let captured: string[] = [];
let restoreEmitter: () => void;

function okEmptyFacts(): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] }),
  } as unknown as Response;
}

function bodyOf(spy: ReturnType<typeof vi.spyOn>): any {
  return JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
}

function droppedReasons(): string[] {
  return captured
    .filter((l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=extract"))
    .map((l) => {
      const m = l.match(/reason=(\S+)/);
      return m ? m[1] : "";
    });
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  // Deterministic baseline: no extractor env overrides unless a test sets them.
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

describe("extractMemories — JSON-mode capability gating", () => {
  it("default Gemini 3.1 model omits response_format and provider.require_parameters", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEmptyFacts());
    await extractMemories(MSGS, "prompt", "key");
    const body = bodyOf(spy);
    expect(body.model).toBe("vertex/gemini-3.1-flash-lite@us");
    expect(body.response_format).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  it("explicit openai override still sends JSON mode (no provider field)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEmptyFacts());
    await extractMemories(MSGS, "prompt", "key", undefined, undefined, { model: "openai/gpt-5.5" });
    const body = bodyOf(spy);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.provider).toBeUndefined();
  });

  it("Anthropic override does NOT send response_format/provider (prompt-only fallback)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEmptyFacts());
    await extractMemories(MSGS, "prompt", "key", undefined, undefined, {
      model: "anthropic/claude-sonnet-4.6",
    });
    const body = bodyOf(spy);
    expect(body.response_format).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  it("Gemini override is OFF by default, but RUNIR_EXTRACTOR_JSON_MODE=1 forces it on", async () => {
    const spyOff = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEmptyFacts());
    await extractMemories(MSGS, "prompt", "key", undefined, undefined, { model: "google/gemini-3-flash" });
    expect(bodyOf(spyOff).response_format).toBeUndefined();

    vi.restoreAllMocks();
    process.env.RUNIR_EXTRACTOR_JSON_MODE = "1";
    const spyOn = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEmptyFacts());
    await extractMemories(MSGS, "prompt", "key", undefined, undefined, { model: "google/gemini-3-flash" });
    const body = bodyOf(spyOn);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.provider).toBeUndefined();
  });

  it("openai gpt-oss / :free variants are excluded from auto JSON mode (no response_format support)", async () => {
    for (const m of ["openai/gpt-oss-120b:free", "openai/gpt-oss-20b", "openai/gpt-4o-mini:free"]) {
      vi.restoreAllMocks();
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEmptyFacts());
      await extractMemories(MSGS, "prompt", "key", undefined, undefined, { model: m });
      expect(bodyOf(spy).response_format, `expected no json mode for ${m}`).toBeUndefined();
    }
  });

  it("RUNIR_EXTRACTOR_JSON_MODE=0 force-disables JSON mode", async () => {
    process.env.RUNIR_EXTRACTOR_JSON_MODE = "0";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEmptyFacts());
    await extractMemories(MSGS, "prompt", "key");
    const body = bodyOf(spy);
    expect(body.response_format).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  it('RUNIR_EXTRACTOR_SEED="" omits seed and leaves Gemini default JSON mode off', async () => {
    process.env.RUNIR_EXTRACTOR_SEED = "";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEmptyFacts());
    await extractMemories(MSGS, "prompt", "key");
    const body = bodyOf(spy);
    expect(body.seed).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });
});

describe("extractMemories — drop observability (recordCounter)", () => {
  it("non-OK response returns [] and records reason=http_not_ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
    expect(droppedReasons()).toContain("http_not_ok");
    const line = captured.find((l) => l.includes("reason=http_not_ok"));
    expect(line).toContain("status=503");
  });

  it("malformed HTTP JSON (response.json throws) returns [] (never-throws) and records reason=http_json_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);
    // Must RESOLVE to [], not reject — the never-throws contract (Rúnir-sm9k.3).
    await expect(extractMemories(MSGS, "prompt", "key")).resolves.toEqual([]);
    expect(droppedReasons()).toContain("http_json_error");
  });

  it("content JSON parse failure returns [] and records reason=parse_error", async () => {
    // Use input that is unrepairable even by jsonrepair (mismatched braces with
    // an unterminated string — JSONRepairError propagates to the outer catch).
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '}{facts"' } }] }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
    expect(droppedReasons()).toContain("parse_error");
  });

  it("valid JSON with non-array facts returns [] and records reason=bad_root_shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: "not array" }) } }] }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
    expect(droppedReasons()).toContain("bad_root_shape");
  });

  it("drop counter carries the resolved model label", async () => {
    // Unrepairable input ensures a drop counter fires (regardless of reason).
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '}{boom"' } }] }),
    } as unknown as Response);
    await extractMemories(MSGS, "prompt", "key");
    const dropLine = captured.find((l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=extract"));
    expect(dropLine).toBeDefined();
    expect(dropLine).toContain("model=vertex/gemini-3.1-flash-lite@us");
  });

  it("AbortError (timeout) returns [] and records reason=timeout", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
    expect(droppedReasons()).toContain("timeout");
  });

  it("generic fetch rejection returns [] and records reason=fetch_error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
    expect(droppedReasons()).toContain("fetch_error");
  });

  it("propagates finish_reason=length on a truncated parse failure", async () => {
    // Use an input that is unrepairable even by jsonrepair so parse_error fires.
    // A leading } before facts content causes JSONRepairError, simulating a
    // mid-structure truncation where the model was cut off at the wrong boundary.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '}{"facts":[{"l2":"trunc' }, finish_reason: "length" }],
      }),
    } as unknown as Response);
    await extractMemories(MSGS, "prompt", "key");
    const dropLine = captured.find((l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=extract"));
    expect(dropLine).toBeDefined();
    expect(dropLine).toContain("reason=parse_error");
    expect(dropLine).toContain("finish_reason=length");
  });

  it("a throwing counter sink does NOT break the never-throws contract", async () => {
    // Override the capturing emitter with one that throws (e.g. stderr EPIPE).
    setCounterEmitter({
      emit: () => {
        throw new Error("sink failed");
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not json" } }] }),
    } as unknown as Response);
    await expect(extractMemories(MSGS, "prompt", "key")).resolves.toEqual([]);
  });

  it("a malformed fact element ({facts:[null]}) is filtered (not a batch-collapsing throw) and counted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: [null] }) } }] }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
    const line = captured.find((l) => l.includes("reason=malformed_fact_element"));
    expect(line).toBeDefined();
    expect(line).toContain("dropped=1");
    // The element is filtered up front, so it must NOT reach the stage-guard backstop.
    expect(droppedReasons()).not.toContain("post_parse_error");
  });

  it("per-fact isolation: good siblings survive a malformed middle element", async () => {
    const facts1 = { l2: "The user's project Runir stores memories in SurrealDB.", confidence: 0.95 };
    const facts2 = { l2: "Runir capture extraction uses vertex/gemini-3.1-flash-lite@us.", confidence: 0.93 };
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ facts: [facts1, null, facts2] }) } }],
      }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.l2)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SurrealDB"),
        expect.stringContaining("gemini-3.1-flash-lite"),
      ]),
    );
    const line = captured.find((l) => l.includes("reason=malformed_fact_element"));
    expect(line).toContain("dropped=1");
    expect(droppedReasons()).not.toContain("post_parse_error");
  });

  it("null/primitive fact elements (the phase-1 throwers) are filtered at the boundary and counted", async () => {
    // Only null/primitives throw in the stamping loop and must be dropped up
    // front. Object/array elements survive stamping and are left to the existing
    // per-fact normalize guard (Rúnir-sm9k.3), so they are NOT boundary-dropped.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ facts: [42, false, null] }) } }],
      }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
    const line = captured.find((l) => l.includes("reason=malformed_fact_element"));
    expect(line).toContain("dropped=3");
    expect(droppedReasons()).not.toContain("post_parse_error");
  });

  it("a null JSON body (response.json() resolves null) returns [] (never-throws) and records a drop", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => null,
    } as unknown as Response);
    await expect(extractMemories(MSGS, "prompt", "key")).resolves.toEqual([]);
    expect(droppedReasons().length).toBeGreaterThan(0);
  });

  it("a successful extraction emits ZERO drop counters", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ facts: [{ l2: "a real fact about Runir", confidence: 0.9 }] }) } }],
      }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts.length).toBeGreaterThan(0);
    expect(droppedReasons()).toEqual([]);
  });

  it("an unsafe model label (whitespace/=) is sanitized to model=unknown", async () => {
    process.env.RUNIR_EXTRACTOR_MODEL = "weird model=bad";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not json" } }] }),
    } as unknown as Response);
    await extractMemories(MSGS, "prompt", "key");
    const line = captured.find((l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=extract"));
    expect(line).toBeDefined();
    expect(line).toContain("model=unknown");
    expect(line).not.toContain("weird model");
  });
});

describe("extractMemories — confidence type safety (no non-number escapes)", () => {
  it("a string confidence ('high') is coerced to a finite number, never escapes as a string", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ facts: [{ l2: "Runir stores memories in SurrealDB.", confidence: "high" }] }) } }],
      }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(1);
    expect(typeof facts[0].confidence).toBe("number");
    expect(Number.isFinite(facts[0].confidence)).toBe(true);
  });

  it("a missing confidence yields a finite numeric confidence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ facts: [{ l2: "Runir capture extraction runs on vertex/gemini-3.1-flash-lite@us." }] }) } }],
      }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(1);
    expect(typeof facts[0].confidence).toBe("number");
    expect(Number.isFinite(facts[0].confidence)).toBe(true);
  });

  it("a numeric-string confidence ('0.92') is salvaged to its number", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ facts: [{ l2: "Runir uses nomic-embed-text for embeddings.", confidence: "0.92" }] }) } }],
      }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(1);
    expect(facts[0].confidence).toBeCloseTo(0.92, 5);
  });

  it("a null confidence is filtered by the threshold gate (does not escape)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ facts: [{ l2: "Runir null-confidence fact.", confidence: null }] }) } }],
      }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
  });
});

describe("extractMemories — max_tokens ceiling-hit observability (extraction-robustness)", () => {
  // The 4096->8192 bump (2026-06-13) cleared the OBSERVED truncations, but
  // "is 8192 high enough?" can only be answered if every ceiling-hit is
  // counted — including the ones jsonrepair salvages, which the drop counters
  // never saw. recordCeilingHit makes the truncation rate + size measurable.
  function truncationLines(): string[] {
    return captured.filter((l) => l.includes("metric=extract_response_truncated"));
  }

  it("emits extract_response_truncated on finish_reason='length' even when the JSON still parses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: JSON.stringify({ facts: [{ l2: "Runir bumped the extractor ceiling to 8192 tokens.", confidence: 0.9 }] }) },
          finish_reason: "length",
        }],
        usage: { completion_tokens: 8192 },
      }),
    } as unknown as Response);
    const facts = await extractMemories(MSGS, "prompt", "key");
    // The batch still parsed (fact survives) — but the ceiling-hit is now visible.
    expect(facts).toHaveLength(1);
    const lines = truncationLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("stage=extract");
    expect(lines[0]).toContain("completion_tokens=8192");
    expect(lines[0]).toMatch(/max_tokens=\d+/);
  });

  it("does NOT emit the counter on a normal finish_reason='stop'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: JSON.stringify({ facts: [{ l2: "A normal complete extraction response here.", confidence: 0.9 }] }) },
          finish_reason: "stop",
        }],
        usage: { completion_tokens: 120 },
      }),
    } as unknown as Response);
    await extractMemories(MSGS, "prompt", "key");
    expect(truncationLines()).toHaveLength(0);
  });
});
