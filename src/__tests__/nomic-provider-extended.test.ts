import { describe, it, expect, vi, beforeEach } from "vitest";
import { NomicAPIProvider } from "../storage/embeddings/providers/nomic-provider";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("NomicAPIProvider error paths", () => {
  const provider = new NomicAPIProvider({
    apiKey: "test-key",
    model: "nomic-embed-text:v1.5",
    dimensions: 768,
    timeoutMs: 100,
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("throws on HTTP error response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(provider.embedQuery("hello")).rejects.toThrow("Nomic embed HTTP 429");
  });

  it("throws on HTTP 500", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(provider.embedDocument("doc")).rejects.toThrow("Nomic embed HTTP 500");
  });

  it("wraps AbortError as timeout error", async () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError");
    mockFetch.mockRejectedValueOnce(abortErr);
    await expect(provider.embedQuery("test")).rejects.toThrow("timed out after 100ms");
  });

  it("re-throws non-abort errors unchanged", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    await expect(provider.embedQuery("test")).rejects.toThrow("network failure");
  });

  it("returns empty array when embeddings[0] is undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [] }),
    });
    const result = await provider.embedQuery("test");
    expect(result).toEqual([]);
  });

  it("sends abort signal to fetch", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1, 2]] }),
    });
    await provider.embedQuery("test");
    const opts = mockFetch.mock.calls[0][1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
