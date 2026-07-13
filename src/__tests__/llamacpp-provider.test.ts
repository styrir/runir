import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlamaCppProvider } from "../storage/embeddings/providers/llamacpp-provider";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeEmbeddingResponse(embedding: number[]) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ data: [{ embedding }] }),
  });
}

describe("LlamaCppProvider", () => {
  const provider = new LlamaCppProvider({
    baseURL: "http://127.0.0.1:8081",
    model: "nomic-embed-text:v1.5",
    dimensions: 768,
    timeoutMs: 4000,
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("embedQuery adds 'search_query: ' prefix to input", async () => {
    mockFetch.mockReturnValueOnce(makeEmbeddingResponse([0.1, 0.2, 0.3]));
    await provider.embedQuery("hello world");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe("http://127.0.0.1:8081/v1/embeddings");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe("search_query: hello world");
    expect(body.model).toBe("nomic-embed-text:v1.5");
  });

  it("embedDocument adds 'search_document: ' prefix to input", async () => {
    mockFetch.mockReturnValueOnce(makeEmbeddingResponse([0.4, 0.5, 0.6]));
    await provider.embedDocument("some document text");

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe("search_document: some document text");
  });

  it("fingerprint() returns correct string", () => {
    expect(provider.fingerprint()).toBe("llamacpp:nomic-embed-text:v1.5:768:cosine");
  });

  it("returns embedding vector from response", async () => {
    mockFetch.mockReturnValueOnce(makeEmbeddingResponse([1.0, 2.0, 3.0]));
    const result = await provider.embedQuery("test");
    expect(result).toEqual([1.0, 2.0, 3.0]);
  });

  it("timeout triggers AbortError", async () => {
    const slowProvider = new LlamaCppProvider({
      baseURL: "http://127.0.0.1:8081",
      model: "nomic-embed-text:v1.5",
      dimensions: 768,
      timeoutMs: 1,
    });

    mockFetch.mockImplementationOnce(
      (_url: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        }),
    );

    await expect(slowProvider.embedQuery("test")).rejects.toThrow(/timed out/);
  });
});