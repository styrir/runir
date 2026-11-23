import {
  type MemoryRecordTable,
  RETRIEVAL_DB_TIMEOUT_MS,
  RECALL_BUDGET_MS,
  MIN_NOEMA_BUDGET_MS,
  MIN_RERANK_BUDGET_MS,
  type RerankerConfig,
  type SearchHit,
} from "../../domain/memory/types";
import type { EmbeddingProvider } from "../../storage/embeddings/providers/embedding-provider";
import {
  ACTIVE_MEMORY_FILTER,
  extractId,
  getEmbeddingFingerprint,
  type SurrealClient,
} from "../../storage/surreal/surreal-store";
import type { ScopeFilter } from "./scope-predicate";
import { rerankWithProvider, attachRerankerStages } from "../../storage/reranking/ranker";
import { RERANK_CANDIDATE_FLOOR } from "../../shared/config";
import { applyRerankScores } from "../selection/recall-selection";
import type { TraceCollector } from "../selection/retrieval-trace";
import { type OverlayRetrievalHandle } from "./overlay-merge.js";
import { mergeNoemaRetrievalLeg } from "../policy/noema-retrieval-policy.js";
import { detectExactQaIntent, scoreExactQaCandidate } from "../../domain/memory/exact-qa.js";
import { enrichLinkedExactQaHits } from "./linked-exact-qa.js";
import { withTimeoutFlagged, withTimeout } from "./retrieval-timeouts.js";
import type {
  NoemaRetrievalLegOptions,
  EntityRetrievalTraceMatch,
  LegRanks,
  HybridQueryTuningOptions,
} from "./retrieval-types.js";
import { shouldRunNoemaLeg, queryNoemaCandidates } from "./noema-leg.js";
import { nativeRrfSearch } from "./native-rrf-search.js";

// Moved out in vk-2996; re-exported so importers and module mocks are unchanged.
export { linkedExactQaFailureCount, enrichLinkedExactQaHits } from "./linked-exact-qa.js";
export { withTimeoutFlagged, withTimeout } from "./retrieval-timeouts.js";
export { tokenizeText, significantQueryTokens, expandRetrievalQuery } from "./query-text.js";
export { vectorSearch, bm25Search } from "./legacy-search.js";
export { RECENCY_WINDOW_HOURS } from "./retrieval-types.js";
export type { NoemaRetrievalLegOptions, EntityRetrievalTraceMatch, LegRanks, RecallCandidateStages, HybridQueryTuningOptions } from "./retrieval-types.js";
export { shouldRunNoemaLeg } from "./noema-leg.js";
export { linkedMemoryRecordIds, entityMentionCandidates, entityLookupScopes } from "./entity-leg.js";
export { DEFAULT_RRF_ENTITY_WEIGHT, defaultRrfEntityWeight, rrfFuse } from "./rrf-fusion.js";
export { nativeRrfSearch } from "./native-rrf-search.js";

export type { OverlayRetrievalHandle } from "./overlay-merge.js";

export interface RunHybridQueryWithEvidenceTableInput {
  readonly db: SurrealClient;
  readonly userId: string;
  readonly query: string;
  readonly embedding: number[];
  readonly limit: number;
  readonly evidenceTable: MemoryRecordTable;
  readonly scopeFilter?: ScopeFilter;
  readonly warn?: (msg: string) => void;
  readonly rerankerConfig?: RerankerConfig;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly trace?: TraceCollector;
  readonly activeFilter?: string;
  readonly tuning?: HybridQueryTuningOptions;
  readonly overlay?: OverlayRetrievalHandle;
  readonly noemaRetrieval?: NoemaRetrievalLegOptions;
}

export interface RunHybridQueryWithEntityTraceOutput {
  hits: SearchHit[];
  entityMatches: EntityRetrievalTraceMatch[];
  legRanks: LegRanks;
}

/**
 * Named-parameter entrypoint for hybrid retrieval.
 *
 * Runs the full hybrid retrieval pipeline with optional reranking, filtered by scope.
 */
export async function runHybridQueryWithEvidenceTable(
  input: RunHybridQueryWithEvidenceTableInput,
): Promise<SearchHit[]> {
  const {
    db,
    userId,
    query,
    embedding,
    limit,
    scopeFilter,
    warn,
    rerankerConfig,
    embeddingProvider,
    trace,
    activeFilter = ACTIVE_MEMORY_FILTER,
    // evidenceTable is a required field on RunHybridQueryWithEvidenceTableInput
    // (Rúnir-ekos B4) — no default needed or reachable here.
    evidenceTable: tableName,
    tuning,
    overlay,
    noemaRetrieval,
  } = input;

  // Fingerprint guard — prevent stale/mismatched embeddings from silently degrading results
  if (embeddingProvider) {
    const stored = await getEmbeddingFingerprint(db);
    const current = embeddingProvider.fingerprint();
    if (stored !== null && stored !== current) {
      warn?.(`embedding fingerprint mismatch — stored: ${stored} current: ${current}`);
      return [];
    }
    if (stored === null) {
      // Check if corpus is non-empty for this userId
      const countResult = await db.query<any>(
        `SELECT count() AS cnt FROM ${tableName} WHERE payload.userId = $userId ${activeFilter} GROUP ALL LIMIT 1;`,
        { userId },
      );
      const cnt = Number((countResult[0] ?? [])[0]?.cnt ?? 0);
      if (cnt > 0) {
        warn?.("no embedding fingerprint for non-empty corpus");
        return [];
      }
      // Empty corpus — allow through (fingerprint set on first write)
    }
  }

  // Phase 1: RRF retrieval. The reranked path MAY fetch a wider pool so the
  // reranker can rescue gold from deeper ranks (prior bug: both branches were
  // identical `limit*3`, so reranking never got a wider pool). The widening is
  // gated by RERANK_CANDIDATE_FLOOR, which DEFAULTS TO 0 (no widening) because a
  // live A/B found widening 15->50 adds ~0.5-1.3s/query on a large tenant; the
  // recall lift must be measured against that cost before defaulting it on
  // (Rúnir-aa98 step 3). With the default floor, prod behavior is unchanged.
  const isReranking = rerankerConfig && rerankerConfig.provider !== "off";
  const baseCandidateLimit = limit * 3;
  const candidateLimit = isReranking
    ? Math.max(baseCandidateLimit, RERANK_CANDIDATE_FLOOR)
    : baseCandidateLimit;

  // Anchor the global recall budget at the start of the DB legs (the embedding
  // fingerprint/corpus guards above are rare and run before this) so the sequential
  // RRF + noema waits can't exceed RECALL_BUDGET_MS (Rúnir-yxwe).
  const legsStartMs = Date.now();
  const rrf = await withTimeoutFlagged(
    () => nativeRrfSearch(
      db,
      userId,
      embedding,
      query,
      candidateLimit,
      scopeFilter,
      warn,
      undefined,
      trace,
      activeFilter,
      tableName,
      tuning,
      overlay,
    ),
    RETRIEVAL_DB_TIMEOUT_MS,
    [] as SearchHit[],
    "nativeRrfSearch DB query",
    warn,
  );
  const rrfHits = await enrichLinkedExactQaHits(db, rrf.value, query, userId, tuning?.entityLookupSessionId);
  const shouldQueryNoema = shouldRunNoemaLeg(noemaRetrieval, { timedOut: rrf.timedOut, hitCount: rrfHits.length });
  let noemaHits: SearchHit[] = [];
  if (shouldQueryNoema && noemaRetrieval) {
    // The noema leg gets whatever remains of the global budget (capped at the
    // per-leg timeout, floored at 0), so RRF + noema together stay within
    // RECALL_BUDGET_MS.
    const elapsedMs = Date.now() - legsStartMs;
    const noemaBudget = Math.min(RETRIEVAL_DB_TIMEOUT_MS, Math.max(0, RECALL_BUDGET_MS - elapsedMs));
    if (noemaBudget >= MIN_NOEMA_BUDGET_MS) {
      noemaHits = await withTimeout(
        () => queryNoemaCandidates(db, userId, query, embedding, candidateLimit, noemaRetrieval.requestedPath, warn),
        noemaBudget,
        [] as SearchHit[],
        "noema retrieval DB query",
        warn,
      );
    } else {
      warn?.(`memory-hybrid: skipping noema leg — recall budget exhausted (${elapsedMs}ms of ${RECALL_BUDGET_MS}ms used)`);
    }
  }
  // The noema-merged pool is clamped to candidateLimit (no override can widen it post
  // Rúnir-tp2w.3 strip) — behavior unchanged.
  const candidateHits = noemaRetrieval
    ? mergeNoemaRetrievalLeg(rrfHits, noemaHits, noemaRetrieval.policy, candidateLimit)
    : rrfHits;

  // rerankPool = the fused candidates the local reranker actually re-embeds/scores (the full
  // candidate pool).
  const rerankPool = candidateHits;

  // Debug-only sidecar (Rúnir-x41m.10/.11): emit the actual pre/post-reranker candidate orders +
  // effective windows. Built only when a listener is wired (production never pays the cost);
  // read-only — does not touch ranking. IDs are bare (extractId) to join against legRanks.
  const emitCandidateStages = (
    preHits: SearchHit[],
    postHits: SearchHit[],
    rerankerActive: boolean,
    rerankerThreshold?: number,
    rerankerScores?: Map<string, number>,
  ) => {
    if (!tuning?.onCandidateStages) return;
    tuning.onCandidateStages({
      candidateLimit,
      legFetchLimit: candidateLimit,
      fusionCandidateLimit: candidateLimit,
      rerankCandidateLimit: rerankPool.length,
      // Full fused+merged pool. Always the full candidateHits regardless of which emit path
      // (rerank-active passes the rerankPool as preHits; off-path passes candidateHits —
      // candidatePoolIds is candidateHits in both, and preRerankerIds always equals it since
      // no rerank-window slice exists post Rúnir-tp2w.3 strip).
      candidatePoolIds: candidateHits.map((h) => extractId(h.id)),
      preRerankerIds: preHits.map((h) => extractId(h.id)),
      postRerankerIds: postHits.map((h) => extractId(h.id)),
      rerankerActive,
      ...(rerankerThreshold !== undefined ? { rerankerThreshold } : {}),
      // Normalize score keys to bare ids: strip table prefix AND backtick quoting (SurrealDB
      // quotes hyphenated ids), which also dedupes the bare/backtick aliases the local reranker
      // emits — the envelope contract promises bare ids (architect L2-review).
      ...(rerankerScores
        ? { rerankerScores: Object.fromEntries(Array.from(rerankerScores, ([k, v]) => [extractId(k).replace(/`/g, ""), v])) }
        : {}),
    });
  };

  if (candidateHits.length === 0 || !isReranking) {
    emitCandidateStages(candidateHits, candidateHits, false);
    return candidateHits;
  }

  // The rerank stage runs AFTER RRF + noema. Bound it with whatever remains of the
  // budget, anchored at the same legsStartMs as the RRF + noema legs, so a stalled
  // Ollama (local path) or slow OpenRouter (llm path) cannot hold the whole recall
  // open past RECALL_BUDGET_MS — the same outage class as the stacked-timeout cascade
  // (Rúnir-yxwe/imaf.10, Rúnir-ogkn.3).
  const rerankElapsedMs = Date.now() - legsStartMs;
  const rerankBudget = Math.max(0, RECALL_BUDGET_MS - rerankElapsedMs);
  if (rerankBudget < MIN_RERANK_BUDGET_MS) {
    // Budget already spent by RRF + noema — skip the rerank stage entirely and return
    // the fused (pre-rerank) order rather than burn the tail on a near-certain timeout.
    warn?.(`memory-hybrid: skipping rerank stage — recall budget exhausted (${rerankElapsedMs}ms of ${RECALL_BUDGET_MS}ms used)`);
    emitCandidateStages(candidateHits, candidateHits, false);
    return candidateHits;
  }

  // Phase 2: Rerank via provider router (over rerankPool = the full candidate pool).
  // Race the stage against the remaining budget. On timeout, abort the controller (so
  // the local path's in-flight embeds lose their race and stop holding the stage open)
  // and degrade to the fused order via the existing empty-result contract. The timeout
  // is signalled by rerankRace.timedOut; the fallback value is never read on that path.
  const rerankController = new AbortController();
  const rerankRace = await withTimeoutFlagged(
    rerankWithProvider(
      rerankerConfig,
      query,
      rerankPool.map((h) => ({ id: h.id, text: h.text, embedding: h.embedding })),
      embeddingProvider,
      warn,
      { signal: rerankController.signal, budgetMs: rerankBudget },
    ),
    rerankBudget,
    { scores: new Map(), labels: new Map(), threshold: 0 },
    "rerank stage",
    warn,
  );
  if (rerankRace.timedOut) {
    // Release the local path's leaked embeds and return fused order. The underlying
    // promise keeps running but its result is discarded.
    rerankController.abort();
    emitCandidateStages(candidateHits, candidateHits, false);
    return candidateHits;
  }
  const { scores, labels, threshold } = rerankRace.value;

  // Empty scores = provider failed or had nothing to say — return RRF results as-is
  if (scores.size === 0) {
    emitCandidateStages(candidateHits, candidateHits, false);
    return candidateHits;
  }

  // Attach reranker scoreStages attribution (over the full candidate pool)
  attachRerankerStages(rerankPool, scores, labels, threshold);

  // --- Trace: reranker stage ---
  if (trace) {
    const rrfIds = rerankPool.map((h) => h.id);
    const rerankedIds = rerankPool.filter((h) => scores.has(h.id)).map((h) => h.id);
    const rerankedScores = rerankedIds.map((id) => scores.get(id)!);
    trace.startStage("reranker", rrfIds);
    trace.endStage(rerankedIds, rerankedScores);
  }

  // Apply threshold filtering and re-sort by reranker score
  const exactQaIntent = detectExactQaIntent(query);
  const finalHits = applyRerankScores(rerankPool, scores, threshold, {
    preserve: (hit) => exactQaIntent && (hit.exactQaCandidate === true || scoreExactQaCandidate(query, hit) >= 0.55),
    // Default-OFF (Rúnir-qjn4.3 R3): undefined unless the orchestrator resolves a
    // floor from an enabled exact_qa_preserve_floor plan entry. undefined → today's
    // byte-identical preserve-pass-through.
    ...(tuning?.exactQaPreserveFloor !== undefined ? { preserveFloor: tuning.exactQaPreserveFloor } : {}),
  });

  // --- Trace: threshold_filter stage ---
  if (trace) {
    const preFilterIds = rerankPool.filter((h) => scores.has(h.id)).map((h) => h.id);
    const finalIds = finalHits.map((h) => h.id);
    const finalScores = finalHits.map((h) => h.score);
    trace.startStage("threshold_filter", preFilterIds);
    trace.endStage(finalIds, finalScores);
  }

  emitCandidateStages(rerankPool, finalHits, true, threshold, scores);
  return finalHits;
}

export async function runHybridQueryWithEvidenceTableAndEntityTrace(
  input: RunHybridQueryWithEvidenceTableInput,
): Promise<RunHybridQueryWithEntityTraceOutput> {
  const entityMatches: EntityRetrievalTraceMatch[] = [];
  let legRanks: LegRanks = {};
  const hits = await runHybridQueryWithEvidenceTable({
    ...input,
    tuning: {
      ...input.tuning,
      onEntityTrace: (matches) => {
        entityMatches.push(...matches);
        input.tuning?.onEntityTrace?.(matches);
      },
      onLegRanks: (lr) => {
        legRanks = lr;
        input.tuning?.onLegRanks?.(lr);
      },
    },
  });
  return { hits, entityMatches, legRanks };
}
