// Noema retrieval leg: vector + BM25 over noema records with its own small RRF.
// Split out of memory-query.ts (vk-2996).
import { type SearchHit } from "../../domain/memory/types";
import { extractId, type SurrealClient } from "../../storage/surreal/surreal-store";
import { attachSelectedSearchHitLineage } from "../../domain/memory/search-hit-lineage.js";
import { tokenizeText, significantQueryTokens } from "./query-text.js";
import type { NoemaRetrievalLegOptions } from "./retrieval-types.js";

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
export async function queryNoemaCandidates(
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
            confidence, stability, active, processing_lineage
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
      attachSelectedSearchHitLineage(
        mapNoemaRowToSearchHit(row, f.score, f.matchedTerms, {
          vectorRank: f.vectorRank,
          bm25Rank: f.bm25Rank,
        }),
        row?.processing_lineage,
      ),
    );
  }
  return hits;
}
