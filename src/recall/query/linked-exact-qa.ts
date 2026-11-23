// Linked exact-QA enrichment: re-scores hits against their verified source turns.
// Split out of memory-query.ts (vk-2996).
import { type SearchHit } from "../../domain/memory/types";
import { extractId, type SurrealClient } from "../../storage/surreal/surreal-store";
import { detectExactQaIntent, exactQaTokens, scoreExactQaCandidate } from "../../domain/memory/exact-qa.js";
import { readVerifiedSourceTurns } from "../../storage/surreal/verified-source-turns.js";
import { raceAbandonable } from "../../storage/surreal/query-abandonment.js";
import { sourceRecallMode } from "../source-excerpts.js";

let linkedExactQaFailures = 0;
export function linkedExactQaFailureCount(): number { return linkedExactQaFailures; }

/** Run only after the fact DB timeout has resolved. Source I/O cannot erase facts. */
export async function enrichLinkedExactQaHits(db: Pick<SurrealClient, "query">, hits: SearchHit[], query: string,
  userId: string, sessionId?: string): Promise<SearchHit[]> {
  if (sourceRecallMode() !== "on" || !detectExactQaIntent(query) || !process.env.RUNIR_SOURCE_HMAC_KEY || !hits.length) return hits;
  const configured = Number(process.env.RUNIR_SOURCE_EXACT_QA_TOP_N ?? 20);
  const cap = Number.isSafeInteger(configured) ? Math.max(1, Math.min(configured, 50)) : 20;
  const eligible = hits.slice(0, cap).filter((hit) => !hit.rawSpan && !hit.rawSpans?.length).map((hit) => hit.id);
  if (!eligible.length) return hits;
  try {
    const verified = await raceAbandonable(
      () => readVerifiedSourceTurns(db, eligible, { userId, sessionId }), 500, "linked exact QA timeout");
    return hits.map((hit) => {
      const linkedText = verified.get(extractId(hit.id))?.text;
      if (!linkedText) return hit;
      const exactScore = scoreExactQaCandidate(query, { ...hit, rawSpan: { text: linkedText } });
      if (exactScore <= 0) return hit;
      return { ...hit, score: hit.score + exactScore * 0.05, exactQaCandidate: exactScore >= 0.5,
        exactQaScore: exactScore, scoreStages: { ...hit.scoreStages,
          exact: { score: exactScore, matchedTokens: exactQaTokens(query).filter((token) =>
            linkedText.toLowerCase().includes(token.toLowerCase())) } } };
    }).sort((a, b) => b.score - a.score);
  } catch { linkedExactQaFailures++; return hits; }
}
