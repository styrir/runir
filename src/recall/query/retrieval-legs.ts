// The vector, BM25 and recency retrieval legs of nativeRrfSearch.
// Split out of memory-query.ts (vk-2996).
import { type MemoryRecordTable } from "../../domain/memory/types";
import { type SurrealClient } from "../../storage/surreal/surreal-store";
import type { ScopeFilter } from "./scope-predicate";
import { tokenizeText, significantQueryTokens } from "./query-text.js";
import type { VectorRow, Bm25Row, RecencyRow } from "./retrieval-types.js";

// ---------------------------------------------------------------------------
// Step 1: Independent retrieval leg functions
// ---------------------------------------------------------------------------

/** KNN vector retrieval — returns raw id (RecordId) + 1-based rank position. */
export async function queryVectorLeg(
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
export async function queryBm25Leg(
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
export async function queryRecencyLeg(
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
