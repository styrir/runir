import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression guard for the Codex-major bug the architect flagged on the (now-retired)
// Rúnir-x41m.11 split-window screen: the noema merge (mergeNoemaRetrievalLeg) sliced the
// merged pool back to candidateLimit. The split-window env-override knobs were stripped in
// Rúnir-tp2w.3 (no-ship, no promote path — see docs/analysis/2026-06-20-triage and the
// x41m.12 close note). These tests now pin the FIXED-DEFAULT candidate-window behavior:
// leg/fusion windows always equal candidateLimit, the rerank pool always equals the full
// fused/merged candidate pool, and candidatePoolIds is always equal to preRerankerIds
// (never a superset) — the strip removed the only mechanism that could make them diverge.

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

// Spy that proves the noema MERGE branch is actually reached (and with which limit) while still
// running the REAL merge — guards against a future refactor bypassing the merge (Codex pass-4 minor #2).
const mockMergeSpy = vi.fn();
vi.mock("../recall/policy/noema-retrieval-policy", async (importActual) => {
  const actual = await importActual<typeof import("../recall/policy/noema-retrieval-policy")>();
  return {
    ...actual,
    mergeNoemaRetrievalLeg: (...args: any[]) => {
      mockMergeSpy(...args);
      return (actual.mergeNoemaRetrievalLeg as any)(...args);
    },
  };
});

import { runHybridQueryWithEvidenceTable, type RecallCandidateStages, type NoemaRetrievalLegOptions } from "../recall/query/memory-query";

// Defined noema retrieval so the candidateHits = mergeNoemaRetrievalLeg(...) branch runs. annotation
// mode + non-empty RRF means the noema leg is NOT queried (shouldRunNoemaLeg requires hitCount===0),
// so noemaHits=[] and the merge exercises the bare "slice to limit" path — exactly the clamp bug.
const NOEMA: NoemaRetrievalLegOptions = {
  policy: {
    id: "noema-admissibility-v1",
    mode: "annotation",
    reason: "test",
    preferNoemaOverSupportingSemiote: false,
    fallbackOnly: false,
  },
};

/** Content-aware DB mock: nVec vector hits, empty bm25/recency/entity, hydrate the fused ids. */
function makeDb(nVec: number) {
  const ids = Array.from({ length: nVec }, (_, i) => `v${i + 1}`);
  return {
    query: vi.fn(async (sql: string) => {
      if (/<\|/.test(sql)) return [ids.map((id) => ({ id }))]; // vector KNN (`embedding <|K,EF|>`)
      if (/\bIN \$ids\b/.test(sql)) {
        return [ids.map((id) => ({ id, payload: { l2: `text ${id}` }, active: true }))]; // hydration
      }
      return [[]]; // bm25 / recency / entity legs → empty
    }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractId.mockImplementation((id: unknown) => String(id));
  mockGetBm25CorpusStats.mockResolvedValue({ avgDocLength: 10, totalDocs: 100, df: {} });
  mockGetEmbeddingFingerprint.mockResolvedValue(null);
  mockRerankWithProvider.mockResolvedValue({ scores: new Map(), labels: new Map(), threshold: 0 });
  mockApplyRerankScores.mockImplementation((hits: any[]) => hits);
});

describe("runHybridQueryWithEvidenceTable candidate window is fixed at candidateLimit (post Rúnir-tp2w.3 strip)", () => {
  it("default path (reranker off): candidatePoolIds == preRerankerIds, merge gets candidateLimit", async () => {
    const db = makeDb(30);
    const captured: RecallCandidateStages[] = [];

    await runHybridQueryWithEvidenceTable({
      db, userId: "u1", query: "alpha", embedding: [1], limit: 5,
      evidenceTable: "memories",
      tuning: { onCandidateStages: (s: RecallCandidateStages) => captured.push(s) },
      noemaRetrieval: NOEMA,
    });

    expect(captured).toHaveLength(1);
    const s = captured[0];
    // limit=5 → candidateLimit = 15; leg/fusion windows are always candidateLimit now.
    expect(s.legFetchLimit).toBe(15);
    expect(s.fusionCandidateLimit).toBe(15);
    // The full pool IS the rerank pool — no override can ever widen or narrow it now.
    expect(s.candidatePoolIds).toEqual(s.preRerankerIds);
    // The merge ran and received candidateLimit (15).
    expect(mockMergeSpy).toHaveBeenCalledTimes(1);
    expect(mockMergeSpy.mock.calls[0][3]).toBe(15);
  });

  it("noema merge is clamped to candidateLimit, not widened — a 30-row fused pool still merges to candidateLimit's window", async () => {
    const db = makeDb(30);
    const captured: RecallCandidateStages[] = [];

    // candidateLimit = 5*3 = 15. There is no longer any override that can widen the fusion
    // window past candidateLimit, so the merge always receives candidateLimit (15) and the
    // rrf-fused 30-row pool is the merge's INPUT, not a floor on its output window.
    await runHybridQueryWithEvidenceTable({
      db, userId: "u1", query: "alpha", embedding: [1], limit: 5,
      evidenceTable: "memories",
      tuning: { onCandidateStages: (s: RecallCandidateStages) => captured.push(s) },
      noemaRetrieval: NOEMA,
    });

    expect(captured).toHaveLength(1);
    const s = captured[0];
    expect(s.legFetchLimit).toBe(15);
    expect(s.fusionCandidateLimit).toBe(15);
    expect(mockMergeSpy).toHaveBeenCalledTimes(1);
    expect(mockMergeSpy.mock.calls[0][3]).toBe(15);
  });

  it("rerank pool always equals the full candidate pool (reranker on) — no window can narrow preRerankerIds below candidatePoolIds", async () => {
    const db = makeDb(30);
    const captured: RecallCandidateStages[] = [];
    // Score every rerank-pool candidate above the (0) threshold so applyRerankScores keeps them all.
    mockRerankWithProvider.mockImplementation(async (_cfg: unknown, _q: unknown, cands: any[]) => ({
      scores: new Map(cands.map((c, i) => [c.id, 1 - i * 0.001])),
      labels: new Map(cands.map((c) => [c.id, "direct"])),
      threshold: 0,
    }));

    await runHybridQueryWithEvidenceTable({
      db, userId: "u1", query: "alpha", embedding: [1], limit: 5,
      evidenceTable: "memories",
      rerankerConfig: { provider: "local" } as any, // reranker ON
      tuning: { onCandidateStages: (s: RecallCandidateStages) => captured.push(s) },
      noemaRetrieval: NOEMA,
    });

    expect(captured).toHaveLength(1);
    const s = captured[0];
    expect(s.fusionCandidateLimit).toBe(15);
    expect(s.rerankCandidateLimit).toBe(s.candidatePoolIds.length);
    // No rerank-window cut is possible anymore: preRerankerIds == candidatePoolIds always.
    expect(s.preRerankerIds).toEqual(s.candidatePoolIds);
    const rerankWindowCut = s.candidatePoolIds.filter((id) => !s.preRerankerIds.includes(id));
    expect(rerankWindowCut).toHaveLength(0);
  });
});
