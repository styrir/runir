import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Rerank-stage budget enforcement (Rúnir-ogkn.3).
 *
 * RECALL_BUDGET_MS previously bounded only RRF + noema; the rerank stage ran after
 * with no global bound, and rerankLocal had NO timeout race on its provider embed
 * awaits — a stalled Ollama held every recall open indefinitely (outage class of
 * Rúnir-yxwe/imaf.10). These tests prove the stage now:
 *   1. degrades to the FUSED (pre-rerank) order when the embedder never resolves,
 *      within the remaining budget, with NO dangling timers leaking into other tests;
 *   2. is SKIPPED entirely when RRF + noema already spent the budget;
 *   3. leaves the normal (fast) reranker path unchanged.
 *
 * These run the REAL ranker (rerankWithProvider/rerankLocal are NOT mocked) so the
 * timeout race + abort plumbing are genuinely exercised, with a fake DB + fake
 * embedder. Fake timers make the never-resolving stall deterministic.
 */

const mockGetBm25CorpusStats = vi.fn();
const mockGetEmbeddingFingerprint = vi.fn();

vi.mock("../storage/surreal/surreal-store", () => ({
  ACTIVE_MEMORY_FILTER: "AND payload.inactive != true",
  extractId: (id: unknown) => String(id),
  getBm25CorpusStats: (...args: unknown[]) => mockGetBm25CorpusStats(...args),
  getEmbeddingFingerprint: (...args: unknown[]) => mockGetEmbeddingFingerprint(...args),
}));

import { runHybridQueryWithEvidenceTable } from "../recall/query/memory-query";
import { RECALL_BUDGET_MS } from "../domain/memory/types";
import type { EmbeddingProvider } from "../storage/embeddings/providers/embedding-provider";
import type { RerankerConfig } from "../domain/memory/types";

/** Content-aware DB mock: nVec vector hits, empty bm25/recency/entity, hydrate fused ids. */
function makeDb(nVec: number) {
  const ids = Array.from({ length: nVec }, (_, i) => `v${i + 1}`);
  return {
    query: vi.fn(async (sql: string) => {
      if (/<\|/.test(sql)) return [ids.map((id) => ({ id }))]; // vector KNN
      if (/\bIN \$ids\b/.test(sql)) {
        return [ids.map((id) => ({ id, payload: { l2: `text ${id}` }, active: true }))]; // hydration
      }
      return [[]]; // bm25 / recency / entity legs → empty
    }),
  } as any;
}

/** Embedder whose query embed NEVER resolves (simulates a hung Ollama). */
function neverResolvingEmbedder(): EmbeddingProvider {
  return {
    embedQuery: vi.fn(() => new Promise<number[]>(() => {})),
    embedDocument: vi.fn(() => new Promise<number[]>(() => {})),
    fingerprint: () => "fake:model:1:cosine",
  } as unknown as EmbeddingProvider;
}

/** Embedder that resolves to a fixed vector (normal-path control). */
function fastEmbedder(vec: number[]): EmbeddingProvider {
  return {
    embedQuery: vi.fn().mockResolvedValue(vec),
    embedDocument: vi.fn().mockResolvedValue(vec),
    fingerprint: () => "fake:model:1:cosine",
  } as unknown as EmbeddingProvider;
}

const LOCAL_RERANK: RerankerConfig = { provider: "local" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBm25CorpusStats.mockResolvedValue({ avgDocLength: 10, totalDocs: 100, df: {} });
  mockGetEmbeddingFingerprint.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rerank stage budget enforcement (Rúnir-ogkn.3)", () => {
  it("degrades to fused order within budget when the embedder never resolves", async () => {
    vi.useFakeTimers();
    const db = makeDb(6);
    const warn = vi.fn();

    const promise = runHybridQueryWithEvidenceTable({
      db,
      userId: "u1",
      query: "alpha",
      embedding: [1],
      limit: 5,
      evidenceTable: "memories",
      rerankerConfig: LOCAL_RERANK,
      embeddingProvider: neverResolvingEmbedder(),
      warn,
    });

    // Drain microtasks so RRF + noema settle, then trip the rerank-stage timeout.
    // The stage budget is ~RECALL_BUDGET_MS minus the (near-zero, fake-timed) elapsed;
    // advancing past RECALL_BUDGET_MS guarantees the timeout arm fires.
    await vi.advanceTimersByTimeAsync(RECALL_BUDGET_MS + 100);

    const hits = await promise;

    // Fused (pre-rerank) order returned: all 6 fused candidates, unreordered.
    expect(hits.map((h) => h.id)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rerank stage timed out"));
  });

  it("does not leak dangling timers after a never-resolving rerank stall", async () => {
    vi.useFakeTimers();
    const db = makeDb(3);

    const promise = runHybridQueryWithEvidenceTable({
      db,
      userId: "u1",
      query: "alpha",
      embedding: [1],
      limit: 5,
      evidenceTable: "memories",
      rerankerConfig: LOCAL_RERANK,
      embeddingProvider: neverResolvingEmbedder(),
    });

    await vi.advanceTimersByTimeAsync(RECALL_BUDGET_MS + 100);
    await promise;

    // No timers should remain pending — the timeout sentinel resolved and the leaked
    // embed race arm never settles (so it schedules nothing). A leaked withTimeout
    // timer would show up here (vitest fake-timer accounting).
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips the rerank stage entirely when RRF + noema already spent the budget", async () => {
    // RRF returns hits after ~2.5s (under the 8s DB timeout), then the noema leg burns
    // the rest of the budget. Combined elapsed leaves < MIN_RERANK_BUDGET_MS, so the
    // rerank stage short-circuits to fused order WITHOUT ever calling the embedder.
    vi.useFakeTimers();
    const ids = ["v1", "v2", "v3"];
    const slowDb = {
      query: vi.fn(async (sql: string) => {
        if (/<\|/.test(sql)) {
          await new Promise((r) => setTimeout(r, 2500)); // RRF vector leg ~2.5s
          return [ids.map((id) => ({ id }))];
        }
        if (/FROM noema/.test(sql)) {
          // noema scan stalls past its remaining budget → withTimeout returns [] but the
          // wall clock still advances to the noema budget cap.
          await new Promise((r) => setTimeout(r, RECALL_BUDGET_MS));
          return [[]];
        }
        if (/\bIN \$ids\b/.test(sql)) {
          return [ids.map((id) => ({ id, payload: { l2: `text ${id}` }, active: true }))];
        }
        return [[]];
      }),
    } as any;
    const embedder = fastEmbedder([1, 0]);
    const warn = vi.fn();

    const promise = runHybridQueryWithEvidenceTable({
      db: slowDb,
      userId: "u1",
      query: "alpha",
      embedding: [1],
      limit: 5,
      evidenceTable: "memories",
      rerankerConfig: LOCAL_RERANK,
      embeddingProvider: embedder,
      noemaRetrieval: {
        policy: {
          id: "noema-admissibility-v1",
          mode: "primary",
          reason: "test",
          preferNoemaOverSupportingSemiote: false,
          fallbackOnly: false,
        },
      },
      warn,
    });

    // Advance well past the full budget so RRF (2.5s) + noema (budget-capped) both settle.
    await vi.advanceTimersByTimeAsync(RECALL_BUDGET_MS * 2);
    const hits = await promise;

    expect(hits.map((h) => h.id)).toEqual(ids);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recall budget exhausted"));
    // Stage skipped → the embedder was never invoked.
    expect(embedder.embedQuery as any).not.toHaveBeenCalled();
  });

  it("normal (fast) reranker path is unchanged — reranker reorders, no timeout", async () => {
    const db = makeDb(3);
    // doc identical to query vec → cos=1 ("direct"); all kept, re-sorted by score.
    const embedder = fastEmbedder([1, 0]);
    const warn = vi.fn();

    const hits = await runHybridQueryWithEvidenceTable({
      db,
      userId: "u1",
      query: "alpha",
      embedding: [1],
      limit: 5,
      evidenceTable: "memories",
      rerankerConfig: LOCAL_RERANK,
      embeddingProvider: embedder,
      warn,
    });

    // Reranker ran (all 3 scored "direct" at cos=1) and returned the candidates.
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.scoreStages?.reranker?.label === "direct")).toBe(true);
    // No budget warnings on the fast path.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("recall budget exhausted"));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("rerank stage timed out"));
  });
});
