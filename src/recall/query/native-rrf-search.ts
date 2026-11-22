// nativeRrfSearch: runs the retrieval legs in parallel and fuses them.
// Split out of memory-query.ts (vk-2996).
import {
  type MemoryRecordTable,
  PRIMARY_MEMORY_TABLE,
  ENTITY_LEG_TIMEOUT_MS,
  type ScoreStageAttribution,
  type SearchHit,
} from "../../domain/memory/types";
import { ACTIVE_MEMORY_FILTER, extractId, type SurrealClient } from "../../storage/surreal/surreal-store";
import { attachSelectedSearchHitLineage } from "../../domain/memory/search-hit-lineage.js";
import type { ScopeFilter } from "./scope-predicate";
import type { TraceCollector } from "../selection/retrieval-trace";
import { mergeOverlayLeg, type OverlayRetrievalHandle } from "./overlay-merge.js";
import { EMPTY_PROFILE } from "../policy/ranking-profile.js";
import { detectExactQaIntent, exactQaTokens, scoreExactQaCandidate } from "../../domain/memory/exact-qa.js";
import { withTimeout } from "./retrieval-timeouts.js";
import { expandRetrievalQuery } from "./query-text.js";
import { RECENCY_WINDOW_HOURS } from "./retrieval-types.js";
import type { RecencyRow, EntityRow, LegRanks, HybridQueryTuningOptions } from "./retrieval-types.js";
import { queryVectorLeg, queryBm25Leg, queryRecencyLeg } from "./retrieval-legs.js";
import { queryEntityLeg, emptyEntityLeg } from "./entity-leg.js";
import { defaultRrfEntityWeight, rrfFuse } from "./rrf-fusion.js";

// ---------------------------------------------------------------------------
// Step 3: Parallel nativeRrfSearch
// ---------------------------------------------------------------------------

/**
 * Runs hybrid retrieval (vector + BM25 + recency) with **parallel independent queries**
 * and app-side RRF fusion.
 *
 * Each retrieval leg (KNN vector, BM25 full-text, recency) fires as a separate
 * SurrealDB query via `Promise.all`, so wall-clock time ≈ max(leg times) instead of
 * sum(leg times). Results are fused client-side using weighted reciprocal rank fusion.
 *
 * Weights flow via `tuning.rrfWeights` and are honored in `rrfFuse`.
 * @param recencyWindowHours  How far back to look for recency candidates (default: 48h).
 *                            Set to 0 to disable the recency list entirely.
 */
export async function nativeRrfSearch(
  db: SurrealClient,
  userId: string,
  embedding: number[],
  queryText: string,
  limit: number,
  scopeFilter?: ScopeFilter,
  warn?: (msg: string) => void,
  recencyWindowHours: number = RECENCY_WINDOW_HOURS,
  trace?: TraceCollector,
  activeFilter: string = ACTIVE_MEMORY_FILTER,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
  tuning?: HybridQueryTuningOptions,
  overlay?: OverlayRetrievalHandle,
): Promise<SearchHit[]> {
  const totalT0 = performance.now();
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
  const sf = scopeFilter ?? { whereClause: "", vars: {} };
  const resolvedRecencyWindowHours = tuning?.recencyWindowHours ?? recencyWindowHours;
  const includeRecency = resolvedRecencyWindowHours > 0;
  const nowMs = tuning?.nowMs ?? Date.now();
  // Resolve the per-tenant ranking profile slices for this request (Rúnir-mmg2).
  // With no profile, these are the clean EMPTY_PROFILE slices = no query
  // expansion + no entity-mention filler filtering beyond generic stopwords.
  const rankingProfile = tuning?.rankingProfile ?? EMPTY_PROFILE;
  const expandedQueryText = expandRetrievalQuery(queryText, rankingProfile.taxonomyExpansionFacets);
  const exactQaIntent = detectExactQaIntent(queryText);

  // Recency cutoff (ISO string)
  const recencyCutoff = includeRecency
    ? new Date(nowMs - resolvedRecencyWindowHours * 3600 * 1000).toISOString()
    : "";

  try {
    // --- Stage 1: Parallel retrieval legs ---
    const parallelT0 = performance.now();
    const [vsResult, ftResult, rcResult, enResult] = await Promise.all([
      queryVectorLeg(db, userId, embedding, safeLimit, sf, activeFilter, tableName),
      queryBm25Leg(db, userId, expandedQueryText, safeLimit, sf, activeFilter, tableName),
      includeRecency
        ? queryRecencyLeg(db, userId, recencyCutoff, safeLimit, sf, activeFilter, tableName)
        : Promise.resolve({ rows: [] as RecencyRow[], ms: 0 }),
      // Bound the entity leg: its sequential per-match N+1 lookups can run several
      // seconds and, since all legs share one Promise.all, a slow entity leg dragged
      // the whole RRF to the 8s outer timeout. Capping it keeps RRF fast and degrades
      // entity hits to an entity_timeout trace instead of an outage (Rúnir-yxwe).
      withTimeout(
        () => queryEntityLeg(db, userId, expandedQueryText, safeLimit, sf, activeFilter, tableName, tuning?.entityLookupSessionId, rankingProfile.entityFillerWords)
          .catch(() => emptyEntityLeg(expandedQueryText, "entity_lookup_failed", rankingProfile.entityFillerWords)),
        ENTITY_LEG_TIMEOUT_MS,
        () => emptyEntityLeg(expandedQueryText, "entity_timeout", rankingProfile.entityFillerWords),
        "entity leg DB query",
        warn,
      ),
    ]);
    const parallelMs = performance.now() - parallelT0;
    tuning?.onEntityTrace?.(enResult.traceMatches);

    const vsRows = vsResult.rows;
    const ftRows = ftResult.rows;
    const rcRows = rcResult.rows;
    const enRows = enResult.rows;

    // --- Trace: record vector + bm25 search stages ---
    if (trace) {
      const vsIds = vsRows.map((r) => extractId(r.id));
      trace.startStage("vector_search", []);
      trace.endStage(vsIds);
      const nativeBm25Ids = ftRows.slice(0, ftResult.nativeCount).map((r) => extractId(r.id));
      trace.startStage("bm25_search", []);
      trace.endStage(nativeBm25Ids);
      if (ftResult.fallbackCount > 0) {
        const fallbackIds = ftRows.map((r) => extractId(r.id));
        trace.startStage("bm25_fallback", []);
        trace.endStage(fallbackIds);
      }
      const rcIds = rcRows.map((r) => extractId(r.id));
      trace.startStage("recency_search", []);
      trace.endStage(rcIds);
      const enIds = enRows.map((r) => extractId(r.id));
      trace.startStage("entity_search", []);
      trace.endStage(enIds, enRows.map((r) => r.score));
    }

    // --- App-side RRF fusion ---
    const fuseT0 = performance.now();
    const fusedAll = rrfFuse(vsRows, ftRows, rcRows, enRows, 60, tuning?.rrfWeights);
    const fusedRows = fusedAll.slice(0, safeLimit);
    const fuseMs = performance.now() - fuseT0;

    // --- Trace: record RRF fusion stage ---
    if (trace) {
      const allLegIds = new Set<string>();
      for (const r of vsRows) allLegIds.add(extractId(r.id));
      for (const r of ftRows) allLegIds.add(extractId(r.id));
      for (const r of rcRows) allLegIds.add(extractId(r.id));
      for (const r of enRows) allLegIds.add(extractId(r.id));
      const fusedIds = fusedRows.map((r) => extractId(r.id));
      const fusedScores = fusedRows.map((r) => r.score);
      trace.startStage("rrf_fusion", [...allLegIds]);
      trace.endStage(fusedIds, fusedScores);
    }

    // --- Layer-2 sidecar (Rúnir-x41m.10): per-unit per-leg ranks. Debug-only (built solely
    // when a listener is wired by the trace route); emitted via callback, NOT the frozen
    // RetrievalTrace (ADR-0008). rrf rank is over fusedAll so ranks past the top slice survive. ---
    if (tuning?.onLegRanks) {
      const legRanks: LegRanks = {};
      vsRows.forEach((r, i) => { (legRanks[extractId(r.id)] ??= {}).vector = i + 1; });
      ftRows.forEach((r, i) => { (legRanks[extractId(r.id)] ??= {}).bm25 = i + 1; });
      rcRows.forEach((r, i) => { (legRanks[extractId(r.id)] ??= {}).recency = i + 1; });
      enRows.forEach((r, i) => { (legRanks[extractId(r.id)] ??= {}).entity = i + 1; });
      fusedAll.forEach((r, i) => { (legRanks[extractId(r.id)] ??= {}).rrf = i + 1; });
      tuning.onLegRanks(legRanks);
    }

    if (fusedRows.length === 0) {
      const totalMs = performance.now() - totalT0;
      warn?.(`memory-hybrid: parallel retrieval — vector: ${vsResult.ms.toFixed(0)}ms (${vsRows.length}), bm25(native=${ftResult.nativeCount}, fallback=${ftResult.fallbackCount}) ${ftResult.ms.toFixed(0)}ms (${ftRows.length}), recency: ${rcResult.ms.toFixed(0)}ms (${rcRows.length}), entity: ${enResult.ms.toFixed(0)}ms (${enRows.length}), fusion: ${fuseMs.toFixed(1)}ms, payload: 0ms, total: ${totalMs.toFixed(0)}ms [0 results]`);
      return [];
    }

    // --- Stage 2: Fetch full records for fused top-K only ---
    const payloadT0 = performance.now();
    const fusedIdRefs = fusedRows.map((r) => r.id);
    // embedding is projected here so rerankLocal can cosine-score candidates against
    // already-fetched stored vectors instead of re-embedding via Ollama. Adds ~50×768
    // floats of transient memory per recall; never serialised to the wire. Candidates
    // from BM25/entity/recency legs whose embedding column is NONE in the DB carry
    // undefined here, triggering the fallback embedDocument path in rerankLocal.
    const fullResults = await db.query<any>(
      `SELECT id, payload, processing_lineage, active, inactive_reason, superseded_by, lineage_root_id, memory_role, valid_at, invalid_at, embedding FROM ${tableName} WHERE id IN $ids;`,
      { ids: fusedIdRefs },
    );
    const fullRows: any[] = fullResults[0] ?? [];
    const payloadMs = performance.now() - payloadT0;

    const payloadById = new Map<string, any>();
    for (const r of fullRows) {
      payloadById.set(extractId(r.id), {
        payload: r.payload,
        active: r.active,
        inactiveReason: r.inactive_reason,
        supersededById: r.superseded_by ? extractId(r.superseded_by) : undefined,
        lineageRootId: r.lineage_root_id ? extractId(r.lineage_root_id) : undefined,
        memoryRole: r.memory_role ?? r.payload?.memoryRole,
        validAt: r.valid_at ?? r.payload?.validAt,
        invalidAt: r.invalid_at ?? r.payload?.invalidAt,
        processingLineage: r.processing_lineage,
        // undefined when embedding column is NONE (BM25/entity/recency-only candidates).
        embedding: Array.isArray(r.embedding) ? (r.embedding as number[]) : undefined,
      });
    }

    // Build lookup maps for sub-query scores (for scoreStages attribution)
    const vectorScoreById = new Map<string, { score: number; rank: number }>();
    for (const r of vsRows) {
      vectorScoreById.set(extractId(r.id), { score: 1, rank: r.rank });
    }

    const bm25ScoreById = new Map<string, { score: number; rank: number; source: "native" | "fallback"; matchedTerms?: string[] }>();
    for (const r of ftRows) {
      bm25ScoreById.set(extractId(r.id), {
        score: r.score,
        rank: r.rank,
        source: r.source,
        matchedTerms: r.matchedTerms,
      });
    }

    const recencyById = new Map<string, { rank: number; createdAt: string }>();
    for (const r of rcRows) {
      recencyById.set(extractId(r.id), { rank: r.rank, createdAt: r.createdAt });
    }

    const entityById = new Map<string, EntityRow>();
    for (const r of enRows) {
      entityById.set(extractId(r.id), r);
    }

    // Map fused results to SearchHit[], merging payload from Stage 2
    const hits: SearchHit[] = fusedRows.map((r) => {
      const id = extractId(r.id);
      const row = payloadById.get(id);
      const payload = row?.payload;
      const vecStage = vectorScoreById.get(id);
      const bm25Stage = bm25ScoreById.get(id);
      const recencyStage = recencyById.get(id);
      const entityStage = entityById.get(id);

      const scoreStages: ScoreStageAttribution = {
        rrf: {
          score: r.score,
          vectorRank: r.vectorRank,
          bm25Rank: r.bm25Rank,
          recencyRank: r.recencyRank,
          entityRank: r.entityRank,
        },
      };
      if (vecStage) {
        scoreStages.vector = { score: vecStage.score, rank: vecStage.rank };
      }
      if (bm25Stage) {
        scoreStages.bm25 = {
          score: bm25Stage.score,
          rank: bm25Stage.rank,
          source: bm25Stage.source,
          matchedTerms: bm25Stage.matchedTerms,
        };
      }
      if (recencyStage) {
        // Compute human-readable age
        const ageMs = nowMs - new Date(recencyStage.createdAt).getTime();
        const ageHours = Math.round(ageMs / 3600000);
        const age = ageHours < 1 ? "<1h" : ageHours < 24 ? `${ageHours}h` : `${Math.round(ageHours / 24)}d`;
        scoreStages.recency = { rank: recencyStage.rank, age };
      }
      if (entityStage) {
        scoreStages.entity = {
          score: entityStage.score,
          rank: entityStage.rank,
          matchedEntities: [...new Set(entityStage.matchedEntities)],
          boost: (tuning?.rrfWeights?.entity ?? defaultRrfEntityWeight()) / (60 + entityStage.rank),
          scoreBefore: r.score - ((tuning?.rrfWeights?.entity ?? defaultRrfEntityWeight()) / (60 + entityStage.rank)),
          scoreAfter: r.score,
        };
      }

      return attachSelectedSearchHitLineage({
        id,
        text: payload?.l2 ?? payload?.data ?? "",
        score: r.score,
        createdAt: payload?.createdAt,
        updatedAt: payload?.updatedAt,
        tags: payload?.tags,
        category: payload?.category,
        tier: payload?.tier,
        confidence: payload?.confidence,
        l0: payload?.l0 ?? undefined,
        l1: payload?.l1 ?? undefined,
        raw_source_text: typeof payload?.raw_source_text === "string" ? payload.raw_source_text : undefined,
        rawSpan: payload?.rawSpan,
        rawSpans: Array.isArray(payload?.rawSpans) ? payload.rawSpans : undefined,
        atomicFact: payload?.atomicFact,
        event: payload?.event,
        atomicClaims: Array.isArray(payload?.atomicClaims) ? payload.atomicClaims : undefined,
        path: payload?.path ?? undefined,
        client: payload?.client ?? undefined,
        // MIM-69 Task 14: staleness metadata from payload
        isStale: payload?.isStale ?? undefined,
        staleSince: payload?.staleSince ?? undefined,
        contradictedBy: payload?.contradictedBy ?? undefined,
        active: row?.active,
        inactiveReason: row?.inactiveReason,
        supersededById: row?.supersededById,
        lineageRootId: row?.lineageRootId,
        // Continuity fields — fetched from top-level columns in stage 2
        memoryRole: row?.memoryRole,
        validAt: row?.validAt,
        invalidAt: row?.invalidAt,
        continuitySubjectKey: payload?.continuitySubjectKey,
        scoreStages,
        // Transient: stored vector for rerankLocal cosine path; undefined → falls back to embedDocument.
        embedding: row?.embedding,
      }, row?.processingLineage);
    }).map((hit: SearchHit): SearchHit => {
      if (!exactQaIntent) return hit;
      const exactScore = scoreExactQaCandidate(queryText, hit);
      if (exactScore <= 0) return hit;
      return {
        ...hit,
        score: hit.score + exactScore * 0.05,
        exactQaCandidate: exactScore >= 0.5,
        exactQaScore: exactScore,
        scoreStages: {
          ...hit.scoreStages,
          exact: {
            score: exactScore,
            matchedTokens: exactQaTokens(queryText).filter((token) =>
              [
                hit.text,
                hit.l0,
                hit.l1,
                hit.raw_source_text,
                hit.rawSpan?.text,
                ...(hit.rawSpans ?? []).map((span) => span.text),
                ...(hit.atomicClaims ?? []).flatMap((claim) => [claim.text, claim.value, claim.rawSpanText]),
              ]
                .filter((value): value is string => typeof value === "string")
                .some((value) => value.toLowerCase().includes(token.toLowerCase())),
            ),
          },
        },
      };
    }).sort((a, b) => b.score - a.score).filter((hit) => hit.text || !hit.scoreStages?.entity);

    // Overlay leg: merge in-memory write-through overlay against the durable
    // RRF result. ADR 0009 §Read semantics + §Active-filter batching +
    // §Dedupe-precedence rule pin the contract; the merge is a no-op when
    // `overlay` is not supplied or the per-userId snapshot is empty.
    const finalHits = overlay
      ? await mergeOverlayLeg({ db, userId, overlay, durableHits: hits, tableName })
      : hits;

    const totalMs = performance.now() - totalT0;
    warn?.(`memory-hybrid: parallel retrieval — vector: ${vsResult.ms.toFixed(0)}ms (${vsRows.length}), bm25(native=${ftResult.nativeCount}, fallback=${ftResult.fallbackCount}) ${ftResult.ms.toFixed(0)}ms (${ftRows.length}), recency: ${rcResult.ms.toFixed(0)}ms (${rcRows.length}), entity: ${enResult.ms.toFixed(0)}ms (${enRows.length}), wall: ${parallelMs.toFixed(0)}ms, fusion: ${fuseMs.toFixed(1)}ms, payload: ${payloadMs.toFixed(0)}ms, total: ${totalMs.toFixed(0)}ms [${finalHits.length} results]`);

    return finalHits;
  } catch (err) {
    const msg = `memory-hybrid: nativeRrfSearch failed: ${err instanceof Error ? err.message : String(err)}`;
    (warn ?? ((_m: string) => {}))(msg);
    return [];
  }
}
