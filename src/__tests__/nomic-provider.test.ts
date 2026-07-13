import { describe, it, expect, vi, beforeEach } from "vitest";
import { NomicAPIProvider } from "../storage/embeddings/providers/nomic-provider";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeEmbeddingResponse(embedding: number[]) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ embeddings: [embedding] }),
  });
}

describe("NomicAPIProvider", () => {
  const provider = new NomicAPIProvider({
    apiKey: "test-api-key",
    model: "nomic-embed-text:v1.5",
    dimensions: 768,
    timeoutMs: 4000,
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("embedQuery sends task_type: 'search_query' (no text prefix)", async () => {
    mockFetch.mockReturnValueOnce(makeEmbeddingResponse([0.1, 0.2]));
    await provider.embedQuery("hello world");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api-atlas.nomic.ai/v1/embedding/text");

    const body = JSON.parse(opts.body);
    expect(body.task_type).toBe("search_query");
    expect(body.texts).toEqual(["hello world"]); // no prefix
    expect(body.model).toBe("nomic-embed-text:v1.5");
    expect(body.dimensionality).toBe(768);
  });

  it("embedDocument sends task_type: 'search_document' (no text prefix)", async () => {
    mockFetch.mockReturnValueOnce(makeEmbeddingResponse([0.3, 0.4]));
    await provider.embedDocument("some document");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.task_type).toBe("search_document");
    expect(body.texts).toEqual(["some document"]); // no prefix
  });

  it("uses correct endpoint: api-atlas.nomic.ai", async () => {
    mockFetch.mockReturnValueOnce(makeEmbeddingResponse([0.5]));
    await provider.embedQuery("test");

    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe("https://api-atlas.nomic.ai/v1/embedding/text");
    expect(url).not.toContain("api.nomic.ai");
  });

  it("sends Authorization: Bearer header", async () => {
    mockFetch.mockReturnValueOnce(makeEmbeddingResponse([0.5]));
    await provider.embedQuery("test");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer test-api-key");
  });

  it("fingerprint() returns correct string", () => {
    expect(provider.fingerprint()).toBe("nomic:nomic-embed-text:v1.5:768:cosine");
  });

  it("returns embedding vector from response", async () => {
    mockFetch.mockReturnValueOnce(makeEmbeddingResponse([1.0, 2.0, 3.0]));
    const result = await provider.embedDocument("doc");
    expect(result).toEqual([1.0, 2.0, 3.0]);
  });
});
