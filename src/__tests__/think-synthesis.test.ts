import { describe, it, expect } from "vitest";
import { jsonrepair } from "jsonrepair";
import {
  DEFAULT_THINK_MODEL,
  buildThinkPrompt,
  parseThinkResponse,
  emptyThinkResponse,
  resolveThinkModel,
  shortId,
} from "../recall/orchestrator/think-synthesis.js";

const EVIDENCE = [
  { id: "semiote:a1b2c3d4-1111-2222-3333-444455556666", text: "User prefers terse answers." },
  { id: "semiote:⟨f9e8d7c6-aaaa-bbbb-cccc-ddddeeeeffff⟩", text: "Project uses SurrealDB." },
];

describe("resolveThinkModel", () => {
  it("defaults to GPT-5.6 Luna", () => {
    expect(DEFAULT_THINK_MODEL).toBe("openai/gpt-5.6-luna");
    expect(resolveThinkModel({})).toBe("openai/gpt-5.6-luna");
  });

  it("prefers the dedicated Think override", () => {
    expect(resolveThinkModel({
      RUNIR_THINK_MODEL: "custom/think",
      RUNIR_EXTRACTOR_MODEL: "legacy/shared",
    })).toBe("custom/think");
  });

  it("preserves the legacy shared extractor fallback", () => {
    expect(resolveThinkModel({ RUNIR_EXTRACTOR_MODEL: "legacy/shared" })).toBe("legacy/shared");
  });
});

describe("shortId", () => {
  it("strips table prefix and angle brackets, takes 8 chars", () => {
    expect(shortId(EVIDENCE[0].id)).toBe("a1b2c3d4");
    expect(shortId(EVIDENCE[1].id)).toBe("f9e8d7c6");
  });
});

describe("buildThinkPrompt", () => {
  it("embeds cite-or-gap hard rules and per-item evidence tags", () => {
    const { system, user } = buildThinkPrompt("what do I prefer?", EVIDENCE);
    expect(system).toContain("Cite EVERY substantive claim");
    expect(system).toContain('"gaps"');
    expect(system).toContain("Do NOT make");
    expect(user).toContain(`<evidence id="${EVIDENCE[0].id}">`);
    expect(user).toContain("User prefers terse answers.");
  });
});

describe("parseThinkResponse", () => {
  it("maps short-id citations back to full ids, in evidence order metadata", () => {
    const raw = '{"answer": "You prefer terse answers.", "citations": ["a1b2c3d4"], "gaps": []}';
    const result = parseThinkResponse(raw, EVIDENCE, jsonrepair);
    expect(result.answer).toBe("You prefer terse answers.");
    expect(result.citations).toEqual([{ id: EVIDENCE[0].id, index: 0 }]);
    expect(result.droppedCitations).toEqual([]);
  });

  it("parses claim-addressable output with full evidence ids", () => {
    const raw = JSON.stringify({
      answer: "You prefer terse answers.",
      claims: [{ text: "You prefer terse answers.", citations: [EVIDENCE[0].id] }],
      gaps: [],
    });
    const result = parseThinkResponse(raw, EVIDENCE, jsonrepair);
    expect(result.schemaValid).toBe(true);
    expect(result.parseClassification).toBe("valid");
    expect(result.claims).toEqual([{
      text: "You prefer terse answers.",
      citations: [{ id: EVIDENCE[0].id, index: 0 }],
      droppedCitations: [],
    }]);
  });

  it("can re-validate the route's normalized citation-object shape", () => {
    const raw = JSON.stringify({
      answer: "You prefer terse answers.",
      claims: [{
        text: "You prefer terse answers.",
        citations: [{ id: EVIDENCE[0].id, index: 0 }],
      }],
      gaps: [],
    });
    expect(parseThinkResponse(raw, EVIDENCE, jsonrepair).claims[0]?.citations)
      .toEqual([{ id: EVIDENCE[0].id, index: 0 }]);
  });

  it("drops an ambiguous legacy short id instead of citing the wrong evidence", () => {
    const collisionEvidence = [
      { id: "semiote:deadbeef-1111", text: "first" },
      { id: "semiote:deadbeef-2222", text: "second" },
    ];
    const raw = JSON.stringify({
      answer: "x",
      claims: [{ text: "x", citations: ["deadbeef"] }],
      gaps: [],
    });
    const result = parseThinkResponse(raw, collisionEvidence, jsonrepair);
    expect(result.citations).toEqual([]);
    expect(result.droppedCitations).toEqual(["deadbeef"]);
  });

  it("DROPS invented citations instead of trusting them", () => {
    const raw = '{"answer": "x", "citations": ["a1b2c3d4", "deadbeef"], "gaps": []}';
    const result = parseThinkResponse(raw, EVIDENCE, jsonrepair);
    expect(result.citations).toHaveLength(1);
    expect(result.droppedCitations).toEqual(["deadbeef"]);
  });

  it("repairs malformed JSON via jsonrepair before giving up", () => {
    const raw = "{answer: 'ok', citations: ['f9e8d7c6'], gaps: []}";
    const result = parseThinkResponse(raw, EVIDENCE, jsonrepair);
    expect(result.answer).toBe("ok");
    expect(result.citations[0].id).toBe(EVIDENCE[1].id);
  });

  it("unparseable output degrades to an honest no-answer gap", () => {
    // jsonrepair coerces bare prose into a JSON string — still not an object,
    // so the honest-degrade path fires either way.
    const result = parseThinkResponse("I think the answer is probably 42", EVIDENCE, jsonrepair);
    expect(result.answer).toBeNull();
    expect(result.citations).toEqual([]);
    expect(result.gaps).toHaveLength(1);
  });

  it("strips code fences and dedupes repeated citations", () => {
    const raw = '```json\n{"answer": "x", "citations": ["a1b2c3d4", "a1b2c3d4"], "gaps": ["missing y"]}\n```';
    const result = parseThinkResponse(raw, EVIDENCE, jsonrepair);
    expect(result.citations).toHaveLength(1);
    expect(result.gaps).toEqual(["missing y"]);
  });
});

describe("emptyThinkResponse", () => {
  it("is the no-LLM honest path", () => {
    const result = emptyThinkResponse("who is Zephyrine?");
    expect(result.answer).toBeNull();
    expect(result.gaps[0]).toContain("no stored memory covers");
    expect(result.citations).toEqual([]);
  });
});
