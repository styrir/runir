import { describe, it, expect } from "vitest";
import { jsonrepair } from "jsonrepair";
import {
  buildThinkPrompt,
  parseThinkResponse,
  emptyThinkResponse,
  shortId,
} from "../recall/orchestrator/think-synthesis.js";

const EVIDENCE = [
  { id: "semiote:a1b2c3d4-1111-2222-3333-444455556666", text: "User prefers terse answers." },
  { id: "semiote:⟨f9e8d7c6-aaaa-bbbb-cccc-ddddeeeeffff⟩", text: "Project uses SurrealDB." },
];

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
    expect(user).toContain('<evidence id="a1b2c3d4">');
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
