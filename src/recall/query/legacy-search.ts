// Standalone vector and BM25 searches used by the tool-call path (memory_search).
// Split out of memory-query.ts (vk-2996).
import {
  BM25_STATS_TTL_MS,
  type MemoryRecordTable,
  PRIMARY_MEMORY_TABLE,
  type Bm25CorpusStats,
  type SearchHit,
} from "../../domain/memory/types";
import {
  ACTIVE_MEMORY_FILTER,
  extractId,
  getBm25CorpusStats,
  mapMemoryRowToSearchHit,
  type SurrealClient,
} from "../../storage/surreal/surreal-store";
import { attachSelectedSearchHitLineage } from "../../domain/memory/search-hit-lineage.js";
import type { ScopeFilter } from "./scope-predicate";
import { tokenizeText, significantQueryTokens, countTermFrequency, bm25Score } from "./query-text.js";

/**
 * Executes vector similarity retrieval against SurrealDB embeddings, optionally filtered by scope.
 *
 * Still used by the tool-call path (memory_search) when individual per-stage score attribution
 * is needed (e.g. showing vector vs BM25 scores separately). For the main hybrid retrieval
 * pipeline, prefer `nativeRrfSearch` (native-rrf-search.ts), which fuses both stages server-side.
 */
export async function vectorSearch(
  db: SurrealClient,
  userId: string,
  embedding: number[],
  limit: number,
  scopeFilter?: ScopeFilter,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<SearchHit[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
  const sf = scopeFilter ?? { whereClause: "", vars: {} };
  const vecStr = `[${embedding.join(",")}]`;
  const results = await db.query<any>(
    `SELECT id, payload, processing_lineage, vector::similarity::cosine(embedding, ${vecStr}) AS sim
     FROM ${tableName}
     WHERE payload.userId = $userId AND embedding != NONE ${ACTIVE_MEMORY_FILTER} ${sf.whereClause}
     ORDER BY sim DESC
     LIMIT $limit;`,
    { userId, limit: safeLimit, ...sf.vars },
  );
  const rows = results[0] ?? [];
  return rows.map((r: any, idx: number) => {
    const hit = attachSelectedSearchHitLineage(
      mapMemoryRowToSearchHit({ ...r, score: r.sim ?? 0 }),
      r?.processing_lineage,
    );
    hit.scoreStages = {
      vector: {
        score: r.sim ?? 0,
        rank: idx + 1,
      },
    };
    return hit;
  });
}

/**
 * Executes BM25 full-text retrieval with app-side scoring and cacheable corpus stats, optionally filtered by scope.
 *
 * Still used by the tool-call path (memory_search) when individual per-stage score attribution
 * is needed (e.g. showing vector vs BM25 scores separately). For the main hybrid retrieval
 * pipeline, prefer `nativeRrfSearch` (native-rrf-search.ts), which fuses both stages server-side.
 */
export async function bm25Search(
  db: SurrealClient,
  userId: string,
  queryText: string,
  limit: number,
  statsCache: Map<string, Bm25CorpusStats>,
  scopeFilter?: ScopeFilter,
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName: MemoryRecordTable = PRIMARY_MEMORY_TABLE,
): Promise<SearchHit[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
  const sf = scopeFilter ?? { whereClause: "", vars: {} };
  const queryTokens = significantQueryTokens(queryText);
  if (queryTokens.length === 0) {
    return [];
  }

  const queryTerms = queryTokens.map((t) => t.replace(/"/g, "\\\""));
  const fulltextQuery = queryTerms.join(" ");
  const matchOperator = queryTokens.length > 1 ? "@0,OR@" : "@0@";
  // NOTE: Inline query text (no bound param for MATCHES) — required by SurrealDB design;
  // bug where MATCHES returns all rows instead of matching rows.
  const escapedFtQuery = fulltextQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  try {
    const [matchesRes, stats] = await Promise.all([
      db.query<any>(
        `SELECT id, payload, processing_lineage, text_norm
         FROM ${tableName}
         WHERE payload.userId = $userId AND text_norm ${matchOperator} '${escapedFtQuery}' ${ACTIVE_MEMORY_FILTER} ${sf.whereClause}
         LIMIT $limit;`,
        { userId, limit: safeLimit, ...sf.vars },
      ),
      getBm25CorpusStats(db, userId, statsCache, BM25_STATS_TTL_MS, tableName),
    ]);

    const rows = matchesRes[0] ?? [];
    if (rows.length === 0) {
      return [];
    }

    const docs = rows.map((r: any) => {
      const textNorm = String(r.text_norm ?? "");
      const tokens = tokenizeText(textNorm);
      return {
        raw: r,
        tokens,
        docLength: tokens.length || 1,
      };
    });

    const docFreqByTerm = new Map<string, number>();
    for (const term of queryTokens) {
      let df = 0;
      for (const doc of docs) {
        if (doc.tokens.includes(term)) {
          df += 1;
        }
      }
      docFreqByTerm.set(term, df);
    }

    const scored = docs
      .map((doc) => {
        let score = 0;
        const matchedTerms: string[] = [];
        for (const term of queryTokens) {
          const tf = countTermFrequency(doc.tokens, term);
          const df = docFreqByTerm.get(term) ?? 0;
          const termScore = bm25Score(tf, doc.docLength, stats.avgDocLength, stats.totalDocs, df);
          score += termScore;
          if (termScore > 0) matchedTerms.push(term);
        }

        return {
          raw: doc.raw,
          id: extractId(doc.raw.id),
          text: doc.raw.payload?.l2 ?? doc.raw.payload?.data ?? "",
          score,
          createdAt: doc.raw.payload?.createdAt,
          updatedAt: doc.raw.payload?.updatedAt,
          tags: doc.raw.payload?.tags,
          path: doc.raw.payload?.path ?? undefined,
          _matchedTerms: matchedTerms,
        };
      })
      .filter((h) => Number.isFinite(h.score) && h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, safeLimit);

    // Attach bm25 scoreStages with rank (rank is 1-based after sort)
    const withStages: SearchHit[] = scored.map((h, idx) => {
      const hit = attachSelectedSearchHitLineage(
        mapMemoryRowToSearchHit({ ...h.raw, score: h.score }),
        h.raw?.processing_lineage,
      );
      hit.scoreStages = {
        bm25: {
          score: h.score,
          rank: idx + 1,
          matchedTerms: h._matchedTerms,
        },
      };
      return hit;
    });

    return withStages;
  } catch {
    return [];
  }
}
