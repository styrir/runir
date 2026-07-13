import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractMemories, normalizeExtractedFact } from "../capture/extraction/capture.js";
import { DEFAULT_CAPTURE_PROMPT } from "../domain/memory/types.js";
import { atomicFactIdentity } from "../storage/writes/referent-keys.js";
import { unifiedExtractionFixtures } from "./fixtures/unified-extraction-fixtures.js";

type MockLLMFact = {
  l2: string;
  confidence: number;
  l0?: string;
  l1?: string;
  category?: string;
  tier?: string;
  tags?: string[];
  source_turn_index?: unknown;
  raw_source_text?: string;
  atomicFact?: unknown;
};

function makeOpenRouterResponse(facts: MockLLMFact[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ facts }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Extract the first Output: blob after a marker. Few-shot JSON in the prompt
 * template may contain real newlines (from `\\n` in the template literal), so
 * we do not full-JSON.parse the envelope — we slice the Output blob through
 * the matching top-level close brace.
 */
function fewShotOutputBlobAfter(marker: string): string {
  const idx = DEFAULT_CAPTURE_PROMPT.indexOf(marker);
  expect(idx).toBeGreaterThanOrEqual(0);
  const after = DEFAULT_CAPTURE_PROMPT.slice(idx);
  const outIdx = after.indexOf("Output: ");
  expect(outIdx).toBeGreaterThanOrEqual(0);
  const jsonStart = after.indexOf("{", outIdx);
  expect(jsonStart).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = -1;
  for (let i = jsonStart; i < after.length; i++) {
    const ch = after[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(jsonStart);
  return after.slice(jsonStart, end);
}

describe("DEFAULT_CAPTURE_PROMPT — unified production contract", () => {
  it("keeps Runir's current object schema while adding unified memory guidance", () => {
    expect(DEFAULT_CAPTURE_PROMPT).toContain("Runir's production memory extractor");
    expect(DEFAULT_CAPTURE_PROMPT).toContain('"facts"');
    expect(DEFAULT_CAPTURE_PROMPT).toContain("Never return a bare JSON array");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("l2");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("l0");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("l1");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("source_turn_index is REQUIRED");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("MUST be a single number");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("speaker:user");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("owner:user");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("subject:runir");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("type::record($id)");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("When in doubt, abstain unless future utility is clear");

    expect(DEFAULT_CAPTURE_PROMPT).toContain("Never use l0_narrative, l1_narrative, or l2_narrative");
    expect(DEFAULT_CAPTURE_PROMPT).not.toContain("source_turn_index\": number | number[]");
    expect(DEFAULT_CAPTURE_PROMPT).not.toContain("When in doubt, extract MORE");
  });

  // A1 — prompt text seam: real DEFAULT_CAPTURE_PROMPT, no mocks (Rúnir-h435.2 Unit A)
  it("A1: atomicFact REQUIRED-WHEN-SLOT-SHAPED contract, Dragonfly triple, omission few-shot, REMEMBER emit/omit", () => {
    // 1) Required semantics present
    expect(DEFAULT_CAPTURE_PROMPT).toContain("REQUIRED-WHEN-SLOT-SHAPED");
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(/stable SLOT OWNER/i);
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(/complete triple/i);
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(/narrative.*event.*case/i);
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(/Never invent a slot|never invent a slot|never invent/i);
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(/lowercase snake_case/i);
    expect(DEFAULT_CAPTURE_PROMPT).toContain("uses_database");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("runs_on");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("listens_on");
    expect(DEFAULT_CAPTURE_PROMPT).toContain("prefers_editor");
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(/NON-CLOSED|not an ontology|not closed/i);
    // Predicate stability under paraphrase (h435.2 measure residual)
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(/Slot stability under paraphrase/i);
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(
      /Datastore.*uses_database|uses_database.*Datastore|primary store.*uses_database/i,
    );
    expect(DEFAULT_CAPTURE_PROMPT).toMatch(/KEEP the same subject and the same predicate/i);

    // 2) Old optional-only wording gone / cannot contradict the new rule
    expect(DEFAULT_CAPTURE_PROMPT).not.toContain(
      "atomicFact/event: Optional structured slots for the primary subject/predicate/value",
    );
    expect(DEFAULT_CAPTURE_PROMPT).not.toContain('"atomicFact": optional object,');

    // 3) Dragonfly few-shot: exact compact triple + parsed object equality
    const dragonflyOut = fewShotOutputBlobAfter(
      "Dragonfly is the replacement because the latency profile is better.",
    );
    const exactTripleLiteral =
      '"atomicFact":{"subject":"prototype","predicate":"uses_database","value":"dragonfly"}';
    expect(dragonflyOut).toContain(exactTripleLiteral);
    const tripleMatch = dragonflyOut.match(
      /"atomicFact"\s*:\s*(\{"subject":"prototype","predicate":"uses_database","value":"dragonfly"\})/,
    );
    expect(tripleMatch).not.toBeNull();
    expect(JSON.parse(tripleMatch![1]!)).toEqual({
      subject: "prototype",
      predicate: "uses_database",
      value: "dragonfly",
    });

    // 4) Explicit event omission few-shot: no own atomicFact key on that output
    const rokidOut = fewShotOutputBlobAfter(
      "Yesterday I sent Rokid my Tallinn address and asked them to ship the glasses ASAP",
    );
    expect(rokidOut).toContain('"category": "events"');
    expect(rokidOut).not.toMatch(/"atomicFact"\s*:/);

    // 5) REMEMBER lists atomicFact + emit/omit rule
    const rememberIdx = DEFAULT_CAPTURE_PROMPT.indexOf("REMEMBER");
    expect(rememberIdx).toBeGreaterThanOrEqual(0);
    const remember = DEFAULT_CAPTURE_PROMPT.slice(rememberIdx);
    expect(remember).toContain("atomicFact");
    expect(remember).toContain("REQUIRED-WHEN-SLOT-SHAPED");
    expect(remember).toMatch(/omit the atomicFact key|omit the key/i);
  });
});
describe("unified extraction fixture artifact", () => {
  it("covers the full production-domain fixture matrix", () => {
    expect(unifiedExtractionFixtures).toHaveLength(15);

    const ids = new Set<string>();
    for (const fixture of unifiedExtractionFixtures) {
      expect(ids.has(fixture.id)).toBe(false);
      ids.add(fixture.id);
      expect(fixture.description.length).toBeGreaterThan(20);
      expect(fixture.messages.length).toBeGreaterThan(0);

      if (fixture.expected.sourceTurnIndex !== undefined) {
        expect(typeof fixture.expected.sourceTurnIndex).toBe("number");
      }
    }
  });

  it("includes abstention and non-abstention cases", () => {
    const abstentions = unifiedExtractionFixtures.filter((fixture) => fixture.expected.abstains);
    const stored = unifiedExtractionFixtures.filter((fixture) => !fixture.expected.abstains);

    expect(abstentions.length).toBeGreaterThanOrEqual(2);
    expect(stored.length).toBeGreaterThan(10);
  });
});

describe("extractMemories — unified fixture parser/post-processing behavior", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a mixed developer + personal extraction without schema migration", async () => {
    const fixture = unifiedExtractionFixtures.find((candidate) => candidate.id === "mixed-developer-personal");
    expect(fixture).toBeDefined();
    if (!fixture) return;

    fetchMock.mockResolvedValue(
      makeOpenRouterResponse([
        {
          l2: "User stated a Runir project constraint: the memory extractor must preserve exact SurrealQL snippets rather than paraphrasing them away.",
          l0: "Runir extractor: preserve exact SurrealQL snippets",
          l1: "## Project Constraint\nRunir extractor must preserve exact SurrealQL snippets.",
          confidence: 0.95,
          source_turn_index: 0,
          category: "patterns",
          tier: "durable",
          tags: ["speaker:user", "owner:project", "subject:runir", "surrealql", "technical"],
        },
        {
          l2: "User stated a personal planning preference: they hate 90-day/calendar-style plans and prefer agentic non-calendar planning instead.",
          l0: "Planning preference: no 90-day calendar plans",
          l1: "## Preference\n- Avoid 90-day/calendar-style plans\n- Prefer agentic non-calendar planning",
          confidence: 0.95,
          source_turn_index: 0,
          category: "preferences",
          tier: "durable",
          tags: ["speaker:user", "owner:user", "planning", "negative", "do_not"],
        },
      ]),
    );

    const facts = await extractMemories(
      fixture.messages,
      DEFAULT_CAPTURE_PROMPT,
      "test-api-key",
      "2026-05-19T12:00:00.000Z",
    );

    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.category).sort()).toEqual(["patterns", "preferences"]);
    expect(facts.some((fact) => fact.tags.includes("subject:runir"))).toBe(true);
    expect(facts.some((fact) => fact.tags.includes("owner:user"))).toBe(true);
    expect(facts.every((fact) => fact.l0.length > 0 && fact.l1.length > 0)).toBe(true);
  });

  it("does not trust model-emitted raw_source_text or array source_turn_index", async () => {
    fetchMock.mockResolvedValue(
      makeOpenRouterResponse([
        {
          l2: "User wants Rokid shipping to use the Tallinn address supplied earlier.",
          l0: "Rokid shipping: use user's Tallinn address",
          l1: "## Current Instruction\nUse the Tallinn address for Rokid shipping.",
          confidence: 0.95,
          source_turn_index: [0, 1],
          raw_source_text: "LLM-emitted source text must not be trusted",
          category: "events",
          tags: ["speaker:user", "owner:user", "subject:rokid", "support:prior_address"],
        },
      ]),
    );

    const facts = await extractMemories(
      [
        { role: "user", content: "My Estonian address is Test Fixture, 123 Memory Lane, Unit 7, 10133 Tallinn, Estonia." },
        { role: "user", content: "Use my Tallinn address for Rokid shipping." },
      ],
      DEFAULT_CAPTURE_PROMPT,
      "test-api-key",
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]?.raw_source_text).toBeUndefined();
    expect(facts[0]?.tags).toContain("support:prior_address");
  });

  it("survives a poison fact during normalization and warns instead of dropping the whole batch (Rúnir-sm9k.3)", async () => {
    // A single malformed fact (non-string l2 → normalizeExtractedFact throws at
    // raw.l2.slice) used to propagate to the bare `catch { return []; }`,
    // silently discarding EVERY fact for the capture with zero telemetry. After
    // the hardening, the bad fact is logged-and-skipped per-fact and the two
    // good facts survive.
    fetchMock.mockResolvedValue(
      makeOpenRouterResponse([
        {
          l2: "User prefers tabs over spaces for indentation.",
          l0: "good-1",
          confidence: 0.95,
          source_turn_index: 0,
          category: "preferences",
        },
        {
          // Non-string l2 makes normalizeExtractedFact throw at raw.l2.slice(0,100)
          // (capture.ts) while still clearing the confidence gate.
          l2: 12345 as unknown as string,
          confidence: 0.95,
          source_turn_index: 0,
          category: "preferences",
        },
        {
          l2: "User prefers dark mode in the editor.",
          l0: "good-2",
          confidence: 0.95,
          source_turn_index: 0,
          category: "preferences",
        },
      ]),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onReject = vi.fn();

    const facts = await extractMemories(
      [{ role: "user", content: "I prefer tabs and dark mode." }],
      DEFAULT_CAPTURE_PROMPT,
      "test-api-key",
      undefined,
      onReject,
    );

    // The two good facts survive; the poison fact is skipped, not the batch.
    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.l0)).toEqual(
      expect.arrayContaining(["good-1", "good-2"]),
    );
    // The skip is observable (no more silent total-swallow).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipped malformed fact during normalization"),
    );
    expect(onReject).toHaveBeenCalledWith(expect.anything(), "normalize-throw");

    warnSpy.mockRestore();
  });

  it("returns [] without throwing when the LLM content is non-string (Rúnir-sm9k.3)", async () => {
    // A malformed provider response can put a non-string in message.content.
    // extractMemories must coerce and return [] — never throw out of the
    // function (the JSON-parse catch logs text.slice, which would itself throw
    // on a non-string before the fix).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 42 } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const facts = await extractMemories(
      [{ role: "user", content: "hi" }],
      DEFAULT_CAPTURE_PROMPT,
      "test-api-key",
    );

    expect(facts).toEqual([]);
    warnSpy.mockRestore();
  });

  it("returns [] without throwing when the response parses to top-level null (Rúnir-sm9k.3)", async () => {
    // content === "null" → JSON.parse yields top-level null; reading .facts off
    // it must not throw out of extractMemories.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "null" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const facts = await extractMemories(
      [{ role: "user", content: "hi" }],
      DEFAULT_CAPTURE_PROMPT,
      "test-api-key",
    );

    expect(facts).toEqual([]);
  });

  // A2 — real clean parser/normalizer: mock ONLY global.fetch (Rúnir-h435.2 Unit A)
  it("A2: complete atomicFact survives byte-for-byte; omission stays undefined; real atomicFactIdentity", async () => {
    const completeTriple = {
      subject: "prototype",
      predicate: "uses_database",
      value: "dragonfly",
    };
    fetchMock.mockResolvedValue(
      makeOpenRouterResponse([
        {
          l2: "Update: The project no longer uses Redis for the prototype. Dragonfly replaced Redis.",
          l0: "Prototype storage: Dragonfly replaced Redis",
          l1: "## Current State\nDragonfly replaced Redis.",
          confidence: 0.95,
          source_turn_index: 0,
          category: "entities",
          tier: "durable",
          tags: ["speaker:user", "owner:project", "subject:redis", "subject:dragonfly", "update"],
          atomicFact: completeTriple,
        },
        {
          l2: "On 2026-05-18 (yesterday), user sent Rokid their Tallinn address for shipping.",
          l0: "Rokid shipping: Tallinn address sent",
          l1: "## Event\nUser sent Rokid their Tallinn address.",
          confidence: 0.9,
          source_turn_index: 0,
          category: "events",
          tier: "working",
          tags: ["speaker:user", "owner:user", "subject:rokid", "shipping"],
          // atomicFact key deliberately omitted
        },
      ]),
    );

    const facts = await extractMemories(
      [{ role: "user", content: "Dragonfly replaced Redis; also shipped Rokid address." }],
      DEFAULT_CAPTURE_PROMPT,
      "test-api-key",
    );

    expect(facts).toHaveLength(2);
    // Complete triple byte-for-byte on the real normalizer path
    expect(facts[0]!.atomicFact).toEqual(completeTriple);
    expect(atomicFactIdentity(facts[0]!.atomicFact)).toBe("prototype|uses_database");
    // Omission → undefined on the fact (key not present / not set)
    expect(facts[1]!.atomicFact).toBeUndefined();
    expect(atomicFactIdentity(facts[1]!.atomicFact)).toBeUndefined();
  });

  // A4 — soft-prompt safety: partial / delimiter / omission → no proof identity (Rúnir-h435.2 Unit A)
  it("A4: partial and delimiter-bearing atomicFact produce no identity; omission stays undefined", async () => {
    // Pure normalization path — no fetch required for partial/delimiter cases
    const partial = normalizeExtractedFact({
      l2: "Partial slot that is not proof-ready.",
      confidence: 0.95,
      l0: "partial",
      l1: "## Partial",
      category: "entities",
      tags: ["speaker:user"],
      atomicFact: { subject: "prototype", predicate: "uses_database" }, // missing value
    });
    expect(partial.atomicFact).toEqual({ subject: "prototype", predicate: "uses_database" });
    expect(atomicFactIdentity(partial.atomicFact)).toBeUndefined();

    const delimiterBearing = normalizeExtractedFact({
      l2: "Delimiter-bearing subject must not mint an identity.",
      confidence: 0.95,
      l0: "delimiter",
      l1: "## Delimiter",
      category: "entities",
      tags: ["speaker:user"],
      atomicFact: {
        subject: "proto|type",
        predicate: "uses_database",
        value: "dragonfly",
      },
    });
    expect(delimiterBearing.atomicFact).toEqual({
      subject: "proto|type",
      predicate: "uses_database",
      value: "dragonfly",
    });
    expect(atomicFactIdentity(delimiterBearing.atomicFact)).toBeUndefined();

    // Omission via real extractMemories (fetch mocked only)
    fetchMock.mockResolvedValue(
      makeOpenRouterResponse([
        {
          l2: "User sent Rokid a shipping update yesterday.",
          l0: "Rokid event",
          confidence: 0.9,
          source_turn_index: 0,
          category: "events",
          tags: ["speaker:user", "subject:rokid"],
        },
      ]),
    );
    const omitted = await extractMemories(
      [{ role: "user", content: "Rokid update" }],
      DEFAULT_CAPTURE_PROMPT,
      "test-api-key",
    );
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.atomicFact).toBeUndefined();
    expect(atomicFactIdentity(omitted[0]!.atomicFact)).toBeUndefined();
  });
});