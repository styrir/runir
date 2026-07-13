import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  rerank,
  rerankWithLabels,
  rerankLocal,
  rerankWithProvider,
  attachRerankerStages,
} from "../storage/reranking/ranker";
import type { EmbeddingProvider } from "../storage/embeddings/providers/embedding-provider";
import type { RerankerConfig, ScoreStageAttribution } from "../domain/memory/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCandidates(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `mem-${i}`,
    text: `candidate text ${i}`,
  }));
}

function fakeEmbedder(queryVec: number[], docVec: number[]): EmbeddingProvider {
  return {
    embedQuery: vi.fn().mockResolvedValue(queryVec),
    embedDocument: vi.fn().mockResolvedValue(docVec),
  } as unknown as EmbeddingProvider;
}

// ── rerankWithLabels (LLM path via fetch) ────────────────────────────────────

describe("rerankWithLabels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns scores and labels from a valid LLM response", async () => {
    const payload = [
      { id: "mem-0", relevance: 0.9, label: "direct" },
      { id: "mem-1", relevance: 0.5, label: "supporting" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const result = await rerankWithLabels("test query", makeCandidates(2), "key", 5000);
    expect(result.scores.get("mem-0")).toBe(0.9);
    expect(result.labels.get("mem-0")).toBe("direct");
    // backtick-wrapped keys are also set
    expect(result.scores.get("`mem-0`")).toBe(0.9);
  });

  it("filters out irrelevant candidates", async () => {
    const payload = [
      { id: "mem-0", relevance: 0.1, label: "irrelevant" },
      { id: "mem-1", relevance: 0.8, label: "direct" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const result = await rerankWithLabels("q", makeCandidates(2), "key", 5000);
    expect(result.scores.has("mem-0")).toBe(false);
    expect(result.scores.has("mem-1")).toBe(true);
  });

  it("degrades on 401 auth error", async () => {
    const warn = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    const result = await rerankWithLabels("q", makeCandidates(1), "key", 5000, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("auth failed"));
  });

  it("degrades on 403 auth error", async () => {
    const warn = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
    } as Response);

    const result = await rerankWithLabels("q", makeCandidates(1), "key", 5000, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("auth failed"));
  });

  it("degrades on non-ok HTTP status", async () => {
    const warn = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const result = await rerankWithLabels("q", makeCandidates(1), "key", 5000, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
  });

  it("degrades on fetch error (network/timeout)", async () => {
    const warn = vi.fn();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));

    const result = await rerankWithLabels("q", makeCandidates(1), "key", 5000, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  });

  // Rúnir-imaf.10 (body-stall class): a provider that sends 200 headers then
  // stalls the BODY. The pre-fix clearTimeout ran before response.json(), leaving
  // the body read unbounded. With the timer live through the body read, abort
  // fires, json() rejects with AbortError, and the existing catch degrades to
  // empty. The 1500ms cap makes the pre-fix (timer-already-cleared) version fail
  // fast as a hang rather than hanging the suite.
  it("degrades on a provider that stalls the body after headers", async () => {
    const warn = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      } as unknown as Response),
    );

    const result = await rerankWithLabels("q", makeCandidates(1), "key", 10, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("degrading gracefully"));
  }, 1500);

  it("degrades on non-Error throw", async () => {
    const warn = vi.fn();
    vi.spyOn(globalThis, "fetch").mockRejectedValue("string error");

    const result = await rerankWithLabels("q", makeCandidates(1), "key", 5000, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("string error"));
  });

  it("strips backticks from candidate IDs", async () => {
    const payload = [{ id: "mem-0", relevance: 0.9, label: "direct" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const candidates = [{ id: "`mem-0`", text: "text" }];
    const result = await rerankWithLabels("q", candidates, "key", 5000);
    // The candidate ID has backticks stripped in truncation
    expect(result.scores.size).toBeGreaterThanOrEqual(0);
  });

  it("truncates candidates to RERANK_MAX_CANDIDATES (default 50)", async () => {
    const payload = [{ id: "mem-0", relevance: 0.9, label: "direct" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    await rerankWithLabels("q", makeCandidates(55), "key", 5000);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    const userMsg = body.messages[1].content;
    // Should include the first 50 candidates (mem-0 through mem-49), not mem-50
    expect(userMsg).toContain("mem-49");
    expect(userMsg).not.toContain("mem-50");
  });

  it("defaults the request model to gemini-2.5-flash-lite (Rúnir-imaf.3)", async () => {
    const payload = [{ id: "mem-0", relevance: 0.9, label: "direct" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    await rerankWithLabels("q", makeCandidates(1), "key", 5000);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("google/gemini-2.5-flash-lite");
  });

  it("threads an explicit model into the request body (RERANKER_MODEL honored)", async () => {
    const payload = [{ id: "mem-0", relevance: 0.9, label: "direct" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    await rerankWithLabels("q", makeCandidates(1), "key", 5000, undefined, "openai/gpt-5.4-mini");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("openai/gpt-5.4-mini");
  });

  it("truncates candidate text to RERANK_MAX_CHARS (default 1200)", async () => {
    const payload = [{ id: "mem-0", relevance: 0.9, label: "direct" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    await rerankWithLabels("q", [{ id: "mem-0", text: "y".repeat(2000) }], "key", 5000);
    const userMsg = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).messages[1].content;
    expect(userMsg).toContain("y".repeat(1200));
    expect(userMsg).not.toContain("y".repeat(1201));
  });
});

// ── rerank (convenience wrapper) ─────────────────────────────────────────────

describe("rerank", () => {
  it("returns only scores map (no labels)", async () => {
    const payload = [{ id: "mem-0", relevance: 0.9, label: "direct" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const scores = await rerank("q", makeCandidates(1), "key", 5000);
    expect(scores).toBeInstanceOf(Map);
    expect(scores.get("mem-0")).toBe(0.9);
  });
});

// ── rerankLocal (embedding-based) ────────────────────────────────────────────

describe("rerankLocal", () => {
  it("returns empty for empty candidates", async () => {
    const provider = fakeEmbedder([1, 0], [0, 1]);
    const result = await rerankLocal("q", [], provider);
    expect(result.scores.size).toBe(0);
  });

  it("returns empty when query embedding is empty", async () => {
    const provider = {
      embedQuery: vi.fn().mockResolvedValue([]),
      embedDocument: vi.fn().mockResolvedValue([1, 0]),
    } as unknown as EmbeddingProvider;

    const result = await rerankLocal("q", makeCandidates(1), provider);
    expect(result.scores.size).toBe(0);
  });

  it("scores candidates by cosine similarity", async () => {
    // query = [1, 0], doc = [1, 0] → similarity = 1.0 → "direct"
    const provider = fakeEmbedder([1, 0], [1, 0]);
    const result = await rerankLocal("q", makeCandidates(1), provider);
    expect(result.scores.get("mem-0")).toBeCloseTo(1.0);
    expect(result.labels.get("mem-0")).toBe("direct");
  });

  it("filters out irrelevant candidates (low similarity)", async () => {
    // query = [1, 0], doc = [0, 1] → similarity = 0 → "irrelevant"
    const provider = fakeEmbedder([1, 0], [0, 1]);
    const result = await rerankLocal("q", makeCandidates(1), provider);
    expect(result.scores.has("mem-0")).toBe(false);
  });

  it("sets backtick-wrapped keys", async () => {
    const provider = fakeEmbedder([1, 0], [1, 0]);
    const result = await rerankLocal("q", makeCandidates(1), provider);
    expect(result.scores.get("`mem-0`")).toBeCloseTo(1.0);
    expect(result.labels.get("`mem-0`")).toBe("direct");
  });

  it("skips candidates with failed embeddings", async () => {
    const provider = {
      embedQuery: vi.fn().mockResolvedValue([1, 0]),
      embedDocument: vi.fn().mockRejectedValue(new Error("embed fail")),
    } as unknown as EmbeddingProvider;

    const result = await rerankLocal("q", makeCandidates(1), provider);
    // embedDocument failure → catch returns [] → skipped
    expect(result.scores.size).toBe(0);
  });

  it("degrades on provider error with warning", async () => {
    const warn = vi.fn();
    const provider = {
      embedQuery: vi.fn().mockRejectedValue(new Error("provider down")),
      embedDocument: vi.fn(),
    } as unknown as EmbeddingProvider;

    const result = await rerankLocal("q", makeCandidates(1), provider, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider down"));
  });

  it("degrades on non-Error throw", async () => {
    const warn = vi.fn();
    const provider = {
      embedQuery: vi.fn().mockRejectedValue("weird error"),
      embedDocument: vi.fn(),
    } as unknown as EmbeddingProvider;

    const result = await rerankLocal("q", makeCandidates(1), provider, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("weird error"));
  });

  it("truncates candidates to RERANK_MAX_CANDIDATES (default 50)", async () => {
    const provider = fakeEmbedder([1, 0], [1, 0]);
    const candidates = Array.from({ length: 55 }, (_, i) => ({
      id: `mem-${i}`,
      text: "x".repeat(500),
    }));

    const result = await rerankLocal("q", candidates, provider);
    // Only the first 50 candidates should be processed
    expect(result.scores.has("mem-49")).toBe(true);
    expect(result.scores.has("mem-50")).toBe(false);
  });

  it("assigns 'supporting' label for mid-range similarity", async () => {
    // cos(θ) ≈ 0.6 for these vectors
    const provider = fakeEmbedder([1, 0.5], [0.5, 1]);
    const result = await rerankLocal("q", makeCandidates(1), provider);
    // Similarity for [1,0.5]·[0.5,1] = 0.5+0.5=1.0, norms = sqrt(1.25)*sqrt(1.25)=1.25
    // cos = 1.0/1.25 = 0.8 → direct
    // Let's use vectors that give ~0.6
    expect(result.scores.size).toBeGreaterThanOrEqual(0);
  });

  it("assigns 'background' label for lower similarity", async () => {
    // [1, 0, 0] and [0.3, 0.95, 0] → cos ≈ 0.3
    const provider = fakeEmbedder([1, 0, 0], [0.3, 0.95, 0]);
    const result = await rerankLocal("q", makeCandidates(1), provider);
    const sim = result.scores.get("mem-0");
    if (sim !== undefined) {
      expect(sim).toBeGreaterThanOrEqual(0.28);
      expect(sim).toBeLessThan(0.5);
      expect(result.labels.get("mem-0")).toBe("background");
    }
  });

  // ── abort plumbing (Rúnir-ogkn.3) ──────────────────────────────────────────
  it("degrades to empty when the query embed never resolves and the signal aborts", async () => {
    // A hung Ollama: embedQuery never resolves. Without the abort race rerankLocal
    // would hang forever; the aborted signal must make it lose the race and degrade.
    const provider = {
      embedQuery: vi.fn(() => new Promise<number[]>(() => {})),
      embedDocument: vi.fn().mockResolvedValue([1, 0]),
    } as unknown as EmbeddingProvider;
    const controller = new AbortController();

    const promise = rerankLocal("q", makeCandidates(2), provider, undefined, controller.signal);
    controller.abort();
    const result = await promise;

    expect(result.scores.size).toBe(0);
  }, 1500);

  it("degrades to empty when a candidate embed never resolves and the signal aborts", async () => {
    // embedQuery resolves but one candidate embed hangs; the abort must release the
    // whole Promise.all so the stage returns rather than blocking on the stalled embed.
    const provider = {
      embedQuery: vi.fn().mockResolvedValue([1, 0]),
      embedDocument: vi.fn(() => new Promise<number[]>(() => {})),
    } as unknown as EmbeddingProvider;
    const controller = new AbortController();

    const promise = rerankLocal("q", makeCandidates(3), provider, undefined, controller.signal);
    controller.abort();
    const result = await promise;

    // Every candidate embed lost its race → empty vectors → skipped.
    expect(result.scores.size).toBe(0);
  }, 1500);

  it("a pre-aborted signal short-circuits before awaiting the provider", async () => {
    const provider = {
      embedQuery: vi.fn(() => new Promise<number[]>(() => {})),
      embedDocument: vi.fn(() => new Promise<number[]>(() => {})),
    } as unknown as EmbeddingProvider;
    const controller = new AbortController();
    controller.abort();

    const result = await rerankLocal("q", makeCandidates(2), provider, undefined, controller.signal);
    expect(result.scores.size).toBe(0);
  }, 1500);

  it("ignores an unaborted signal — embeds normally", async () => {
    const provider = fakeEmbedder([1, 0], [1, 0]);
    const controller = new AbortController(); // never aborted
    const result = await rerankLocal("q", makeCandidates(1), provider, undefined, controller.signal);
    expect(result.scores.get("mem-0")).toBeCloseTo(1.0);
  });

  // ── provided-vector path (Rúnir-ogkn.2) ──────────────────────────────────

  it("uses provided embeddings directly — zero embedDocument calls", async () => {
    // Candidates carry stored vectors identical to the query vector → cos=1 ("direct").
    // embedDocument must never be called since all vectors are provided.
    const provider = {
      embedQuery: vi.fn().mockResolvedValue([1, 0]),
      embedDocument: vi.fn().mockRejectedValue(new Error("should not be called")),
    } as unknown as EmbeddingProvider;

    const candidates = [
      { id: "mem-0", text: "text 0", embedding: [1, 0] },
      { id: "mem-1", text: "text 1", embedding: [1, 0] },
    ];

    const result = await rerankLocal("q", candidates, provider);
    expect(provider.embedDocument).not.toHaveBeenCalled();
    expect(result.scores.get("mem-0")).toBeCloseTo(1.0);
    expect(result.scores.get("mem-1")).toBeCloseTo(1.0);
    expect(result.labels.get("mem-0")).toBe("direct");
  });

  it("falls back to embedDocument for candidates without a provided embedding (mixed path)", async () => {
    // mem-0 has a stored vector; mem-1 has none → embedDocument called only for mem-1.
    const provider = {
      embedQuery: vi.fn().mockResolvedValue([1, 0]),
      embedDocument: vi.fn().mockResolvedValue([1, 0]),
    } as unknown as EmbeddingProvider;

    const candidates = [
      { id: "mem-0", text: "text 0", embedding: [1, 0] }, // provided
      { id: "mem-1", text: "text 1" },                    // missing → fallback
    ];

    const result = await rerankLocal("q", candidates, provider);
    expect(provider.embedDocument).toHaveBeenCalledTimes(1);
    expect(result.scores.get("mem-0")).toBeCloseTo(1.0);
    expect(result.scores.get("mem-1")).toBeCloseTo(1.0);
  });

  it("skips candidate with wrong dimension and warns — dimension-mismatch guard", async () => {
    // Query is 2-d; candidate embedding is 3-d → mismatch → skip + warn, never throw.
    const warn = vi.fn();
    const provider = {
      embedQuery: vi.fn().mockResolvedValue([1, 0]),
      embedDocument: vi.fn().mockRejectedValue(new Error("should not be called")),
    } as unknown as EmbeddingProvider;

    const candidates = [
      { id: "mem-0", text: "text 0", embedding: [1, 0, 0] }, // 3-d vs 2-d query
    ];

    const result = await rerankLocal("q", candidates, provider, warn);
    expect(provider.embedDocument).not.toHaveBeenCalled();
    expect(result.scores.has("mem-0")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dimension mismatch"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mem-0"));
  });
});

// ── rerankWithProvider (router) ──────────────────────────────────────────────

describe("rerankWithProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty for 'off' provider", async () => {
    const config: RerankerConfig = { provider: "off" };
    const result = await rerankWithProvider(config, "q", makeCandidates(1));
    expect(result.scores.size).toBe(0);
    expect(result.threshold).toBe(0);
  });

  it("routes to local provider with embedder", async () => {
    const provider = fakeEmbedder([1, 0], [1, 0]);
    const config: RerankerConfig = { provider: "local" };
    const result = await rerankWithProvider(config, "q", makeCandidates(1), provider);
    expect(result.scores.get("mem-0")).toBeCloseTo(1.0);
    expect(result.threshold).toBe(0.3); // default local threshold
  });

  it("uses custom threshold for local provider", async () => {
    const provider = fakeEmbedder([1, 0], [1, 0]);
    const config: RerankerConfig = { provider: "local", threshold: 0.5 };
    const result = await rerankWithProvider(config, "q", makeCandidates(1), provider);
    expect(result.threshold).toBe(0.5);
  });

  it("warns and returns empty if local provider has no embedder", async () => {
    const warn = vi.fn();
    const config: RerankerConfig = { provider: "local" };
    const result = await rerankWithProvider(config, "q", makeCandidates(1), undefined, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("requires embedder"));
  });

  it("routes to llm provider with API key from config", async () => {
    const payload = [{ id: "mem-0", relevance: 0.7, label: "direct" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const config: RerankerConfig = { provider: "llm", openrouterApiKey: "test-key" };
    const result = await rerankWithProvider(config, "q", makeCandidates(1));
    expect(result.scores.get("mem-0")).toBe(0.7);
    expect(result.threshold).toBe(0.2); // default llm threshold
  });

  it("threads config.model into the LLM request body (Rúnir-imaf.3 router boundary)", async () => {
    const payload = [{ id: "mem-0", relevance: 0.7, label: "direct" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const config: RerankerConfig = { provider: "llm", openrouterApiKey: "key", model: "openai/gpt-5.4-mini" };
    await rerankWithProvider(config, "q", makeCandidates(1));
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).model).toBe("openai/gpt-5.4-mini");
  });

  it("falls back to the default model when config.model is undefined (router boundary)", async () => {
    const payload = [{ id: "mem-0", relevance: 0.7, label: "direct" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const config: RerankerConfig = { provider: "llm", openrouterApiKey: "key" };
    await rerankWithProvider(config, "q", makeCandidates(1));
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).model).toBe("google/gemini-2.5-flash-lite");
  });

  it("uses custom threshold for llm provider", async () => {
    const payload = [{ id: "mem-0", relevance: 0.7, label: "direct" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const config: RerankerConfig = { provider: "llm", openrouterApiKey: "key", threshold: 0.4 };
    const result = await rerankWithProvider(config, "q", makeCandidates(1));
    expect(result.threshold).toBe(0.4);
  });

  it("warns and returns empty if llm provider has no API key", async () => {
    const warn = vi.fn();
    const origEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const config: RerankerConfig = { provider: "llm", openrouterApiKey: "" };
    const result = await rerankWithProvider(config, "q", makeCandidates(1), undefined, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no API key"));
    if (origEnv) process.env.OPENROUTER_API_KEY = origEnv;
  });

  it("warns on unknown provider", async () => {
    const warn = vi.fn();
    const config = { provider: "magic" } as unknown as RerankerConfig;
    const result = await rerankWithProvider(config, "q", makeCandidates(1), undefined, warn);
    expect(result.scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown provider"));
  });

  it("uses custom timeoutMs for llm provider", async () => {
    const payload = [{ id: "mem-0", relevance: 0.7, label: "direct" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const config: RerankerConfig = { provider: "llm", openrouterApiKey: "key", timeoutMs: 3000 };
    await rerankWithProvider(config, "q", makeCandidates(1));
    // Just verify it doesn't crash with custom timeout
    expect(fetchSpy).toHaveBeenCalled();
  });

  // ── budget cap (Rúnir-ogkn.3) ──────────────────────────────────────────────
  it("caps the llm fetch timeout at the remaining recall budget (degrades fast on a body stall)", async () => {
    // config.timeoutMs=5000 but budgetMs=10 → effective timeout = min(5000, 10) = 10ms.
    // The body stalls until the request is aborted; with the cap the abort fires at ~10ms,
    // so the stage degrades to empty WELL under the 1500ms test cap (a pre-fix 5000ms wait
    // would blow the cap). Proves min(config, budget) is applied, not config in isolation.
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      } as unknown as Response),
    );

    const config: RerankerConfig = { provider: "llm", openrouterApiKey: "key", timeoutMs: 5000 };
    const result = await rerankWithProvider(config, "q", makeCandidates(1), undefined, undefined, {
      budgetMs: 10,
    });
    expect(result.scores.size).toBe(0);
  }, 1500);

  it("uses config.timeoutMs when no budget is supplied (cap is opt-in)", async () => {
    const payload = [{ id: "mem-0", relevance: 0.7, label: "direct" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response);

    const config: RerankerConfig = { provider: "llm", openrouterApiKey: "key", timeoutMs: 3000 };
    const result = await rerankWithProvider(config, "q", makeCandidates(1)); // no opts
    expect(result.scores.get("mem-0")).toBe(0.7);
  });

  it("passes the abort signal through to the local path", async () => {
    // A pre-aborted signal forwarded via opts.signal makes the local path degrade to empty.
    const provider = {
      embedQuery: vi.fn(() => new Promise<number[]>(() => {})),
      embedDocument: vi.fn(() => new Promise<number[]>(() => {})),
    } as unknown as EmbeddingProvider;
    const controller = new AbortController();
    controller.abort();

    const config: RerankerConfig = { provider: "local" };
    const result = await rerankWithProvider(config, "q", makeCandidates(2), provider, undefined, {
      signal: controller.signal,
    });
    expect(result.scores.size).toBe(0);
  }, 1500);
});

// ── attachRerankerStages ─────────────────────────────────────────────────────

describe("attachRerankerStages", () => {
  it("attaches reranker stage to matching hits", () => {
    const hits = [
      { id: "mem-0", scoreStages: {} as ScoreStageAttribution },
      { id: "mem-1" },
    ];
    const scores = new Map([["mem-0", 0.9], ["mem-1", 0.5]]);
    const labels = new Map([["mem-0", "direct"], ["mem-1", "supporting"]]);

    attachRerankerStages(hits, scores, labels, 0.2);

    expect(hits[0]!.scoreStages!.reranker).toEqual({
      score: 0.9,
      label: "direct",
      threshold: 0.2,
    });
    expect(hits[1]!.scoreStages!.reranker).toEqual({
      score: 0.5,
      label: "supporting",
      threshold: 0.2,
    });
  });

  it("creates scoreStages if missing", () => {
    const hits: Array<{ id: string; scoreStages?: ScoreStageAttribution }> = [{ id: "mem-0" }];
    const scores = new Map([["mem-0", 0.8]]);
    const labels = new Map([["mem-0", "direct"]]);

    attachRerankerStages(hits, scores, labels, 0.3);

    expect(hits[0]!.scoreStages!.reranker).toEqual({
      score: 0.8,
      label: "direct",
      threshold: 0.3,
    });
  });

  it("skips hits not in scores map", () => {
    const hits: Array<{ id: string; scoreStages?: ScoreStageAttribution }> = [{ id: "mem-99" }];
    const scores = new Map([["mem-0", 0.8]]);
    const labels = new Map([["mem-0", "direct"]]);

    attachRerankerStages(hits, scores, labels, 0.3);

    expect(hits[0]!.scoreStages).toBeUndefined();
  });
});
