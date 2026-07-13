import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractEntities } from "../entities/entity-extractor.js";

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

const MESSAGES = [{ role: "user", content: "We use SurrealDB for our graph database." }];
const FAKE_API_KEY = "test-key";

describe("entity-enrichment", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("description is non-null after entity extraction", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [{
            name: "SurrealDB",
            kind: "concept",
            subtype: "technology",
            context: "We use SurrealDB for our graph database.",
            confidence: 0.95,
            description: "A multi-model database with graph capabilities",
            aliases: [],
          }],
        }),
      ),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toHaveLength(1);
    expect(entities[0].description).toBe("A multi-model database with graph capabilities");
  });

  it("aliases is string[] after extraction (may be empty)", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [{
            name: "PostgreSQL",
            kind: "concept",
            subtype: "technology",
            context: "We migrated from PostgreSQL",
            confidence: 0.9,
            description: "A relational database",
            aliases: [],
          }],
        }),
      ),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(Array.isArray(entities[0].aliases)).toBe(true);
    expect(entities[0].aliases).toEqual([]);
  });

  it("aliases from extraction include alternate names", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [{
            name: "SurrealDB",
            kind: "concept",
            subtype: "technology",
            context: "SurrealDB JS SDK had issues",
            confidence: 0.95,
            description: "A multi-model database",
            aliases: ["SurrealDB 3.x", "SurrealDB JS SDK"],
          }],
        }),
      ),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities[0].aliases).toEqual(["SurrealDB 3.x", "SurrealDB JS SDK"]);
  });

  it("entities without description still extract successfully", async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse(
        JSON.stringify({
          entities: [{
            name: "React",
            kind: "concept",
            subtype: "technology",
            context: "Built with React",
            confidence: 0.9,
            aliases: [],
          }],
        }),
      ),
    );

    const entities = await extractEntities(MESSAGES, FAKE_API_KEY);
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("React");
    // description may be undefined when LLM omits it
  });
});
