import {
  BM25_B,
  BM25_K1,
  BM25_STATS_TTL_MS,
  type MemoryRecordTable,
  PRIMARY_MEMORY_TABLE,
  RETRIEVAL_DB_TIMEOUT_MS,
  ENTITY_LEG_TIMEOUT_MS,
  RECALL_BUDGET_MS,
  MIN_NOEMA_BUDGET_MS,
  MIN_RERANK_BUDGET_MS,
  type Bm25CorpusStats,
  type RerankerConfig,
  type ScoreStageAttribution,
  type SearchHit,
} from "../../domain/memory/types";
import { RecordId } from "surrealdb";
import type { EmbeddingProvider } from "../../storage/embeddings/providers/embedding-provider";
import {
  ACTIVE_MEMORY_FILTER,
  extractId,
  getBm25CorpusStats,
  getEmbeddingFingerprint,
  mapMemoryRowToSearchHit,
  type SurrealClient,
} from "../../storage/surreal/surreal-store";
import type { ScopeFilter } from "./scope-predicate";
import { rerankWithProvider, attachRerankerStages } from "../../storage/reranking/ranker";
import { RERANK_CANDIDATE_FLOOR } from "../../shared/config";
import { applyRerankScores } from "../selection/recall-selection";
import type { TraceCollector } from "../selection/retrieval-trace";
import {
  mergeOverlayLeg,
  type OverlayRetrievalHandle,
} from "./overlay-merge.js";
import {
  mergeNoemaRetrievalLeg,
  type NoemaRetrievalPolicy,
} from "../policy/noema-retrieval-policy.js";
import { findEntitiesByAliases, findEntitiesByNames, findEntityByName, getSupportingMemoryIdsBatch } from "../../entities/entity-store";
import { normalizeEntityName } from "../../entities/entity-arbitrator";
import {
  EMPTY_PROFILE,
  type RankingProfile,
  type TaxonomyExpansionFacet,
} from "../policy/ranking-profile.js";
import type { MemoryScope } from "../../domain/memory/types";
import {
  detectExactQaIntent,
  exactQaTokens,
  scoreExactQaCandidate,
} from "../../domain/memory/exact-qa.js";

export type { OverlayRetrievalHandle } from "./overlay-merge.js";

export type NoemaRetrievalLegOptions = {
  policy: NoemaRetrievalPolicy;
  requestedPath?: string;
};

const BM25_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "how", "i", "if", "in", "into",
  "is", "it", "its", "let", "me", "my", "of", "on", "or", "our", "should", "that", "the", "their", "them", "there",
  "these", "they", "this", "those", "to", "up", "us", "was", "we", "what", "when", "where", "which", "who", "why",
  "will", "with", "you", "your",
]);
const MAX_ENTITY_QUERY_CANDIDATES = 16;
const MAX_ENTITY_MATCHES_PER_CANDIDATE = 6;
const MAX_ENTITY_LINKED_IDS_PER_MATCH = 25;
const MAX_ENTITY_ROWS = 50;
// Cap concurrent entity prefetch fan-out: many candidates × matches could otherwise
// fire ~candidates×MAX_ENTITY_MATCHES_PER_CANDIDATE queries at once and overwhelm the
// shared SurrealDB connection. 8-wide keeps the small common case fully parallel while
// bounding the tail (Rúnir-yxwe Part B).
// Entity-mention filler words are tenant data (Rúnir-mmg2): they're tuned against
// the runir tenant's own corpus + LoCoMo fixtures, so they live in a per-tenant
// ranking profile and are passed into entityMentionCandidates as a parameter.
// With no profile (fresh tenant) the set is empty → only generic BM25 stopwords
// filter candidates. See src/recall/policy/ranking-profile.ts.

export interface EntityRetrievalTraceMatch {
  queryMention: string;
  normalizedMention: string;
  entityId?: string;
  canonicalName?: string;
  matchedBy?: "name" | "alias";
  scope?: MemoryScope;
  linkedMemoryIds: string[];
  scoreChanges?: Array<{ memoryId: string; before: number; boost: number; after: number }>;
  ignoredReason?: string;
}

type EntityLookupScope = { scope: MemoryScope; sessionId?: string };

/** Races a promise against a timeout, reporting whether the timeout fired. Callers
 *  need to distinguish a COMPLETED result (even an empty one) from a TIMED-OUT one:
 *  the annotation-noema leg must run only after a completed-empty RRF, never after
 *  an RRF timeout — otherwise two stacked 8s waits return zero hits (Rúnir-yxwe). */
export function withTimeoutFlagged<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T | (() => T),
  label: string,
  warn?: (msg: string) => void,
): Promise<{ value: T; timedOut: boolean }> {
  // The timer MUST be cleared when the race settles: a lost race does not cancel
  // setTimeout, so the warn callback still fired ms later on every SUCCESSFUL call
  // — the log filled with phantom "timed out after 5000ms/8000ms" lines from
  // requests that completed in well under a second, which repeatedly misdirected
  // perf debugging toward timeouts that never happened.
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then((value) => ({ value, timedOut: false })),
    new Promise<{ value: T; timedOut: boolean }>((resolve) => {
      timer = setTimeout(() => {
        warn?.(`memory-hybrid: ${label} timed out after ${ms}ms, returning fallback`);
        // Resolve the fallback lazily so an expensive default (e.g. building the
        // entity-leg trace) is only constructed when the timeout actually fires,
        // not on every hot-path recall that completes in time.
        resolve({ value: typeof fallback === "function" ? (fallback as () => T)() : fallback, timedOut: true });
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Races a promise against a timeout. On timeout, resolves to the fallback value
 *  (lazily, when the fallback is a thunk). */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T | (() => T),
  label: string,
  warn?: (msg: string) => void,
): Promise<T> {
  return withTimeoutFlagged(promise, ms, fallback, label, warn).then((r) => r.value);
}

/** Gate for the noema retrieval leg. Primary-mode noema always runs; annotation-mode
 *  noema runs ONLY after a COMPLETED-empty RRF — never after an RRF timeout/error.
 *  Previously an RRF timeout (rrfHits=[]) re-triggered annotation noema, stacking a
 *  second 8s wait on the first for a 16s zero-hit recall outage (Rúnir-yxwe). */
export function shouldRunNoemaLeg(
  noemaRetrieval: NoemaRetrievalLegOptions | undefined,
  rrf: { timedOut: boolean; hitCount: number },
): boolean {
  if (!noemaRetrieval) return false;
  if (noemaRetrieval.policy.mode === "primary") return true;
  if (noemaRetrieval.policy.mode === "annotation") return !rrf.timedOut && rrf.hitCount === 0;
  return false;
}

export function tokenizeText(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}_]+/gu);
  return tokens ?? [];
}

export function significantQueryTokens(text: string): string[] {
  const tokens = tokenizeText(text);
  const filtered = tokens.filter((token) => token.length > 2 && !BM25_STOPWORDS.has(token));
  return filtered.length > 0 ? Array.from(new Set(filtered)) : Array.from(new Set(tokens));
}

const MAX_TAXONOMY_EXPANSION_TERMS = 4;

// Taxonomy expansion facets are tenant data (Rúnir-mmg2): they encode the runir
// tenant's career/education query-expansion tuning, so they live in a per-tenant
// ranking profile and are passed into expandRetrievalQuery as a parameter. With
// no profile the facet list is empty → no expansion (queryText unchanged).
// The TaxonomyExpansionFacet type is imported from ../policy/ranking-profile.js.

export function expandRetrievalQuery(
  queryText: string,
  taxonomyExpansionFacets: readonly TaxonomyExpansionFacet[] = EMPTY_PROFILE.taxonomyExpansionFacets,
): string {
  const tokens = significantQueryTokens(queryText);
  const matchingFacets = taxonomyExpansionFacets.filter((facet) =>
    tokens.some((token) => facet.signals.has(token)),
  );
  if (matchingFacets.length === 0) {
    return queryText;
  }

  const existingTokens = new Set(tokenizeText(queryText));
  const additions: string[] = [];
  const addedTokens = new Set<string>();
  const maxFacetTerms = Math.max(...matchingFacets.map((facet) => facet.terms.length));
  for (let termIndex = 0; termIndex < maxFacetTerms; termIndex += 1) {
    for (const facet of matchingFacets) {
      const term = facet.terms[termIndex];
      if (term === undefined) {
        continue;
      }
      const termTokens = tokenizeText(term);
      if (termTokens.every((token) => existingTokens.has(token) || addedTokens.has(token))) {
        continue;
      }
      additions.push(term);
      for (const token of termTokens) {
        addedTokens.add(token);
      }
      if (additions.length >= MAX_TAXONOMY_EXPANSION_TERMS) {
        break;
      }
    }
    if (additions.length >= MAX_TAXONOMY_EXPANSION_TERMS) {
      break;
    }
  }

  if (additions.length === 0) {
    return queryText;
  }
  return `${queryText}\n${additions.join(" ")}`;
}

function countTermFrequency(tokens: string[], term: string): number {
  let tf = 0;
  for (const token of tokens) {
    if (token === term) {
      tf += 1;
    }
  }
  return tf;
}

function bm25Score(
  tf: number,
  docLength: number,
  avgDocLength: number,
  totalDocs: number,
  docFreq: number,
): number {
  if (tf <= 0 || totalDocs <= 0 || docFreq <= 0) {
    return 0;
  }
  const safeAvgDl = avgDocLength > 0 ? avgDocLength : 1;
  const safeDl = docLength > 0 ? docLength : 1;

  const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
  const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (safeDl / safeAvgDl));
  if (denom <= 0) {
    return 0;
  }
  return idf * ((tf * (BM25_K1 + 1)) / denom);
}

/**
 * Executes vector similarity retrieval against SurrealDB embeddings, optionally filtered by scope.
 *
 * Still used by the tool-call path (memory_search) when individual per-stage score attribution
 * is needed (e.g. showing vector vs BM25 scores separately). For the main hybrid retrieval
 * pipeline, prefer {@link nativeRrfSearch} which fuses both stages server-side.
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
    `SELECT id, payload, vector::similarity::cosine(embedding, ${vecStr}) AS sim
     FROM ${tableName}
     WHERE payload.userId = $userId AND embedding != NONE ${ACTIVE_MEMORY_FILTER} ${sf.whereClause}
     ORDER BY sim DESC
     LIMIT $limit;`,
    { userId, limit: safeLimit, ...sf.vars },
  );
  const rows = results[0] ?? [];
  return rows.map((r: any, idx: number) => {
    const hit = mapMemoryRowToSearchHit({ ...r, score: r.sim ?? 0 });
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
 * pipeline, prefer {@link nativeRrfSearch} which fuses both stages server-side.
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

  const quotedTerms = queryTokens.map((t) => `"${t.replace(/"/g, "\\\"")}"`);
  const fulltextQuery = quotedTerms.join(" OR ");
  // NOTE: Inline query text (no bound param for MATCHES) — required by SurrealDB design;
  // bug where MATCHES returns all rows instead of matching rows.
  const escapedFtQuery = fulltextQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  try {
    const [matchesRes, stats] = await Promise.all([
      db.query<any>(
        `SELECT id, payload, text_norm
         FROM ${tableName}
         WHERE payload.userId = $userId AND text_norm @0@ '${escapedFtQuery}' ${ACTIVE_MEMORY_FILTER} ${sf.whereClause}
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
      const hit = mapMemoryRowToSearchHit({ ...h.raw, score: h.score });
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

/**
 * Default recency window in hours for the third RRF list.
 * Memories created within this window are eligible for recency boosting.
 * 48h balances "recent context matters" with avoiding noise from old memories.
 */
export const RECENCY_WINDOW_HOURS = 48;

// ---------------------------------------------------------------------------
// Parallel retrieval leg types
// ---------------------------------------------------------------------------

type VectorRow = { id: unknown; rank: number };
type Bm25Row = {
  id: unknown;
  score: number;
  rank: number;
  source: "native" | "fallback";
  matchedTerms?: string[];
};
type RecencyRow = { id: unknown; createdAt: string; rank: number };
type EntityRow = {
  id: unknown;
  rank: number;
  score: number;
  matchedEntities: string[];
  linkedMemoryIds: string[];
};

function mapNoemaRowToSearchHit(
  row: any,
  score: number,
  matchedTerms: string[],
  ranks?: { vectorRank?: number; bm25Rank?: number },
): SearchHit {
  const id = extractId(row?.id).replace(/^noema:/, "");
  const text = String(row?.canonical_text ?? row?.canonical?.text ?? row?.stable_claim?.value ?? "");
  return {
    id: `noema:${id}`,
    text,
    score,
    createdAt: row?.created_at,
    updatedAt: row?.updated_at,
    tags: ["noema"],
    category: row?.canonical?.category,
    memoryRole: row?.memory_role ?? undefined,
    scope: row?.scope ?? undefined,
    confidence: typeof row?.confidence === "number" ? row.confidence : undefined,
    l0: row?.stable_claim?.subject ?? row?.canonical?.l0 ?? undefined,
    l1: row?.stable_claim
      ? `${row.stable_claim.subject}: ${row.stable_claim.value}`
      : row?.canonical?.l1 ?? undefined,
    path: row?.path ?? undefined,
    active: row?.active,
    sourceKind: "noema",
    noemaClaimKey: row?.claim_key ?? undefined,
    noemaRevisionHash: row?.revision_hash ?? undefined,
    noemaStatus: row?.status ?? undefined,
    noemaSupportSemioteIds: Array.isArray(row?.support_semiote_ids)
      ? row.support_semiote_ids.map(String)
      : undefined,
    scoreStages: {
      // RULING 3 (0gk6.2): a SINGLE composite noema entry preserving the existing
      // {score, matchedTerms} shape, OPTIONALLY carrying the per-leg ranks that the
      // mini-RRF fused (vectorRank/bm25Rank). NO top-level per-leg disaggregation —
      // the noema sub-legs merge via the policy seam (mergeNoemaRetrievalLeg), not the
      // main legRanks, so the replay envelope (id-sequences + legRanks) is preserved.
      noema: {
        score,
        matchedTerms,
        ...(ranks?.vectorRank !== undefined ? { vectorRank: ranks.vectorRank } : {}),
        ...(ranks?.bm25Rank !== undefined ? { bm25Rank: ranks.bm25Rank } : {}),
      },
    },
    rankingExplanation: [`noema:${row?.status ?? "active"}`],
  };
}

// ---------------------------------------------------------------------------
// Noema retrieval legs (Rúnir-0gk6.2)
//
// Replaces the lexical `ORDER BY updated_at DESC LIMIT 120` recency-window scan with
// real retrieval: a KNN vector leg + a native scored-BM25 FTS leg over the noema
// canon, fused by a mini-RRF, feeding the existing mergeNoemaRetrievalLeg policy seam.
//
// These are THIN noema-specific legs (scout Q2): noema's storage shape differs from
// semiote's (flat `user_id` + `canonical_norm` + `embedding` vs nested `payload.userId`
// + `text_norm`), and noema additionally gates `active = true AND status = 'active'` +
// the requestedPath clause. Parameterising the semiote legs to straddle both shapes
// costs more than the ~two small functions here; future consolidation can fold them.
// ---------------------------------------------------------------------------

const NOEMA_RRF_K = 60;
// 1-based ranks → RRF weights. Vector and BM25 are weighted like the main fusion's
// vector/bm25 legs so the noema sub-fusion behaves consistently with the primary RRF.
const NOEMA_RRF_VECTOR_WEIGHT = 1.0;
const NOEMA_RRF_BM25_WEIGHT = 1.2;

type NoemaVectorRow = { id: unknown; rank: number };
type NoemaBm25Row = { id: unknown; score: number; rank: number; matchedTerms: string[] };

/** Shared WHERE clause for the noema legs: active + status='active' + optional path.
 *  NOTE (imaf.11 / yxwe caveat preserved): the promotion path binds `path ?? null`,
 *  which `path = NONE` does NOT match — so pathless noema can be missed under a
 *  requestedPath. This is a deferred follow-up; it is NOT silently changed here. */
function noemaWhereClause(requestedPath?: string): string {
  const pathClause = requestedPath ? "AND (path = $requestedPath OR path = NONE)" : "";
  return `user_id = $userId AND active = true AND status = 'active' ${pathClause}`;
}

/** KNN vector leg over noema — brute-force HNSW (repo pattern), returns id + 1-based rank. */
async function queryNoemaVectorLeg(
  db: SurrealClient,
  userId: string,
  embedding: number[],
  limit: number,
  requestedPath?: string,
): Promise<NoemaVectorRow[]> {
  if (!Array.isArray(embedding) || embedding.length === 0) return [];
  const sql = `SELECT id
    FROM noema
    WHERE ${noemaWhereClause(requestedPath)}
      AND embedding != NONE
      AND embedding <|${limit},300|> $qvec;`;
  const results = await db.query<any>(sql, { userId, qvec: embedding, requestedPath });
  const raw: any[] = results[0] ?? [];
  return raw.map((r: any, idx: number) => ({ id: r.id, rank: idx + 1 }));
}

/** Native scored-BM25 FTS leg over noema.canonical_norm, mirroring the semiote @ref,OR@
 *  pattern (tp2w.1) + `search::score(1)`. Falls back to app-side token overlap on the
 *  same recency-bounded scan when the FTS index yields nothing (e.g. unindexed/legacy
 *  rows), so the leg degrades rather than going silent. Returns id + score + 1-based rank. */
async function queryNoemaBm25Leg(
  db: SurrealClient,
  userId: string,
  queryText: string,
  limit: number,
  requestedPath?: string,
): Promise<NoemaBm25Row[]> {
  const queryTokens = significantQueryTokens(queryText);
  if (queryTokens.length === 0) return [];
  const where = noemaWhereClause(requestedPath);
  const isMultiToken = queryTokens.length > 1;
  const ftQuery = (isMultiToken ? queryTokens.join(" ") : queryTokens[0])
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
  const matchOp = isMultiToken ? "@1,OR@" : "@1@";
  const sql = `SELECT id, canonical_norm, search::score(1) AS bm25score
    FROM noema
    WHERE ${where}
      AND canonical_norm ${matchOp} '${ftQuery}'
    ORDER BY bm25score DESC
    LIMIT $limit;`;
  const results = await db.query<any>(sql, { userId, limit, requestedPath });
  const raw: any[] = results[0] ?? [];
  if (raw.length > 0) {
    return raw.map((row: any, idx: number) => {
      const tokens = tokenizeText(String(row.canonical_norm ?? ""));
      const matchedTerms = queryTokens.filter((term) => tokens.includes(term));
      return { id: row.id, score: row.bm25score ?? 0, rank: idx + 1, matchedTerms };
    });
  }

  // Fallback: app-side token overlap over a bounded scan (no FTS hit). Uses the same
  // idx_noema_user_active_status_updated index-ordered scan the old lexical leg used.
  const scanLimit = Math.min(Math.max(limit * 4, 100), 200);
  const fallback = await db.query<any>(
    // `updated_at` MUST be in the projection: SurrealDB v3 rejects an ORDER BY on a
    // field absent from the SELECT ("Missing order idiom `updated_at`"). Omitting it
    // made this fallback throw on every zero-FTS-hit query.
    `SELECT id, canonical_norm, updated_at
       FROM noema
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT $scanLimit;`,
    { userId, requestedPath, scanLimit },
  );
  const fallbackRows: any[] = fallback[0] ?? [];
  return fallbackRows
    .map((row: any) => {
      const tokens = tokenizeText(String(row.canonical_norm ?? ""));
      const matchedTerms = queryTokens.filter((term) => tokens.includes(term));
      const score = matchedTerms.length / queryTokens.length;
      return { id: row.id, score, matchedTerms };
    })
    .filter((r: any) => r.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit)
    .map((r: any, idx: number) => ({ id: r.id, score: r.score, rank: idx + 1, matchedTerms: r.matchedTerms }));
}

/**
 * Retrieves noema candidates via fused vector KNN + scored-BM25 FTS (mini-RRF), replacing
 * the lexical recency-window scan. The two legs run under Promise.all WITHIN the caller's
 * noema budget; their fused top-K is fetched in full and mapped to SearchHit[] for the
 * existing mergeNoemaRetrievalLeg policy seam (scout Q3). Same signature contract as before
 * apart from the added query embedding — return type is unchanged (SearchHit[]).
 */
async function queryNoemaCandidates(
  db: SurrealClient,
  userId: string,
  queryText: string,
  embedding: number[],
  limit: number,
  requestedPath?: string,
  warn?: (msg: string) => void,
): Promise<SearchHit[]> {
  // A DB error in either leg or the fusion must degrade this leg to empty — NEVER
  // reject and kill the whole recall. withTimeout only races a timer; it does not
  // catch rejections, so the catch MUST live here (catch-warn-degrade idiom, cf. the
  // local reranker stage and nativeRrfSearch).
  try {
    return await queryNoemaCandidatesInner(db, userId, queryText, embedding, limit, requestedPath);
  } catch (err) {
    warn?.(`memory-hybrid: noema leg failed, degrading to empty: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function queryNoemaCandidatesInner(
  db: SurrealClient,
  userId: string,
  queryText: string,
  embedding: number[],
  limit: number,
  requestedPath?: string,
): Promise<SearchHit[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 50));
  // Per-leg fetch depth: pull a wider pool than the final slice so the fusion can
  // rescue a candidate ranked deep in one leg but shallow in the other.
  const legLimit = Math.min(safeLimit * 4, 200);

  const [vectorRows, bm25Rows] = await Promise.all([
    queryNoemaVectorLeg(db, userId, embedding, legLimit, requestedPath),
    queryNoemaBm25Leg(db, userId, queryText, legLimit, requestedPath),
  ]);

  // --- Mini-RRF: fuse the two noema legs into a single per-id score. ---
  type Fused = { id: unknown; score: number; vectorRank?: number; bm25Rank?: number; matchedTerms: string[] };
  const fused = new Map<string, Fused>();
  for (const r of vectorRows) {
    const key = extractId(r.id);
    const entry = fused.get(key) ?? { id: r.id, score: 0, matchedTerms: [] };
    entry.id = r.id;
    entry.vectorRank = r.rank;
    entry.score += NOEMA_RRF_VECTOR_WEIGHT / (NOEMA_RRF_K + r.rank);
    fused.set(key, entry);
  }
  for (const r of bm25Rows) {
    const key = extractId(r.id);
    const entry = fused.get(key) ?? { id: r.id, score: 0, matchedTerms: [] };
    if (entry.vectorRank === undefined) entry.id = r.id;
    entry.bm25Rank = r.rank;
    entry.matchedTerms = r.matchedTerms;
    entry.score += NOEMA_RRF_BM25_WEIGHT / (NOEMA_RRF_K + r.rank);
    fused.set(key, entry);
  }

  const fusedTop = Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);
  if (fusedTop.length === 0) return [];

  // --- Fetch full noema rows for the fused top-K only (mirrors the main RRF payload stage). ---
  const idRefs = fusedTop.map((f) => f.id);
  const fullResults = await db.query<any>(
    `SELECT id, canonical, canonical_text, canonical_norm, stable_claim, scope, path, memory_role,
            claim_key, revision_hash, status, support_semiote_ids, created_at, updated_at,
            confidence, stability, active
       FROM noema
       WHERE id IN $ids;`,
    { ids: idRefs },
  );
  const fullRows: any[] = fullResults[0] ?? [];
  const rowById = new Map<string, any>();
  for (const row of fullRows) rowById.set(extractId(row.id), row);

  const hits: SearchHit[] = [];
  for (const f of fusedTop) {
    const row = rowById.get(extractId(f.id));
    if (!row) continue;
    hits.push(
      mapNoemaRowToSearchHit(row, f.score, f.matchedTerms, {
        vectorRank: f.vectorRank,
        bm25Rank: f.bm25Rank,
      }),
    );
  }
  return hits;
}

type FusedRow = {
  id: unknown;
  score: number;
  vectorRank?: number;
  bm25Rank?: number;
  bm25Score?: number;
  recencyRank?: number;
  recencyCreatedAt?: string;
  entityRank?: number;
  entityScore?: number;
};

/**
 * Per-unit retrieval ranks for the `debug.legRanks` sidecar (Rúnir-x41m.10 Layer 2).
 * All ranks are 1-based. vector/bm25/recency/entity are per-leg ranks; `rrf` is the
 * fused rank BEFORE exact-QA re-sort, noema merge, reranker, and threshold filtering
 * (i.e. "where fusion placed it", NOT the final selected rank).
 */
export type LegRanks = Record<string, { vector?: number; bm25?: number; recency?: number; entity?: number; rrf?: number }>;

/**
 * Debug-only sidecar (Rúnir-x41m.10 Layer 2): the ACTUAL candidate-window + reranker-stage
 * orders, captured AFTER exact-QA re-sort / overlay merge / noema merge (the order entering
 * the reranker) and AFTER reranking. These cannot be reconstructed from `legRanks` (which is
 * the raw RRF order) because the reranker and the merges reorder/drop. Read-only, ranking-neutral.
 */
export interface RecallCandidateStages {
  candidateLimit: number;          // the ACTUAL candidateLimit used (post RERANKER_CANDIDATE_FLOOR/clamp)
  // Always equal to candidateLimit / the full candidate pool (the Rúnir-x41m.11 split-window
  // env overrides were stripped in Rúnir-tp2w.3; no-ship, no promote path).
  legFetchLimit?: number;          // per-leg fetch depth actually used (always set by the real emitter)
  fusionCandidateLimit?: number;   // fused-window slice actually used
  rerankCandidateLimit?: number;   // # fused candidates the reranker actually scored (rerankPool size)
  candidatePoolIds: string[];      // full fused+merged pool (post fuse/exactQA/overlay/noema)
  preRerankerIds: string[];        // rerankPool order entering the reranker (always == candidatePoolIds; no rerank-window slice exists post Rúnir-tp2w.3 strip)
  postRerankerIds: string[];       // finalHits order (== preRerankerIds when reranker off / empty scores)
  rerankerActive: boolean;
  rerankerThreshold?: number;
  rerankerScores?: Record<string, number>;
}

export interface HybridQueryTuningOptions {
  rrfWeights?: {
    vector: number;
    bm25: number;
    recency: number;
    entity?: number;
  };
  recencyWindowHours?: number;
  nowMs?: number;
  entityLookupSessionId?: string;
  /**
   * Per-tenant ranking profile (Rúnir-mmg2) supplying the entity-mention filler
   * words + taxonomy-expansion facets for this request's tenant. When omitted,
   * the clean EMPTY_PROFILE applies (no filler filtering, no query expansion).
   */
  rankingProfile?: RankingProfile;
  /**
   * Exact-QA preserve floor score (Rúnir-qjn4.3, ruling R3 — DEFAULT-OFF).
   * Resolved by the orchestrator from the declared ranking plan's
   * `exact_qa_preserve_floor` entry. When set, an exact-QA hit preserved past the
   * rerank threshold gets a floor score = this value (the active threshold) so it
   * ranks with the reranked-cosine population instead of parking at the RRF-scale
   * bottom. When undefined (the default plan keeps the entry disabled), the
   * preserve path is byte-identical to before.
   */
  exactQaPreserveFloor?: number;
  onEntityTrace?: (matches: EntityRetrievalTraceMatch[]) => void;
  // Debug-only sidecar (set by the trace route): emits per-unit per-leg ranks. Built only
  // when present, so production retrieval never pays the cost. Does NOT touch RetrievalTrace.
  onLegRanks?: (legRanks: LegRanks) => void;
  // Debug-only sidecar (Rúnir-x41m.10): emits the actual pre/post-reranker candidate orders +
  // the real candidateLimit. Built only when present; read-only, ranking-neutral.
  onCandidateStages?: (stages: RecallCandidateStages) => void;
}

// ---------------------------------------------------------------------------
// Step 1: Independent retrieval leg functions
// ---------------------------------------------------------------------------

/** KNN vector retrieval — returns raw id (RecordId) + 1-based rank position. */
async function queryVectorLeg(
  db: SurrealClient,
  userId: string,
  embedding: number[],
  limit: number,
  scopeFilter: ScopeFilter,
  activeFilter: string,
  tableName: MemoryRecordTable,
): Promise<{ rows: VectorRow[]; ms: number }> {
  const t0 = performance.now();
  const sql = `SELECT id
    FROM ${tableName}
    WHERE payload.userId = $userId
      AND embedding != NONE
      ${activeFilter}
      ${scopeFilter.whereClause}
      AND embedding <|${limit},300|> $qvec;`;
  const results = await db.query<any>(sql, {
    userId,
    qvec: embedding,
    ...scopeFilter.vars,
  });
  const raw: any[] = results[0] ?? [];
  const rows: VectorRow[] = raw.map((r: any, idx: number) => ({
    id: r.id,
    rank: idx + 1,
  }));
  return { rows, ms: performance.now() - t0 };
}

/** BM25 full-text retrieval — returns raw id + bm25score + 1-based rank. */
async function queryBm25Leg(
  db: SurrealClient,
  userId: string,
  queryText: string,
  limit: number,
  scopeFilter: ScopeFilter,
  activeFilter: string,
  tableName: MemoryRecordTable,
): Promise<{ rows: Bm25Row[]; ms: number; nativeCount: number; fallbackCount: number }> {
  const t0 = performance.now();
  const queryTokens = significantQueryTokens(queryText);
  if (queryTokens.length === 0) {
    return { rows: [], ms: performance.now() - t0, nativeCount: 0, fallbackCount: 0 };
  }
  const isMultiToken = queryTokens.length > 1;

  if (!isMultiToken) {
    const escapedFtQuery = queryTokens[0].replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const sql = `SELECT id, search::score(1) AS bm25score
      FROM ${tableName}
      WHERE payload.userId = $userId
        AND text_norm @1@ '${escapedFtQuery}'
        ${activeFilter}
        ${scopeFilter.whereClause}
      ORDER BY bm25score DESC
      LIMIT $limit;`;
    const results = await db.query<any>(sql, {
      userId,
      limit,
      ...scopeFilter.vars,
    });
    const raw: any[] = results[0] ?? [];
    if (raw.length > 0) {
      const rows: Bm25Row[] = raw.map((r: any, idx: number) => ({
        id: r.id,
        score: r.bm25score ?? 0,
        rank: idx + 1,
        source: "native" as const,
      }));
      return { rows, ms: performance.now() - t0, nativeCount: rows.length, fallbackCount: 0 };
    }
  } else {
    const escapedFtQuery = queryTokens.join(" ").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const sql = `SELECT id, text_norm, search::score(1) AS bm25score
      FROM ${tableName}
      WHERE payload.userId = $userId
        AND text_norm @1,OR@ '${escapedFtQuery}'
        ${activeFilter}
        ${scopeFilter.whereClause}
      ORDER BY bm25score DESC
      LIMIT $limit;`;
    const results = await db.query<any>(sql, {
      userId,
      limit,
      ...scopeFilter.vars,
    });
    const raw: any[] = results[0] ?? [];
    if (raw.length > 0) {
      const rows: Bm25Row[] = raw.map((row: any, idx: number) => {
        const textNorm = String(row.text_norm ?? "");
        const tokens = tokenizeText(textNorm);
        const matchedTerms = queryTokens.filter((term) => tokens.includes(term));
        return {
          id: row.id,
          score: row.bm25score ?? 0,
          rank: idx + 1,
          source: "native" as const,
          matchedTerms,
        };
      });
      return { rows, ms: performance.now() - t0, nativeCount: rows.length, fallbackCount: 0 };
    }
  }

  const fallbackResults = await db.query<any>(
    `SELECT id, text_norm
     FROM ${tableName}
     WHERE payload.userId = $userId
       AND text_norm != NONE
       ${activeFilter}
       ${scopeFilter.whereClause}
     LIMIT $limit;`,
    {
      userId,
      limit: Math.max(limit * 10, 100),
      ...scopeFilter.vars,
    },
  );
  const fallbackRows: any[] = fallbackResults[0] ?? [];
  const scored = fallbackRows
    .map((row: any) => {
      const textNorm = String(row.text_norm ?? "");
      const tokens = tokenizeText(textNorm);
      const matchedTerms = queryTokens.filter((term) => tokens.includes(term));
      const score = matchedTerms.length / Math.max(queryTokens.length, 1);
      return { id: row.id, score, matchedTerms };
    })
    .filter((row: any) => row.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit)
    .map((row: any, idx: number) => ({
      id: row.id,
      score: row.score,
      rank: idx + 1,
      source: "fallback" as const,
      matchedTerms: row.matchedTerms,
    }));
  return { rows: scored, ms: performance.now() - t0, nativeCount: 0, fallbackCount: scored.length };
}

/** Recency retrieval — returns raw id + created_at + 1-based rank. */
async function queryRecencyLeg(
  db: SurrealClient,
  userId: string,
  recencyCutoff: string,
  limit: number,
  scopeFilter: ScopeFilter,
  activeFilter: string,
  tableName: MemoryRecordTable,
): Promise<{ rows: RecencyRow[]; ms: number }> {
  const t0 = performance.now();
  // NOTE: keep app-side sorting for deterministic recency ranks across replay runs.
  const sql = `SELECT id, created_at
    FROM ${tableName}
    WHERE payload.userId = $userId
      ${activeFilter}
      ${scopeFilter.whereClause}
      AND created_at > <datetime>$recencyCutoff
    LIMIT $limit;`;
  const results = await db.query<any>(sql, {
    userId,
    limit,
    recencyCutoff,
    ...scopeFilter.vars,
  });
  const raw: any[] = (results[0] ?? []).sort((a: any, b: any) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  );
  const rows: RecencyRow[] = raw.map((r: any, idx: number) => ({
    id: r.id,
    createdAt: r.created_at ?? "",
    rank: idx + 1,
  }));
  return { rows, ms: performance.now() - t0 };
}

const MAX_ENTITY_MENTION_TOKENS = 4;

function normalizeLinkedMemoryId(memoryId: string, tableName: MemoryRecordTable): string | null {
  const raw = String(memoryId);
  const withoutTable = raw.startsWith(`${tableName}:`) ? raw.slice(tableName.length + 1) : raw;
  const withoutBrackets = withoutTable.replace(/^⟨/, "").replace(/⟩$/, "");
  return withoutBrackets.length > 0 ? withoutBrackets : null;
}

export function linkedMemoryRecordIds(linkedIds: string[], tableName: MemoryRecordTable): RecordId<string>[] {
  return [...new Set(linkedIds)]
    .map((id) => normalizeLinkedMemoryId(id, tableName))
    .filter((id): id is string => id !== null)
    .map((id) => new RecordId(tableName, id));
}

async function filterLinkedMemoryIds(
  db: SurrealClient,
  userId: string,
  linkedIds: string[],
  scopeFilter: ScopeFilter,
  activeFilter: string,
  tableName: MemoryRecordTable,
): Promise<string[]> {
  if (linkedIds.length === 0) {
    return [];
  }
  const uniqueRefs = linkedMemoryRecordIds(linkedIds, tableName);
  // SELECT FROM the record list, NOT `FROM ${table} WHERE id IN $ids`: SurrealDB's
  // planner never converts IN-on-id to point gets — it iterates the whole table
  // evaluating `id INSIDE [...]` per row (~307ms on the live 6.7k-row semiote table
  // vs 6ms for FROM $ids). This query runs once per matched entity in the recall
  // entity leg, so the scan form was the leg's dominant remaining cost.
  const result = await db.query<any>(
    `SELECT id FROM $ids
      WHERE payload.userId = $userId
      ${activeFilter}
      ${scopeFilter.whereClause};`,
    { ids: uniqueRefs, userId, ...scopeFilter.vars },
  );
  // Sort restores the table-scan row order the old `WHERE id IN` form produced
  // (storage iteration = ascending record id). FROM $ids returns rows in list
  // order instead, and this ordering feeds entity-leg insertion ranks → RRF —
  // without the sort, replay diverged on legRanks/rrfFusedIds across 5 probes.
  return (result[0] ?? []).map((row: any) => extractId(row.id)).sort();
}

export function entityMentionCandidates(
  queryText: string,
  entityFillerWords: ReadonlySet<string> = EMPTY_PROFILE.entityFillerWords,
): Array<{ mention: string; normalized: string }> {
  const tokens = tokenizeText(queryText).filter((token) => !BM25_STOPWORDS.has(token));
  const originalTokens = queryText.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const candidates: Array<{ mention: string; normalized: string }> = [];
  const seen = new Set<string>();

  const addCandidate = (mention: string) => {
    const normalized = normalizeEntityName(mention);
    if (normalized.length < 3 || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push({ mention, normalized });
  };

  addCandidate(queryText);
  for (const token of originalTokens) {
    const normalizedToken = normalizeEntityName(token);
    if (/^\p{Lu}/u.test(token) && normalizedToken.length >= 3 && !BM25_STOPWORDS.has(normalizedToken) && !entityFillerWords.has(normalizedToken)) {
      addCandidate(token);
    }
  }
  for (let size = Math.min(MAX_ENTITY_MENTION_TOKENS, tokens.length); size >= 1; size--) {
    for (let start = 0; start <= tokens.length - size; start++) {
      const ngramTokens = tokens.slice(start, start + size);
      if (entityFillerWords.has(ngramTokens[0] ?? "") || entityFillerWords.has(ngramTokens[ngramTokens.length - 1] ?? "")) {
        continue;
      }
      addCandidate(ngramTokens.join(" "));
    }
  }

  const multiToken = candidates.filter((candidate) => candidate.normalized.includes(" "));
  const singleToken = candidates.filter((candidate) => !candidate.normalized.includes(" "));
  const tailBigrams = multiToken.filter((candidate) => candidate.normalized.split(" ").length === 2).slice(-4);
  const properNameSingles = singleToken.filter((candidate) => originalTokens.some((token) => {
    const normalizedToken = normalizeEntityName(token);
    return normalizedToken === candidate.normalized && /^\p{Lu}/u.test(token) && !BM25_STOPWORDS.has(normalizedToken) && !entityFillerWords.has(normalizedToken);
  }));
  const prioritized = [...properNameSingles, ...tailBigrams, ...multiToken.slice(0, MAX_ENTITY_QUERY_CANDIDATES)];
  const uniquePrioritized = prioritized.filter((candidate, idx) => prioritized.findIndex((other) => other.normalized === candidate.normalized) === idx);
  return [
    ...uniquePrioritized.slice(0, MAX_ENTITY_QUERY_CANDIDATES),
    ...singleToken.slice(0, Math.max(0, MAX_ENTITY_QUERY_CANDIDATES - uniquePrioritized.length)),
  ];
}

export function entityLookupScopes(scopeFilter: ScopeFilter, currentSessionId?: string): EntityLookupScope[] {
  const scopeVal = scopeFilter.vars.scopeVal;
  if (scopeVal === "team") {
    return [];
  }
  if (scopeVal === "session") {
    return typeof scopeFilter.vars.sessionId === "string"
      ? [{ scope: "session", sessionId: scopeFilter.vars.sessionId }]
      : [];
  }
  if (scopeFilter.vars.sessionScope === "session" && "sessionId" in scopeFilter.vars) {
    return [{ scope: "user" }, { scope: "session", sessionId: String(scopeFilter.vars.sessionId) }];
  }
  return currentSessionId ? [{ scope: "user" }, { scope: "session", sessionId: currentSessionId }] : [{ scope: "user" }, { scope: "session" }];
}

async function queryEntityLeg(
  db: SurrealClient,
  userId: string,
  queryText: string,
  limit: number,
  scopeFilter: ScopeFilter,
  activeFilter: string,
  tableName: MemoryRecordTable,
  currentSessionId: string | undefined,
  entityFillerWords: ReadonlySet<string>,
): Promise<{ rows: EntityRow[]; ms: number; traceMatches: EntityRetrievalTraceMatch[] }> {
  const t0 = performance.now();
  const traceMatches: EntityRetrievalTraceMatch[] = [];
  const byMemoryId = new Map<string, EntityRow>();
  const candidates = entityMentionCandidates(queryText, entityFillerWords);
  const scopes = entityLookupScopes(scopeFilter, currentSessionId);

  type EntityMatch = { entity: Awaited<ReturnType<typeof findEntityByName>>[number]; matchedBy: "name" | "alias"; scope: MemoryScope };

  // Phase 1 (batched): ONE name query + ONE alias query per scope covers ALL
  // candidates — 4 queries instead of up to 64. Rows are partitioned back to
  // candidates app-side by exact `nameNorm` equality / `aliasesNorm` membership,
  // the same predicates the per-candidate queries evaluated server-side, so the
  // per-candidate match sets, name-before-alias ordering, and session-scope filter
  // are preserved verbatim. The per-candidate N+1 dominated the leg's wall time
  // once the entity graph was populated: each alias lookup residual-filters the
  // whole (userId, scope) slice (~15–18ms live) and all legs share one serialized
  // DB connection, so 32 of them stacked into seconds under concurrent recalls.
  const normalizedCandidates = candidates.map((candidate) => candidate.normalized);
  const scopeBatches = await Promise.all(scopes.map(async (lookupScope) => {
    const [nameRows, aliasRows] = await Promise.all([
      findEntitiesByNames(db, normalizedCandidates, userId, lookupScope.scope),
      findEntitiesByAliases(db, normalizedCandidates, userId, lookupScope.scope),
    ]);
    return { lookupScope, nameRows, aliasRows };
  }));
  const resolved = candidates.map((candidate) => {
    const entityMatches: EntityMatch[] = [];
    for (const { lookupScope, nameRows, aliasRows } of scopeBatches) {
      const byName = nameRows.filter((entity) => entity.nameNorm === candidate.normalized);
      const byAlias = aliasRows.filter((entity) => (entity.aliasesNorm ?? []).includes(candidate.normalized));
      const scopeMatches = [...byName, ...byAlias].filter((entity) =>
        lookupScope.scope !== "session" || lookupScope.sessionId === undefined || entity.sessionId === lookupScope.sessionId,
      );
      entityMatches.push(
        ...scopeMatches.filter((entity) => byName.includes(entity)).map((entity) => ({ entity, matchedBy: "name" as const, scope: lookupScope.scope })),
        ...scopeMatches.filter((entity) => byAlias.includes(entity)).map((entity) => ({ entity, matchedBy: "alias" as const, scope: lookupScope.scope })),
      );
    }
    return { candidate, entityMatches: entityMatches.slice(0, MAX_ENTITY_MATCHES_PER_CANDIDATE) };
  });

  // Phase 2a (imaf.11 #3): TWO batched queries for the whole match set — one
  // edge traversal for every unique entity, one record-list filter over the
  // union — replacing the per-entity N+1 (previously bounded concurrency 8;
  // the serial form was ~74% of the leg's wall time, Rúnir-yxwe Part B).
  // Per-entity results are reconstructed app-side to stay replay-identical:
  // linked order = the entity's own traversal order (the batched FROM-list
  // traversal walks each record's edges exactly like the single form), and
  // filtered = the entity's deduped linked ids ∩ union survivors, sorted
  // ascending — which equals what the per-entity filterLinkedMemoryIds
  // returned (it deduped and sorted). A batch failure marks EVERY entity
  // failed; the merge below still only throws if it actually REACHES one,
  // preserving the original serial-loop degradation contract (Rúnir-yxwe).
  const uniqueEntityIds = new Set<string>();
  for (const { entityMatches } of resolved) {
    for (const m of entityMatches) uniqueEntityIds.add(extractId(m.entity.id));
  }
  const fetched = new Map<string, { linkedCount: number; filtered: string[] } | { error: unknown }>();
  const entityIdList = [...uniqueEntityIds];
  try {
    const supportingByEntity = await getSupportingMemoryIdsBatch(db, entityIdList);
    const linkedByEntity = new Map<string, string[]>();
    for (const entityId of entityIdList) {
      const linked = (supportingByEntity.get(entityId) ?? [])
        .map((memoryId) => normalizeLinkedMemoryId(memoryId, tableName))
        .filter((memoryId): memoryId is string => memoryId !== null)
        .slice(0, MAX_ENTITY_LINKED_IDS_PER_MATCH);
      linkedByEntity.set(entityId, linked);
    }
    const unionIds = [...new Set([...linkedByEntity.values()].flat())];
    const survivors = new Set(
      unionIds.length === 0
        ? []
        : await filterLinkedMemoryIds(db, userId, unionIds, scopeFilter, activeFilter, tableName),
    );
    for (const entityId of entityIdList) {
      const linked = linkedByEntity.get(entityId) ?? [];
      const filtered = [...new Set(linked)].filter((memoryId) => survivors.has(memoryId)).sort();
      fetched.set(entityId, { linkedCount: linked.length, filtered });
    }
  } catch (err) {
    for (const entityId of entityIdList) fetched.set(entityId, { error: err });
  }

  // Phase 2b: deterministic sequential merge — reads from the prefetch map, so it
  // preserves the exact per-candidate seenEntityIds dedup, the MAX_ENTITY_ROWS cap,
  // scoring, and trace reasons of the original serial loop.
  for (const { candidate, entityMatches } of resolved) {
    if (entityMatches.length === 0) {
      traceMatches.push({
        queryMention: candidate.mention,
        normalizedMention: candidate.normalized,
        linkedMemoryIds: [],
        ignoredReason: "no_entity_match",
      });
      continue;
    }
    const seenEntityIds = new Set<string>();
    for (const match of entityMatches) {
      if (byMemoryId.size >= MAX_ENTITY_ROWS) {
        break;
      }
      const entityId = extractId(match.entity.id);
      if (seenEntityIds.has(entityId)) {
        continue;
      }
      seenEntityIds.add(entityId);

      const entry = fetched.get(entityId) ?? { linkedCount: 0, filtered: [] };
      if ("error" in entry) {
        // The original serial loop awaited this fetch inline, so a failure on a
        // processed entity degraded the whole entity leg. Preserve that here.
        throw entry.error;
      }
      const { linkedCount, filtered: filteredLinkedMemoryIds } = entry;
      const scoreChanges: Array<{ memoryId: string; before: number; boost: number; after: number }> = [];
      if (linkedCount === 0 || filteredLinkedMemoryIds.length === 0) {
        traceMatches.push({
          queryMention: candidate.mention,
          normalizedMention: candidate.normalized,
          linkedMemoryIds: [],
          ignoredReason: linkedCount === 0 ? "no_linked_memories" : "linked_memories_filtered",
        });
        continue;
      }

      traceMatches.push({
        queryMention: candidate.mention,
        normalizedMention: candidate.normalized,
        entityId,
        canonicalName: match.entity.canonicalName,
        matchedBy: match.matchedBy,
        scope: match.scope,
        linkedMemoryIds: filteredLinkedMemoryIds,
        scoreChanges,
      });

      for (const memoryId of filteredLinkedMemoryIds) {
        if (!byMemoryId.has(memoryId) && byMemoryId.size >= MAX_ENTITY_ROWS) {
          break;
        }
        const existing = byMemoryId.get(memoryId) ?? {
          id: `${tableName}:${memoryId}`,
          rank: byMemoryId.size + 1,
          score: 0,
          matchedEntities: [],
          linkedMemoryIds: [memoryId],
        };
        const before = existing.score;
        const boost = Math.max(0.1, match.entity.confidence ?? 0.5);
        existing.score += boost;
        existing.matchedEntities.push(match.entity.canonicalName);
        scoreChanges.push({ memoryId, before, boost, after: existing.score });
        byMemoryId.set(memoryId, existing);
      }
    }
  }

  const rows = Array.from(byMemoryId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map((row, idx) => ({ ...row, rank: idx + 1 }));

  return { rows, ms: performance.now() - t0, traceMatches };
}

// ---------------------------------------------------------------------------
// Step 2: App-side RRF fusion
// ---------------------------------------------------------------------------

/**
 * Default RRF entity-leg weight when omitted from tuning (Rúnir-aa98).
 * Overridable via env `RUNIR_RRF_ENTITY_WEIGHT` for isolated A/B arms without
 * changing request policy shapes. Invalid/empty env → this default.
 */
export const DEFAULT_RRF_ENTITY_WEIGHT = 0.45;

/** Resolves the entity RRF weight for fuse + attribution (single source). */
export function defaultRrfEntityWeight(): number {
  const raw = process.env.RUNIR_RRF_ENTITY_WEIGHT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RRF_ENTITY_WEIGHT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RRF_ENTITY_WEIGHT;
  return n;
}

/**
 * Applies reciprocal rank fusion across retrieval legs (vector, BM25, recency, entity).
 *
 * RRF formula per candidate:
 *   `score = 1/(k + vectorRank) + 1.2/(k + bm25Rank) + 0.8/(k + recencyRank) + w_e/(k + entityRank)`
 * where k defaults to 60, missing ranks contribute 0, and `w_e` defaults via
 * `defaultRrfEntityWeight()` (code default 0.45; env `RUNIR_RRF_ENTITY_WEIGHT`).
 *
 * The original weight coefficients (1.0, 1.2, 0.8) match the prior server-side
 * RRF behavior; the entity lane is lower-weight so linked memories are candidates
 * without replacing ordinary vector/BM25/recency retrieval.
 */
export function rrfFuse(
  vectorHits: VectorRow[],
  bm25Hits: Bm25Row[],
  recencyHits: RecencyRow[],
  entityHitsOrRrfK: EntityRow[] | number = [],
  rrfKOrWeights: number | HybridQueryTuningOptions["rrfWeights"] = 60,
  weightsArg?: HybridQueryTuningOptions["rrfWeights"],
): FusedRow[] {
  const entityHits = Array.isArray(entityHitsOrRrfK) ? entityHitsOrRrfK : [];
  const rrfK = typeof entityHitsOrRrfK === "number" ? entityHitsOrRrfK : typeof rrfKOrWeights === "number" ? rrfKOrWeights : 60;
  const entityDefault = defaultRrfEntityWeight();
  const weights = (typeof rrfKOrWeights === "object" ? rrfKOrWeights : weightsArg) ?? {
    vector: 1.0,
    bm25: 1.2,
    recency: 0.8,
    entity: entityDefault,
  };
  const candidates = new Map<string, FusedRow>();

  for (const h of vectorHits) {
    const id = extractId(h.id);
    const entry = candidates.get(id) ?? { id: h.id, score: 0 };
    entry.id = h.id; // keep raw RecordId
    entry.vectorRank = h.rank;
    entry.score += weights.vector / (rrfK + h.rank);
    candidates.set(id, entry);
  }
  for (const h of bm25Hits) {
    const id = extractId(h.id);
    const entry = candidates.get(id) ?? { id: h.id, score: 0 };
    if (!entry.vectorRank) entry.id = h.id; // keep raw RecordId from first encounter
    entry.bm25Rank = h.rank;
    entry.bm25Score = h.score;
    entry.score += weights.bm25 / (rrfK + h.rank);
    candidates.set(id, entry);
  }
  for (const h of recencyHits) {
    const id = extractId(h.id);
    const entry = candidates.get(id) ?? { id: h.id, score: 0 };
    if (!entry.vectorRank && !entry.bm25Rank) entry.id = h.id;
    entry.recencyRank = h.rank;
    entry.recencyCreatedAt = h.createdAt;
    entry.score += weights.recency / (rrfK + h.rank);
    candidates.set(id, entry);
  }
  for (const h of entityHits) {
    const id = extractId(h.id);
    const entry = candidates.get(id) ?? { id: h.id, score: 0 };
    if (!entry.vectorRank && !entry.bm25Rank && !entry.recencyRank) entry.id = h.id;
    entry.entityRank = h.rank;
    entry.entityScore = h.score;
    entry.score += (weights.entity ?? entityDefault) / (rrfK + h.rank);
    candidates.set(id, entry);
  }

  const results = Array.from(candidates.values());
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Step 3: Parallel nativeRrfSearch
// ---------------------------------------------------------------------------

/** Empty entity-leg result carrying a per-candidate trace marker, shared by the
 *  entity-leg catch (entity_lookup_failed) and the per-leg timeout fallback
 *  (entity_timeout) so a degraded entity leg is observable, not silent (Rúnir-yxwe). */
function emptyEntityLeg(
  queryText: string,
  reason: string,
  entityFillerWords: ReadonlySet<string>,
): { rows: EntityRow[]; ms: number; traceMatches: EntityRetrievalTraceMatch[] } {
  return {
    rows: [],
    ms: 0,
    traceMatches: entityMentionCandidates(queryText, entityFillerWords).map((candidate) => ({
      queryMention: candidate.mention,
      normalizedMention: candidate.normalized,
      linkedMemoryIds: [],
      ignoredReason: reason,
    })),
  };
}

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
        queryEntityLeg(db, userId, expandedQueryText, safeLimit, sf, activeFilter, tableName, tuning?.entityLookupSessionId, rankingProfile.entityFillerWords)
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
      `SELECT id, payload, active, inactive_reason, superseded_by, lineage_root_id, memory_role, valid_at, invalid_at, embedding FROM ${tableName} WHERE id IN $ids;`,
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

      return {
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
      };
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
    nativeRrfSearch(
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
  const rrfHits = rrf.value;
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
        queryNoemaCandidates(db, userId, query, embedding, candidateLimit, noemaRetrieval.requestedPath, warn),
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
