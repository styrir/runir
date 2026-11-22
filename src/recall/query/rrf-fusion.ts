// App-side reciprocal rank fusion across the retrieval legs.
// Split out of memory-query.ts (vk-2996).
import { extractId } from "../../storage/surreal/surreal-store";
import type {
  VectorRow,
  Bm25Row,
  RecencyRow,
  EntityRow,
  FusedRow,
  HybridQueryTuningOptions,
} from "./retrieval-types.js";

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
