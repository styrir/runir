import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractMemories } from "../capture/extraction/capture.js";
import { CONFIDENCE_THRESHOLD } from "../domain/memory/types.js";

// Mock fetch globally
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

describe("extractMemories", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("parses object format facts with confidence", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          facts: [
            { l2: "The server runs on port 7700", confidence: 0.95 },
            { l2: "SurrealDB is used as primary store", confidence: 0.9 },
          ],
        })
      )
    );

    const facts = await extractMemories(MESSAGES, PROMPT, FAKE_API_KEY);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ l2: "The server runs on port 7700", confidence: 0.95 });
    expect(facts[1]).toMatchObject({ l2: "SurrealDB is used as primary store", confidence: 0.9 });
  });

  it("falls back to confidence 1.0 for plain string facts", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          facts: ["Plain string fact with no confidence"],
        })
      )
    );

    const facts = await extractMemories(MESSAGES, PROMPT, FAKE_API_KEY);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ l2: "Plain string fact with no confidence", confidence: 1.0 });
  });

  it("filters out facts below CONFIDENCE_THRESHOLD", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          facts: [
            { l2: "High confidence fact", confidence: 0.9 },
            { l2: "Below threshold fact", confidence: 0.5 },
            { l2: "At threshold fact", confidence: CONFIDENCE_THRESHOLD },
          ],
        })
      )
    );

    const facts = await extractMemories(MESSAGES, PROMPT, FAKE_API_KEY);
    // Only facts with confidence >= CONFIDENCE_THRESHOLD (0.7) pass
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.l2)).toContain("High confidence fact");
    expect(facts.map((f) => f.l2)).toContain("At threshold fact");
    expect(facts.map((f) => f.l2)).not.toContain("Below threshold fact");
  });

  it("injects sessionTimestamp into the prompt when provided", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(JSON.stringify({ facts: [] }))
    );

    const ts = "2026-03-26T09:00:00.000Z";
    await extractMemories(MESSAGES, "Prompt with {SESSION_TIMESTAMP} placeholder", FAKE_API_KEY, ts);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = callBody.messages[0].content;
    expect(systemMsg).toContain(ts);
    expect(systemMsg).not.toContain("{SESSION_TIMESTAMP}");
  });

  it("uses current timestamp when sessionTimestamp not provided", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(JSON.stringify({ facts: [] }))
    );

    await extractMemories(MESSAGES, "Prompt with {SESSION_TIMESTAMP} placeholder", FAKE_API_KEY);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = callBody.messages[0].content;
    // Should have replaced {SESSION_TIMESTAMP} with something (not left as placeholder)
    expect(systemMsg).not.toContain("{SESSION_TIMESTAMP}");
  });

  it("returns empty array when fetch fails", async () => {
    mockFetch.mockReturnValueOnce(Promise.resolve({ ok: false }));
    const facts = await extractMemories(MESSAGES, PROMPT, FAKE_API_KEY);
    expect(facts).toEqual([]);
  });
});
