# Source DOX - Service Implementation

## Purpose

Source code for the Rúnir HTTP memory service: app startup, routes, capture, recall, storage, lifecycle, domain types, and tests colocated under `src/__tests__/`.

## Ownership

- `app/`: Hono app creation, middleware, runtime wiring, auth, readiness, shutdown, and route registration.
- `capture/`: extraction, salience, enrichment, continuity/project-state warming, and capture context assembly.
- `recall/`: intent analysis, query, orchestration, policy, latest-state/continuity lanes, selection, and trace formatting.
- `storage/`: SurrealDB stores, write arbitration, overlay, embeddings, and reranking.
- `domain/`, `types.ts`, `shared/`: stable domain types, prompts, config parsing, and constants.
- `identity/`: canonical context derivation (session/project/agent scope keys).
- `continuity/`: continuity directive parsing and normalization.
- `entities/`, `hexis/`, `lifecycle/`, `noema/`, `decision/`, `obs/`: domain support modules for ontology, lifecycle, diagnostics, and observability. `lifecycle/semion/` owns the consolidation-tick step ledger (dedup → soft-archive → staleness-backlog → Step 3.4 stored-memory staleness → Step 3.5 entity consolidation → decay/promotion → Step 4.5 continuity build → Step 4.55 idle-session janitor → Step 4.6 continuity-gap detection); `runir_session` durable close-signal model: `session-janitor.ts` (`runSessionIdleJanitorStep`, `RUNIR_SESSION_IDLE_CLOSE_H`) closes active-but-idle rows for consolidation-eligible users, feeding the SAME `last_closed_at` field `resolveRunirSession` (`storage/surreal/runir-session-store.ts`) stamps on every hook-driven close — see `docs/agent-guidance/architecture-canon.md` §3 for the full model (live status vs. durable close event); `lifecycle/archive/` owns the vault exporter + the read-only daily continuity report renderer (`continuity-report.ts`, `path-safety.ts`); `lifecycle/evidence/` owns the S-2 evidence ingestion policy (`evidence-ingest.ts`: `ingestEvidenceBatch` — item validation, the Leit `sourceType` allowlist, size/count caps, batch-hoisted session binding, and the `continuity_evidence` upserts). Per the routes contract, `POST /hooks/evidence` stays a thin auth/HTTP shell and delegates the policy here.
- `testing/` and `__tests__/`: test-only helpers and colocated unit/integration coverage.
- `mcp/`: shared thin MCP stdio adapter (`runir_store` v1). Built into both client packages via `npm run build:runir-mcp` — not a fourth plugins package.

## Local Contracts

- Rúnir remains a standalone HTTP memory service; never import agent frameworks into service code.
- SurrealDB is the source of truth for operational recall; vault/export artifacts are derived, not write-back sources.
- Memory lifecycle defaults to supersede/inactivate, not hard-delete.
- Use canonical ontology terms (`semiote`, `noema`, `hexis`, `syndesis`, `archeion`, `overlay`, `watermark`) when layer semantics matter.
- Name the primary memory table via `PRIMARY_MEMORY_TABLE` (`src/domain/memory/boundary.ts`, re-exported from `domain/memory/types.ts`) — never a bare `"semiote"` literal or an implicit `"memories"` default. `tableName` is required on store/dag-guard signatures with no preceding optional param, and defaults to `PRIMARY_MEMORY_TABLE` on optional-tail signatures. A literal `"memories"` is allowed only at intentional legacy surfaces (admin enrich/backfill routes, the `capture/enrichment/memory-enricher.ts` module, and the legacy clusterer/synthesis paths), where it is spelled out explicitly with a comment.
- Route response shapes, hook envelopes, trace fields, and event schemas are client contracts.
- Read code over comments/docs when behavior conflicts, then fix the stale doc in the same change.

## Work Guidance

- Read `docs/agent-guidance/architecture-canon.md` before re-deriving retrieval/capture/lifecycle architecture.
- Read `docs/agent-guidance/service-architecture.md` for route/module ownership.
- Read the nearest child AGENTS.md before touching `app/`, `capture/`, `recall/`, or `storage/`.
- Trace symbol definitions and usages before edits; do not infer API shapes from names.
- After `src/` edits, hard-restart the local service before any live `/hooks/capture` or live recall probe.

## Verification

- TypeScript/config changes: `npm run typecheck` and `npm run lint` unless a narrower gate is justified.
- Runtime behavior changes: `npm run check` or the specific focused test plus rationale.
- Live hook/capture probes require a hard service restart first.

## Child DOX Index

| Scope | Child DOX | Covers |
|---|---|---|
| `app/` | `src/app/AGENTS.md` | HTTP app, auth, runtime wiring, route registration, shutdown/readiness. |
| `capture/` | `src/capture/AGENTS.md` | LLM extraction, capture context, salience/continuity, enrichment. |
| `recall/` | `src/recall/AGENTS.md` | Query/orchestration/policy/selection/latest-state recall path. |
| `storage/` | `src/storage/AGENTS.md` | SurrealDB stores, write arbitration, overlay, embeddings, reranking. |
