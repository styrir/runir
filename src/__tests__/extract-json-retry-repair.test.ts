import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractMemories } from "../capture/extraction/capture.js";
import { setCounterEmitter, resetCounterEmitter } from "../obs/counters.js";
import { atomicFactIdentity } from "../storage/writes/referent-keys.js";

// Tests for the jsonrepair-backed retry path in extractMemories.
// The goal: on JSON.parse failure, retry ONCE with jsonrepair before
// discarding the batch. Covers the happy path (clean response = no retry),
// control-char recovery, fenced responses, truly-malformed garbage, and
// malformations the old hand-rolled walker could NOT fix (trailing comma).

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MSGS = [{ role: "user" as const, content: "hi there" }];
const ENV_KEYS = ["RUNIR_EXTRACTOR_MODEL", "RUNIR_EXTRACTOR_SEED", "RUNIR_EXTRACTOR_JSON_MODE"];
const SAVED: Record<string, string | undefined> = {};

let captured: string[] = [];
let restoreEmitter: () => void;

function droppedReasons(): string[] {
  return captured
    .filter((l) => l.includes("metric=capture_batch_dropped") && l.includes("stage=extract"))
    .map((l) => {
      const m = l.match(/reason=(\S+)/);
      return m ? m[1] : "";
    });
}

function repairedLabels(): string[] {
  return captured.filter((l) => l.includes("metric=extract_batch_repaired"));
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

// ---------------------------------------------------------------------------
// extractMemories — jsonrepair retry wiring
// ---------------------------------------------------------------------------

describe("extractMemories — jsonrepair retry wiring", () => {
  it("recovers facts from a response with a raw newline inside a string literal (repair counter, no drop counter)", async () => {
    // Simulate the haiku-4-5 failure: content has a raw newline inside a JSON string.
    const rawContent =
      '{"facts":[{"l2":"the user is building Runir\nwhich stores memories in SurrealDB","confidence":0.95}]}';
    // Confirm it breaks vanilla JSON.parse.
    expect(() => JSON.parse(rawContent)).toThrow();

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: rawContent } }] }),
    } as unknown as Response);

    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.l2).toContain("Runir");
    expect(droppedReasons()).toEqual([]);
    expect(repairedLabels()).toHaveLength(1);
    expect(repairedLabels()[0]).toContain("reason=json_repaired");
  });

  it("recovers facts from a fenced response with a raw control char inside a string", async () => {
    // Fenced wrapper — the fence-strip path runs first, then the repair retry.
    const rawContent =
      '```json\n{"facts":[{"l2":"user likes TypeScript\nand uses SurrealDB","confidence":0.9}]}\n```';

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: rawContent } }] }),
    } as unknown as Response);

    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.l2).toContain("TypeScript");
    expect(droppedReasons()).toEqual([]);
    expect(repairedLabels()).toHaveLength(1);
  });

  it("still drops and records parse_error when repair also fails (truly malformed JSON)", async () => {
    // Completely broken JSON that jsonrepair cannot reconstruct.
    const rawContent = "not json at all { unclosed [[[";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: rawContent } }] }),
    } as unknown as Response);

    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toEqual([]);
    expect(droppedReasons()).toContain("parse_error");
    // No repair counter — repair also failed.
    expect(repairedLabels()).toHaveLength(0);
  });

  it("zero counters for clean responses — no repair counter, no drop counter", async () => {
    const rawContent = '{"facts":[{"l2":"Runir stores memories in SurrealDB.","confidence":0.95}]}';
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: rawContent } }] }),
    } as unknown as Response);

    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(1);
    expect(droppedReasons()).toEqual([]);
    expect(repairedLabels()).toHaveLength(0);
  });

  it("recovers a trailing-comma malformation that the old hand-rolled walker could NOT fix", async () => {
    // A trailing comma before } is a common LLM output defect that the old
    // state-machine walker only fixed control chars, not structural JSON faults.
    // jsonrepair handles trailing commas natively.
    const rawContent = '{"facts":[{"l2":"user prefers dark mode","confidence":0.9,}]}';
    expect(() => JSON.parse(rawContent)).toThrow();

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: rawContent } }] }),
    } as unknown as Response);

    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.l2).toContain("dark mode");
    expect(droppedReasons()).toEqual([]);
    expect(repairedLabels()).toHaveLength(1);
    expect(repairedLabels()[0]).toContain("reason=json_repaired");
  });

  // A3 — real jsonrepair path preserves complete atomicFact (Rúnir-h435.2 Unit A)
  // Mock surface: ONLY global.fetch + existing counter emitter. Never mock jsonrepair.
  it("A3: jsonrepair recovers complete atomicFact triple with proof-ready identity", async () => {
    // Trailing comma after atomicFact object — vanilla JSON.parse fails; production repair succeeds.
    const rawContent =
      '{"facts":[{"l2":"Update: prototype uses Dragonfly instead of Redis.","l0":"Prototype: Dragonfly","l1":"## State\\nDragonfly","confidence":0.95,"source_turn_index":0,"category":"entities","tier":"durable","tags":["update"],"atomicFact":{"subject":"prototype","predicate":"uses_database","value":"dragonfly"},}]}';
    expect(() => JSON.parse(rawContent)).toThrow();

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: rawContent } }] }),
    } as unknown as Response);

    const facts = await extractMemories(MSGS, "prompt", "key");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.atomicFact).toEqual({
      subject: "prototype",
      predicate: "uses_database",
      value: "dragonfly",
    });
    expect(atomicFactIdentity(facts[0]!.atomicFact)).toBe("prototype|uses_database");
    // Existing repair telemetry remains green
    expect(droppedReasons()).toEqual([]);
    expect(repairedLabels()).toHaveLength(1);
    expect(repairedLabels()[0]).toContain("reason=json_repaired");
  });
});