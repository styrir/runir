# App DOX - Runtime And Routes

## Purpose

HTTP service shell: app creation, middleware, auth, runtime defaults, provider/DB singleton wiring, readiness/health/debug/memory/hook routes, bootstrap, and shutdown.

## Ownership

- `server.ts`: app creation, middleware, route registration, bootstrap/shutdown integration.
- `runtime.ts`: environment-derived runtime wiring, providers, DB/cache singletons.
- `auth.ts`, `resolve-user-id.ts`: request identity and API-key enforcement.
- `routes/**`: HTTP endpoint handlers and route-local request/response shaping.
- `readiness.ts`, `shutdown.ts`, `semiote-write-context.ts`: operational support around serving and writing.

## Local Contracts

- Clients call Rúnir; the app layer does not orchestrate external agents.
- `/hooks/recall`, `/hooks/capture`, `/hooks/session-end`, `/memory/*`, and debug route response shapes are external contracts.
- API-key auth is strict bearer equality against configured runtime key; public paths are intentionally narrow.
- `POST /hooks/evidence` (Rúnir-78sy.9, S-2 ingestion) is `PUBLIC_PATHS`-exempt from the `RUNIR_API_KEY` middleware but gated inline by its own `RUNIR_EVIDENCE_SECRET` bearer — fail-closed (401 even when the secret is unset), DELIBERATELY SEPARATE from `MAINTENANCE_SECRET` (which carries consolidation/entity-injection powers the collector must not hold). The handler stays a thin auth/HTTP shell (bearer, body parse, explicit-userId check, caps, enrollment 422) and delegates ingestion policy to `src/lifecycle/evidence/evidence-ingest.ts`; it never logs raw `ref`/`excerpt` content, only counts/`sourceType`/`sourceId`/ids.
- Runtime config comes from environment parsing, not hardcoded credentials or `.env` assumptions.
- Route handlers may delegate to service modules, but must not duplicate storage/retrieval/capture policy logic.

## Work Guidance

- Read `docs/agent-guidance/service-architecture.md` before route or endpoint work.
- Read `docs/agent-guidance/operations-and-env.md` before startup, env, readiness, deploy-adjacent, or local smoke work.
- For hook routes, inspect plugin/client contract tests before changing request or response bodies.
- Keep debug-only fields behind existing debug gates unless a route contract explicitly changes.
- `/hooks/capture` timing debug mode (`captureTimingDebug`, `captureDebug`, `hexisDebug`, or `RUNIR_DEBUG=1`) may include `_debug.timings` with per-phase and nested capture durations plus the longest phase for latency diagnosis.

## Verification

- Route/runtime TypeScript changes: `npm run typecheck` plus focused route tests where available.
- Auth or hook contract changes: run the relevant hook/plugin contract tests.
- Startup/env changes: include a local `/health` or `/ready` smoke after hard restart when feasible.

## Child DOX Index

This subtree has no child AGENTS.md files yet. Add one if a route family becomes a durable boundary with its own local rules.
