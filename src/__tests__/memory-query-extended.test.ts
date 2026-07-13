import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExtractId = vi.fn((id: unknown) => String(id));
const mockGetBm25CorpusStats = vi.fn();
const mockGetEmbeddingFingerprint = vi.fn();

vi.mock("../storage/surreal/surreal-store", () => ({
  ACTIVE_MEMORY_FILTER: "AND payload.inactive != true",
  extractId: (id: unknown) => mockExtractId(id),
  getBm25CorpusStats: (...args: unknown[]) => mockGetBm25CorpusStats(...args),
  getEmbeddingFingerprint: (...args: unknown[]) => mockGetEmbeddingFingerprint(...args),
}));

const mockRerankWithProvider = vi.fn();
const mockAttachRerankerStages = vi.fn();
vi.mock("../storage/reranking/ranker", () => ({
  rerankWithProvider: (...args: unknown[]) => mockRerankWithProvider(...args),
  attachRerankerStages: (...args: unknown[]) => mockAttachRerankerStages(...args),
}));

const mockApplyRerankScores = vi.fn();
vi.mock("../recall/selection/recall-selection", () => ({
  applyRerankScores: (...args: unknown[]) => mockApplyRerankScores(...args),
}));

import {
  bm25Search,
  nativeRrfSearch,
  runHybridQueryWithEvidenceTable,
} from "../recall/query/memory-query";

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractId.mockImplementation((id: unknown) => String(id));
  mockGetBm25CorpusStats.mockResolvedValue({ avgDocLength: 10, totalDocs: 100, df: {} });
  mockGetEmbeddingFingerprint.mockResolvedValue(null);
  mockRerankWithProvider.mockResolvedValue({ scores: new Map(), labels: new Map(), threshold: 0 });
  mockApplyRerankScores.mockImplementation((hits: any[]) => hits);
});

// ── bm25Search edge cases ──────────────────────────────────────────────────

describe("bm25Search edge cases", () => {
  it("returns 0 score for tf=0 in corpus stats", async () => {
    // When corpus has no matching terms, BM25 score should be 0
    mockGetBm25CorpusStats.mockResolvedValue({
      avgDocLength: 10,
      totalDocs: 100,
      df: {}, // no document frequency for any term
    });
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "m1", payload: { l2: "hello world test text here" } },
      ]]),
    } as any;
    const hits = await bm25Search(db, "u1", "xyznotfound", 10, new Map());
    // Empty tokens → empty result, or scored to 0 → filtered out
    expect(hits.length).toBe(0);
  });

  it("filters out non-finite scores", async () => {
    mockGetBm25CorpusStats.mockResolvedValue({
      avgDocLength: 0,
      totalDocs: 0,
      df: {},
    });
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "m1", payload: { l2: "hello" } },
      ]]),
    } as any;
    const hits = await bm25Search(db, "u1", "hello", 10, new Map());
    // With totalDocs=0, bm25Score returns 0 → filtered out
    expect(hits.every((h: any) => Number.isFinite(h.score))).toBe(true);
  });
});

// ── nativeRrfSearch with trace ─────────────────────────────────────────────

describe("nativeRrfSearch with trace", () => {
  it("records vector, bm25, and recency stages in trace", async () => {
    const trace = {
      startStage: vi.fn(),
      endStage: vi.fn(),
    };

    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "mem-1" }]])       // vector
        .mockResolvedValueOnce([[{ id: "mem-1", bm25score: 0.5 }]])  // bm25
        .mockResolvedValueOnce([[]])                       // recency
        .mockResolvedValueOnce([[{ id: "mem-1", payload: { l2: "hi", createdAt: "2024-01-01" } }]]),
    } as any;

    await nativeRrfSearch(db, "u1", [1], "hello", 10, undefined, undefined, undefined, trace as any);

    const stageNames = trace.startStage.mock.calls.map((c: any[]) => c[0]);
    expect(stageNames).toContain("vector_search");
    expect(stageNames).toContain("bm25_search");
    expect(stageNames).toContain("recency_search");
    expect(stageNames).toContain("entity_search");
    expect(stageNames).toContain("rrf_fusion");
    expect(trace.startStage.mock.calls.find((c: any[]) => c[0] === "entity_search")?.[1]).toEqual([]);
    expect(trace.endStage).toHaveBeenCalledTimes(5);
  });
});

// ── runHybridQueryWithEvidenceTable with trace and reranking ─────────────────

describe("runHybridQueryWithEvidenceTable with trace", () => {
  it("records reranker and threshold_filter stages in trace", async () => {
    const trace = {
      startStage: vi.fn(),
      endStage: vi.fn(),
    };

    const scores = new Map([["mem-1", 0.9]]);
    const labels = new Map([["mem-1", "direct"]]);
    mockRerankWithProvider.mockResolvedValue({ scores, labels, threshold: 0.2 });
    mockApplyRerankScores.mockReturnValue([{ id: "mem-1", text: "hi", score: 0.9 }]);

    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ id: "mem-1" }]])       // vector
        .mockResolvedValueOnce([[{ id: "mem-1", bm25score: 0.5 }]])  // bm25
        .mockResolvedValueOnce([[]])                       // recency
        .mockResolvedValueOnce([[{ id: "mem-1", payload: { l2: "hi" } }]]),
    } as any;

    await runHybridQueryWithEvidenceTable({
      db,
      userId: "u1",
      query: "q",
      embedding: [1],
      limit: 10,
      evidenceTable: "memories",
      rerankerConfig: { provider: "llm", openrouterApiKey: "key" } as any,
      trace: trace as any,
    });

    const stageNames = trace.startStage.mock.calls.map((c: any[]) => c[0]);
    expect(stageNames).toContain("reranker");
    expect(stageNames).toContain("threshold_filter");
  });
});
