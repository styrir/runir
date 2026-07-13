import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractMemories, deriveFactKey, normalizeTags } from "../capture/extraction/capture.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeFetchResponse(content: string) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      choices: [{ message: { content } }],
    }),
  });
}

const FAKE_API_KEY = "test-key";
const MESSAGES = [{ role: "user", content: "Hello" }];
const PROMPT = "extract facts";

describe("record-quality", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("tags is string[] after extraction (not null)", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          facts: [{ l2: "Some fact about TypeScript", confidence: 0.9, tags: ["typescript", "testing"] }],
        }),
      ),
    );
    const facts = await extractMemories(MESSAGES, PROMPT, FAKE_API_KEY);
    expect(facts).toHaveLength(1);
    expect(Array.isArray(facts[0].tags)).toBe(true);
    expect(facts[0].tags).toEqual(["typescript", "testing"]);
  });

  it("tags defaults to empty array when LLM returns null", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          facts: [{ l2: "Fact with null tags", confidence: 0.9, tags: null }],
        }),
      ),
    );
    const facts = await extractMemories(MESSAGES, PROMPT, FAKE_API_KEY);
    expect(facts).toHaveLength(1);
    expect(facts[0].tags).toEqual([]);
  });

  it("rejects facts with unrecognized category below 0.95 confidence floor", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          facts: [{ l2: "Invalid category fact", confidence: 0.9, category: "invalid_cat" }],
        }),
      ),
    );
    const facts = await extractMemories(MESSAGES, PROMPT, FAKE_API_KEY);
    expect(facts).toHaveLength(0);
  });

  it("l0 abstract defaults when missing from LLM", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          facts: [{ l2: "A long fact that should be truncated to first 100 chars for the abstract field value", confidence: 0.9 }],
        }),
      ),
    );
    const facts = await extractMemories(MESSAGES, PROMPT, FAKE_API_KEY);
    expect(facts[0].l0).toBe(facts[0].l2.slice(0, 100));
  });

  it("factKey format is category:slug-XXXXXX or category:XXXXXX", () => {
    const englishKey = deriveFactKey("cases", "JWT Expiry Fix");
    expect(englishKey).toMatch(/^cases:[a-z0-9-]+-[a-f0-9]{6}$/);

    const japaneseKey = deriveFactKey("entities", "データベース移行");
    expect(japaneseKey).toMatch(/^entities:[a-f0-9]{6}$/);
  });

  it("normalizeTags trims whitespace-only tags", () => {
    expect(normalizeTags(["  ", "valid", "   "])).toEqual(["valid"]);
  });
});
