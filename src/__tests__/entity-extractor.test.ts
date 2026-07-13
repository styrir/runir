import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractEntities } from "../entities/entity-extractor.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeFetchResponse(content: string) {
  return Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content } }],
      }),
  });
}

const FAKE_API_KEY = "test-key";
const MESSAGES = [{ role: "user" as const, content: "Alice works at Acme Corp" }];

describe("extractEntities", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns EntityMention[] filtered by confidence >= 0.7", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "Alice works", confidence: 0.95 },
            { name: "Acme Corp", kind: "org", context: "at Acme Corp", confidence: 0.85 },
          ],
        }),
      ),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toHaveLength(2);
    expect(entities[0].name).toBe("Alice");
    expect(entities[1].name).toBe("Acme Corp");
  });

  it("filters out entities below confidence threshold", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "Alice", kind: "person", context: "...", confidence: 0.9 },
            { name: "Vague Thing", kind: "concept", context: "...", confidence: 0.5 },
          ],
        }),
      ),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("Alice");
  });

  it("returns [] if response is malformed JSON", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse("not valid json {{{"),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toEqual([]);
  });

  it("returns [] if HTTP error", async () => {
    mockFetch.mockReturnValueOnce(Promise.resolve({ ok: false }));

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toEqual([]);
  });

  it("handles ```json ... ``` wrapped response", async () => {
    const wrapped = '```json\n{"entities": [{"name": "Alice", "kind": "person", "context": "...", "confidence": 0.9}]}\n```';
    mockFetch.mockReturnValueOnce(makeFetchResponse(wrapped));

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("Alice");
  });

  it("maps assistant role messages to 'Assistant' prefix", async () => {
    const mixed = [
      { role: "user" as const, content: "Tell me about SurrealDB" },
      { role: "assistant" as const, content: "SurrealDB is a multi-model database" },
    ];
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [
            { name: "SurrealDB", kind: "concept", context: "...", confidence: 0.95 },
          ],
        }),
      ),
    );

    const entities = await extractEntities(mixed, FAKE_API_KEY);
    expect(entities).toHaveLength(1);
    // Verify the fetch was called with both Human and Assistant prefixes
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userContent = body.messages[1].content;
    expect(userContent).toContain("Human: Tell me about SurrealDB");
    expect(userContent).toContain("Assistant: SurrealDB is a multi-model database");
  });

  it("returns [] when response has no choices", async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toEqual([]);
  });

  it("returns [] when parsed entities is not an array", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(JSON.stringify({ entities: "not-an-array" })),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toEqual([]);
  });

  it("uses provided sessionTimestamp in prompt", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(JSON.stringify({ entities: [] })),
    );

    await extractEntities(MESSAGES, FAKE_API_KEY, "2025-01-15T00:00:00Z");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain("2025-01-15T00:00:00Z");
  });
});
