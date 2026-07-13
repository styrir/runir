/**
 * ranking-plan.ts — the DECLARED ranking plan (Rúnir-qjn4.3).
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this lane the recall ranking was 12+ score mutations scattered across
 * three layers (query / route-shaping / selection) with no single place that
 * declared the ORDER, the SEMANTICS (does a stage replace / scale / gate /
 * resort scores?), or the SCALE each stage operates on (rrf / cosine / lexical /
 * multiplier). The canon (architecture-canon.md §2) carried the ledger in prose;
 * this module makes it executable data.
 *
 * RELOCATE-AND-DECLARE, NOT REWRITE
 * ---------------------------------
 * The default plan {@link DEFAULT_RANKING_PLAN} reproduces today's behavior
 * EXACTLY (the attribution-replay gate must stay STRICT IDENTICAL 10/10). The
 * route-side shaping stages that already live in the orchestrator
 * (path-penalty → re-sort → category-boost → soft-filters) are RELOCATED into
 * the engine ({@link executeRankingPlan}) as pure `(hits, params, ctx) -> hits`
 * functions; the orchestrator's inline `buildAdmissiblePool` now delegates to the
 * engine rather than calling each mutation by hand.
 *
 * The QUERY-LAYER stages (rrfFuse, exact-QA bump, noema merge, rerank threshold)
 * are DECLARED here for the ledger but EXECUTED inside the leg machinery in
 * src/recall/query/memory-query.ts — they are DB/embedder-bound and cannot be
 * expressed as pure `(hits) -> hits` functions over an already-fetched hit list.
 * Their plan entries carry `executor: "query_layer"` and are skipped by the
 * orchestrator-side engine; they exist so the plan is the single ledger of record.
 *
 * SCHEMA (ruling R1, R6)
 * ----------------------
 * `{ schemaVersion, stages: [{ name, semantics, scale, executor, enabled,
 *    params? }] }` — zod-validated like ranking-profile.ts. File:line anchors for
 * each stage live in comments/the canon, NOT in the runtime type.
 */
import { z } from "zod";
import type { SearchHit } from "../../domain/memory/types.js";
import type { IntentSignal } from "../intent/intent-analyzer.js";
import { applyCategoryBoost } from "../intent/intent-analyzer.js";
import {
  applyPathScorePenalty,
  applyRecallSoftFilters,
  type RecallScopeFilter,
} from "../query/scope-predicate.js";

// ---------------------------------------------------------------------------
// Schema (zod-validated; ruling R1 + R6).
// ---------------------------------------------------------------------------

/**
 * What a stage DOES to the score field.
 *  - replace:  overwrites score with a different-scale value (e.g. reranker cosine)
 *  - scale:    multiplies / adds to the existing score, same population
 *  - gate:     filters or merges the candidate set (may also re-sort)
 *  - resort:   re-orders without changing scores (or after a same-scale change)
 */
export const RANKING_STAGE_SEMANTICS = ["replace", "scale", "gate", "resort"] as const;
export type RankingStageSemantics = (typeof RANKING_STAGE_SEMANTICS)[number];

/**
 * The numeric SCALE a stage's score field lives on. Declared so a future
 * reviewer can see at a glance which stages mix scales in one sort (the
 * historical applyRerankScores wart — reranker cosine vs preserved RRF).
 */
export const RANKING_STAGE_SCALE = ["rrf", "cosine", "lexical", "multiplier", "threshold"] as const;
export type RankingStageScale = (typeof RANKING_STAGE_SCALE)[number];

/**
 * WHERE a stage executes. `orchestrator` stages are pure `(hits, params, ctx) ->
 * hits` and run inside {@link executeRankingPlan}. `query_layer` stages are
 * DB/embedder-bound and run inside memory-query.ts; they are declared here for
 * the ledger only and skipped by the orchestrator engine.
 */
export const RANKING_STAGE_EXECUTOR = ["orchestrator", "query_layer"] as const;
export type RankingStageExecutor = (typeof RANKING_STAGE_EXECUTOR)[number];

const rankingStageSchema = z.object({
  name: z.string().min(1),
  semantics: z.enum(RANKING_STAGE_SEMANTICS),
  scale: z.enum(RANKING_STAGE_SCALE),
  executor: z.enum(RANKING_STAGE_EXECUTOR),
  /** Disabled stages are skipped by the engine (and ignored as ledger-only when query_layer). */
  enabled: z.boolean(),
  /** Free-form stage parameters (e.g. the exact-QA floor score). */
  params: z.record(z.string(), z.unknown()).optional(),
});

export const rankingPlanSchema = z.object({
  schemaVersion: z.literal(1),
  stages: z.array(rankingStageSchema),
});

export type RankingStage = z.infer<typeof rankingStageSchema>;
export type RankingPlan = z.infer<typeof rankingPlanSchema>;

/** Parse + validate an untrusted plan value (fail-loud, like parseRankingProfiles). */
export function parseRankingPlan(value: unknown): RankingPlan {
  return rankingPlanSchema.parse(value);
}

// ---------------------------------------------------------------------------
// The default plan — reproduces today's exact stage order (STRICT IDENTICAL).
// ---------------------------------------------------------------------------
//
// Ledger order matches architecture-canon.md §2. Each entry's file:line anchor
// is in the trailing comment. `query_layer` stages are ledger-only (executed in
// memory-query.ts); `orchestrator` stages are executed by executeRankingPlan.
//
// The two-line numbers per stage are the verified anchors as of 2026-06-10.

export const DEFAULT_RANKING_PLAN: RankingPlan = {
  schemaVersion: 1,
  stages: [
    // ---- QUERY LAYER (src/recall/query/memory-query.ts) — ledger-only ----
    // 1. App-side RRF fusion of the four parallel legs (k=60; tuning.rrfWeights).
    { name: "rrf_fuse", semantics: "scale", scale: "rrf", executor: "query_layer", enabled: true }, // memory-query.ts:1397 (rrfFuse 1211-1268)
    // 2. Exact-QA additive bump (+exactScore*0.05) when detectExactQaIntent.
    { name: "exact_qa_bump", semantics: "scale", scale: "rrf", executor: "query_layer", enabled: true }, // memory-query.ts:1576-1604
    // 3. Noema merge — interleave noema RRF-scale hits with semiote RRF hits and
    //    re-sort (comparable scales; 0gk6.2). Declared AS-IS, NO normalization (R2).
    { name: "noema_merge", semantics: "gate", scale: "rrf", executor: "query_layer", enabled: true }, // memory-query.ts:1768 (mergeNoemaRetrievalLeg)
    // 4. Reranker threshold/replace — reranker cosine replaces RRF for hits above
    //    threshold; exact-QA hits preserved (the historical scale-mixing wart).
    { name: "rerank_threshold", semantics: "replace", scale: "cosine", executor: "query_layer", enabled: true }, // memory-query.ts:1880 (applyRerankScores)
    // 4b. Exact-QA preserve floor-score fix (ruling R3) — DEFAULT-OFF. When enabled,
    //     preserved exact-QA hits get a floor score = the active rerank threshold
    //     (keeping their reranker cosine when they have one) so they rank among the
    //     high-confidence reranked population instead of parking at the RRF-scale
    //     bottom. OFF here keeps today's behavior byte-equal (STRICT IDENTICAL).
    {
      name: "exact_qa_preserve_floor",
      semantics: "scale",
      scale: "threshold",
      executor: "query_layer",
      enabled: false,
    },

    // ---- ROUTE-SIDE SHAPING (orchestrator) — EXECUTED by executeRankingPlan ----
    // 5. Null-path score penalty (0.70×) for hits without a path.
    { name: "path_score_penalty", semantics: "scale", scale: "multiplier", executor: "orchestrator", enabled: true }, // scope-predicate.ts:175 (applyPathScorePenalty)
    // 5b. Deterministic re-sort after the penalty (descending score).
    { name: "path_penalty_resort", semantics: "resort", scale: "multiplier", executor: "orchestrator", enabled: true }, // recall-orchestrator.ts:747
    // 6. Category boost (1.15×) for hits whose category matches intent (re-sorts).
    { name: "category_boost", semantics: "scale", scale: "multiplier", executor: "orchestrator", enabled: true }, // intent-analyzer.ts:153 (applyCategoryBoost)
    // 7. Recall soft filters (since/tier/tags/confidence) — gating only.
    { name: "recall_soft_filters", semantics: "gate", scale: "multiplier", executor: "orchestrator", enabled: true }, // scope-predicate.ts:208 (applyRecallSoftFilters)

    // ---- SELECTION (postProcessRecallResults, recall-selection.ts) — ledger-only ----
    // The post-process pipeline runs as one fused unit inside buildSelectedViewFromPool.
    // Declared as its constituent stages so the ledger is complete; executed by
    // postProcessRecallResults, NOT re-invoked by the engine (relocating it would
    // double-apply). See recall-selection.ts:479-562.
    // 8. Stale-signal demotion (0.40×) on the UNION of (a) profile regex match for
    //    the intent and (b) the LEARNED status-noise set on status-class intents
    //    (status_retrieved_count >= threshold AND status_used_count == 0, pins
    //    excluded — Rúnir-mmg2.2). Empty learned set ⇒ byte-identical to the
    //    regex-only path (replay STRICT IDENTICAL holds at landing).
    { name: "stale_signal_demotion", semantics: "scale", scale: "multiplier", executor: "query_layer", enabled: true }, // recall-selection.ts (applyStaleSignalDemotion)
    // 9. Status recency penalty (0.50×) for current_status/session_opener > 7d old.
    { name: "status_recency_penalty", semantics: "scale", scale: "multiplier", executor: "query_layer", enabled: true }, // recall-selection.ts:314-331
    // 10. Contradiction collapse (rename pairs + first-sentence Jaccard dedup).
    { name: "contradiction_collapse", semantics: "gate", scale: "multiplier", executor: "query_layer", enabled: true }, // recall-selection.ts:382-437
    // 11. Selector-profile gating + policy-driven re-score/re-sort.
    { name: "selector_profile_shaping", semantics: "gate", scale: "multiplier", executor: "query_layer", enabled: true }, // recall-selection.ts:637-815
    // 12. Primary-representative promotion (force a primary-group hit to rank 0).
    { name: "primary_representative_promotion", semantics: "resort", scale: "multiplier", executor: "query_layer", enabled: true }, // recall-selection.ts:578-604
  ],
};

// ---------------------------------------------------------------------------
// The engine — executes the orchestrator-side stages in declared order.
// ---------------------------------------------------------------------------

/**
 * Per-request context the orchestrator-side stages read. Everything here is
 * already available in the deps-injected orchestrator layer (scout Q2) — no Hono
 * context leaks. Pure data in, pure data out.
 */
export interface RankingPlanContext {
  readonly intent: IntentSignal;
  readonly requestedPath: string | undefined;
  readonly recallFilter: RecallScopeFilter;
}

/** The pure signature every orchestrator-side stage implements. */
type StageFn = (hits: SearchHit[], stage: RankingStage, ctx: RankingPlanContext) => SearchHit[];

/**
 * Stage implementations for the orchestrator-executor stages. Each is a thin,
 * RELOCATED wrapper around the existing mutation function (no behavior change) so
 * the engine owns the ORDER while the proven per-stage logic stays put.
 */
const ORCHESTRATOR_STAGES: Record<string, StageFn> = {
  path_score_penalty: (hits, _stage, ctx) => applyPathScorePenalty(hits, ctx.requestedPath),
  // Deterministic re-sort after the penalty — was the inline
  // `[...withPenalty].sort((a, b) => b.score - a.score)` in buildAdmissiblePool.
  path_penalty_resort: (hits) => [...hits].sort((a, b) => b.score - a.score),
  category_boost: (hits, _stage, ctx) => applyCategoryBoost(hits, ctx.intent),
  recall_soft_filters: (hits, _stage, ctx) => applyRecallSoftFilters(hits, ctx.recallFilter),
};

/**
 * Executes the ORCHESTRATOR-side stages of a ranking plan in declared order over
 * an already-fetched candidate list. Query-layer stages (executor:"query_layer")
 * are skipped — they run inside the leg machinery. Disabled stages are skipped.
 *
 * Contract: pure. No DB, no embedder, no side effects. Each stage takes
 * `(hits, stage, ctx)` and returns the next `hits`. An unknown orchestrator-stage
 * name throws (fail-loud — a typo in a plan must not silently no-op a mutation).
 *
 * Replacing buildAdmissiblePool's hand-written sequence with
 * `executeRankingPlan(rawResults, DEFAULT_RANKING_PLAN, ctx)` is byte-identical:
 * the four executed stages (path_score_penalty → path_penalty_resort →
 * category_boost → recall_soft_filters) reproduce the exact inline order.
 */
export function executeRankingPlan(
  hits: SearchHit[],
  plan: RankingPlan,
  ctx: RankingPlanContext,
): SearchHit[] {
  let current = hits;
  for (const stage of plan.stages) {
    if (stage.executor !== "orchestrator") continue;
    if (!stage.enabled) continue;
    const fn = ORCHESTRATOR_STAGES[stage.name];
    if (!fn) {
      throw new Error(
        `ranking-plan: no orchestrator implementation for stage "${stage.name}" — ` +
        `every executor:"orchestrator" stage must have an implementation in ORCHESTRATOR_STAGES`,
      );
    }
    current = fn(current, stage, ctx);
  }
  return current;
}

/**
 * Resolves the exact-QA preserve floor-score from the plan, if the default-OFF
 * fix entry is enabled. Returns `undefined` when the entry is absent or disabled
 * — callers (memory-query.ts applyRerankScores wiring) must treat `undefined` as
 * "use today's preserve-pass-through behavior". Ruling R3.
 *
 * ENV HOOK (Rúnir-qjn4.4, ruling R1): if RUNIR_EXACT_QA_PRESERVE_FLOOR is set to
 * a finite positive number in the environment, return it unconditionally (the entry
 * is treated as enabled with that floor). Absent or non-numeric/non-positive/NaN →
 * fall through to the plan entry's enabled flag + params. The default plan keeps
 * the entry disabled (enabled:false), so the env var is the ONLY mechanism to turn
 * the floor on without a code-level default flip — this is the production flip
 * mechanism (config-over-code, mmg2.1 precedent). Landing this hook is
 * replay-neutral (env var absent ⇒ byte-identical behavior).
 */
export function resolveExactQaPreserveFloor(plan: RankingPlan): number | undefined {
  // Env hook: RUNIR_EXACT_QA_PRESERVE_FLOOR overrides the plan entry when set to
  // a finite, strictly-positive number. Garbage / absent / zero → fall through.
  const envRaw = process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"];
  if (envRaw !== undefined) {
    const envFloor = Number(envRaw);
    if (Number.isFinite(envFloor) && envFloor > 0) return envFloor;
  }

  const stage = plan.stages.find((s) => s.name === "exact_qa_preserve_floor");
  if (!stage || !stage.enabled) return undefined;
  const floor = stage.params?.floorScore;
  return typeof floor === "number" ? floor : undefined;
}
