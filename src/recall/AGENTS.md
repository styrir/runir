# Recall DOX - Retrieval, Policy, Selection

## Purpose

Prompt-time memory retrieval and shaping: intent analysis, retrieval recipes, hybrid query legs, noema/continuity/latest-state lanes, ranking plans, hexis application, selection, rendering, and trace output.

## Ownership

- `orchestrator/`: route-independent recall orchestration, ranking plan execution, synthesis helpers.
- `query/`: hybrid memory/noema/entity/vector/BM25/recency retrieval and scope predicates.
- `policy/`: retrieval controller, profiles, calibration telemetry, preference packets.
- `selection/`: post-processing, formatting, trace types, stats, and chosen recall payloads.
- `intent/`, `continuity/`, `latest-state/`: intent classification and deterministic continuity/status lanes.

## Local Contracts

- Recall follows “just in time, just enough”; do not inflate prompt payloads without explicit rationale.
- The hot path searches `semiote` evidence; legacy `memories` paths are not interchangeable without a migration decision.
- User-prompt reranking must not make LLM calls; inline rerank is local/off only.
- Ranking/selection mutations are contract-sensitive; preserve trace/audit fields and declared ranking-plan order unless intentionally changing behavior.
- Scope, path, tenant, and session boundaries are safety contracts; never weaken filters to make a benchmark row pass.
- Budget-aware projection (OM-1, Rúnir-tfxt.1): `/hooks/recall` accepts optional `budgetTokens`; the fit (`selection/recall-selection.ts` `fitSelectionToBudget`) is strictly additive — absent/invalid budget = byte-identical no-budget behavior (unit-enforced in `src/__tests__/recall-budget-fit.test.ts`), ranking untouched (uniform depth ladder full→l1→l0, then prefix-only tail drop), no cross-lane refill (a budget-emptied deterministic recall returns empty, never falls to hybrid), chars/4 heuristic (budget-aware, not token-exact), payload-shaped intents excluded (retired session_opener + the OM-2 compaction intents).
- Compaction-render projection (OM-2, Rúnir-tfxt.2): `sessionKind: "pre_compaction" | "post_compaction_validation"` (exact strings only; anything else = absent) routes to the `compaction_projection` lane/recipe and serves `SessionOpenerPayload` re-rendered under a `compaction_projection:` root (`continuity/compaction-projection.ts`; `post_validation` = recite-back trim, no env/evidence_titles). NOT an opener revival — canon §1 retirement stands (`sessionKind:"opener"` still returns `opener_retired`). Compaction recalls NEVER fall through to hybrid (honest empty instead), build without supplemental hits, and the budget fit is drop-only + prefix-only measured on the wrapped injection; the fitted set replaces `selected` everywhere downstream (trace items drive usefulness accrual). Compaction labels are STATUS_CLASS (demotion/recency/accrual). Mock-hazard rule: orchestrator + recall-selection use LOCAL literal label checks, never new imports from vi.mock'ed modules — drift-guard pin in `src/__tests__/intent-analyzer.test.ts`.
- RecipeRegistry is **authoritative** for per-recipe source budgets + latest-state shaping/formatting, and **policy-derived** for `retrievalPath` (set once per lane by `resolveRetrievalPolicyForLane`, consumed via `args.retrievalPath`); never independently author the path. Keep the recipe-id↔`retrievalPath` drift guard (`__tests__/retrieval-controller.test.ts`, `policy/__tests__/retrieval-policy.test.ts`). (Rúnir-5hug ruling, 2026-06-20: behavioral authority for budgets/shaping, not audit-only.)

## Work Guidance

- Read `docs/agent-guidance/architecture-canon.md` §2 before recall work.
- Read `docs/agent-guidance/storage-retrieval.md` before query, SurrealDB, reranking, scope, or selection work.
- Benchmark-driven fixes must name a generic failure mode and prove it outside the target row.
- For `/hooks/recall` quality checks, save raw samples/baselines under `docs/testing/` when required by user preference.

## Verification

- Query/selection changes: focused recall tests plus `npm run typecheck`.
- Refactor lanes affecting ranking order: use attribution replay when relevant.
- Story Probe or LoCoMo work must follow `docs/agent-guidance/test-harness-procedures.md` and keep lane evidence separate.

## Child DOX Index

This subtree has no child AGENTS.md files yet.
