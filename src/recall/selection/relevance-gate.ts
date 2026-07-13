import type { ScoreStageAttribution } from "../../domain/memory/retrieval.js";

/** Bounded-float env read in [0,1] with a safe fallback (non-numeric/out-of-range → fallback). */
function boundedFloatEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * Recall relevance floor (Rúnir-2i8k) — TOP-HIT gate on the TURN path. When > 0, if the top
 * selected memory's POST-RERANK COSINE score is below this floor, /hooks/recall returns an empty
 * result instead of injecting the weak top-K tail (an off-topic query with nothing relevant).
 *
 * Lives HERE (not src/shared/config.ts) on purpose: the orchestrator's many unit/integration tests
 * `vi.mock("../shared/config.js")`, so a new config export would crash those mocks. This module is
 * not mocked, so the orchestrator reads the floor without disturbing them.
 *
 * CODE DEFAULT 0 = OFF (matches the RERANK_CANDIDATE_FLOOR convention: a tuned recall knob is opt-in
 * via env, so the test suite + fresh checkouts are unaffected). The CALIBRATED production value is
 * 0.55; enable it in prod by setting RUNIR_RECALL_RELEVANCE_FLOOR=0.55 in the launchd plist (prod is
 * the local :7700 service). Calibration (2026-06-21) from the conv-26 L2 report: correct golds, when retrieved, score
 * >= 0.5615 (min; p5 0.598; median 0.70) — NONE below 0.55 — while observed off-topic junk scores
 * <= 0.53. 0.55 sits in that gap: simulated 0/40 retrieved golds at risk (zero recall@5 loss on
 * conv-26) while dropping the junk band. Set the env var to 0 for instant rollback.
 * See docs/analysis/2026-06-21-relevance-gate-calibration.md. Cosine scores are in [0,1].
 */
export const RECALL_RELEVANCE_FLOOR = boundedFloatEnv("RUNIR_RECALL_RELEVANCE_FLOOR", 0);

/**
 * Relevance gate decision — should the TURN-path recall return EMPTY because the top hit is not
 * relevant enough? Pure + side-effect-free (unit-testable). True iff:
 *   1. the floor is enabled (> 0),
 *   2. there is a top hit,
 *   3. it is NOT the (retired) opener intent (`session_opener`),
 *   4. the top hit carries a POST-RERANK COSINE score (`scoreStages.reranker.score`) — never the
 *      uncalibrated RRF fallback (which has no reranker stage), AND that score is below the floor.
 * Returning false on RRF-fallback hits is deliberate: the floor is calibrated on the rerank-cosine
 * scale only, so it must never be applied to an uncalibrated RRF score.
 */
export function relevanceGateDrops(
  topHit: { scoreStages?: ScoreStageAttribution } | undefined,
  floor: number,
  intentLabel: string,
): boolean {
  if (floor <= 0 || !topHit || intentLabel === "session_opener") return false;
  const topCosine = topHit.scoreStages?.reranker?.score;
  return topCosine !== undefined && topCosine < floor;
}
