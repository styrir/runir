import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaProvider } from "../storage/embeddings/providers/ollama-provider";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("OllamaProvider error paths", () => {
  const provider = new OllamaProvider({
    baseURL: "http://localhost:11434",
    model: "nomic-embed-text:v1.5",
    dimensions: 768,
    timeoutMs: 100,
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("throws on HTTP error response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(provider.embedQuery("hello")).rejects.toThrow("Ollama embed HTTP 503");
  });

  it("wraps AbortError as timeout error", async () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError");
    mockFetch.mockRejectedValueOnce(abortErr);
    await expect(provider.embedDocument("test")).rejects.toThrow("timed out after 100ms");
  });

  it("re-throws non-abort errors unchanged", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(provider.embedQuery("test")).rejects.toThrow("ECONNREFUSED");
  });

  it("returns empty array when embeddings[0] is undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [] }),
    });
    const result = await provider.embedQuery("test");
    expect(result).toEqual([]);
  });

  it("sends correct URL with baseURL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1, 2]] }),
    });
    await provider.embedQuery("test");
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:11434/api/embed");
  });

  it("fingerprint returns the configured model format", () => {
    expect(provider.fingerprint()).toBe("ollama:nomic-embed-text:v1.5:768:cosine");
  });

  it("embedQuery prefixes with search_query", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1]] }),
    });
    await provider.embedQuery("hello");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe("search_query: hello");
  });

  it("embedDocument prefixes with search_document", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1]] }),
    });
    await provider.embedDocument("doc text");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe("search_document: doc text");
  });
});
