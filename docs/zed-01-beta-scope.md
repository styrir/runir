# zed-01 Beta Scope

Status: FINAL — zed-01 cut and tagged 2026-07-03 (annotated tag `zed-01` → `696ec61`, version 1.0.0-beta.1). npm-audit residuals stamped in `CHANGELOG.md` (0 vulnerabilities at cut).

This document freezes what the zed-01 beta ships: the endpoint surface, the ratified scope decisions, the session-start posture, the degraded modes, and the known limitations. Endpoint entries below are derived from the live route registrations in `src/app/server.ts` and `src/app/routes/**` (verified 2026-07-03), never from README.

## 1. Frozen endpoint list

Registration order in `src/app/server.ts:37-41`: health → memory → hooks → debug → admin.

### Hook surface (the ambient memory interface) — `src/app/routes/hooks/index.ts`

| Endpoint | Registered at | Notes |
|---|---|---|
| `POST /hooks/recall` | `src/app/routes/hooks/index.ts:591` | Per-turn recall; the beta continuity surface. |
| `POST /hooks/capture` | `src/app/routes/hooks/index.ts:860` | LLM extraction → arbitrated semiote writes. |
| `POST /hooks/session-end` | `src/app/routes/hooks/index.ts:1238` | Watermarked session-close bookkeeping: watermark + raw-turn recording + `runir_session` close; zero LLM work (D1 landed). |
| `POST /hooks/feedback` | `src/app/routes/hooks/index.ts:700` | Usefulness feedback. |
| `POST /hooks/maintenance` | `src/app/routes/hooks/index.ts:553` | `MAINTENANCE_SECRET` bearer (401 without); 400 without a capture API key; forces consolidation for requested scopes. |

Maintenance-class internal routes (same `MAINTENANCE_SECRET` bearer, exempt from `RUNIR_API_KEY` middleware per `src/app/auth.ts:8-14`; ops-only, not client surfaces): `POST /hooks/entity-repair` (`hooks/index.ts:481`), `POST /hooks/entity-candidates` (`hooks/index.ts:516`).

Trace/observability routes (explicit-userId, agent/ops introspection): `GET /hooks/traces` (`hooks/index.ts:796`), `GET /hooks/traces/:id` (`hooks/index.ts:810`), `POST /hooks/traces/:id/rate` (`hooks/index.ts:834`).

### Deep surfaces (agent-steered, require EXPLICIT `userId`)

| Endpoint | Registered at | Notes |
|---|---|---|
| `POST /memory/think` | `src/app/routes/hooks/index.ts:627` | Registered in the **hooks** router, not the memory router. `{userId, question}` → `{answer, citations, gaps}`; empty retrieval returns an honest no-answer with NO LLM call. |
| `POST /memory/search` | `src/app/routes/memory/index.ts:40` | Raw hybrid candidates. |
| `GET /memory/get/:id` | `src/app/routes/memory/index.ts:259` | Citation follow-up. |
| `GET /memory/lineage/:id` | `src/app/routes/memory/index.ts:369` | Supersession history. |

### Memory CRUD (as registered) — `src/app/routes/memory/index.ts`

| Endpoint | Registered at |
|---|---|
| `POST /memory/store` | `src/app/routes/memory/index.ts:128` |
| `POST /memory/list` | `src/app/routes/memory/index.ts:236` |
| `POST /memory/forget` | `src/app/routes/memory/index.ts:283` |
| `POST /memory/recent` | `src/app/routes/memory/index.ts:326` |
| `POST /memory/restore` | `src/app/routes/memory/index.ts:353` |
| `GET /memory/health` | `src/app/routes/memory/index.ts:383` |
| `POST /memory/graph` | `src/app/routes/memory/index.ts:394` (see §4 for the includeNeighbors limitation) |

### Health

| Endpoint | Registered at |
|---|---|
| `GET /health` | `src/app/routes/health.ts:6` |
| `GET /ready` | `src/app/routes/health.ts:10` |

### Internal / owner-ops (NOT beta client surfaces)

- `POST /debug/ping` (`src/app/routes/debug.ts:9`).
- `/admin` routes (`src/app/routes/admin/index.ts`): `GET /admin/rejection-stats` (:33), `GET /admin/retrieval-stats` (:57), `POST /admin/enrich` (:59), `POST /admin/backfill` (:88), `GET /admin/export` (:165 — OUT of beta scope, see §5), `POST /admin/test/seed` (:189), `POST /admin/test/reset` (:207; the two `/admin/test/*` routes 404 unless `RUNIR_TEST_NS` is set).

## 2. Decisions (recorded, ratified 2026-07-03)

- **D1 — Staleness runs on the in-process consolidation scheduler; enrichment is dropped from the automatic pipeline** (bead Rúnir-y5on/sq3s — LANDED). `/hooks/session-end` does zero LLM work: watermark + raw-turn recording + `runir_session` close, responding `{skipped: false, rawTurnsRecorded: N, extraction: "disabled"}` (holdout-verified at landing). It no longer requires the extraction key.
- **D2 — Clients:** `runir-claudecode` SUPPORTED (gate: `npm run test:hooks:contract:local`); `runir-codex` SUPPORTED-WITH-SMOKE-GATE (`npm run test:hooks:contract:codex:local` at cut); hermes / openclaw / Pi are OUT of beta scope.
- **D3 — Install path:** npm scripts are the beta install path; launchd is private prod (the operator's local deployment, not a beta deliverable).
- **D4 — Keyless fail-open with a loud startup WARN + loopback bind default with `RUNIR_HOST` opt-out** (Rúnir-o75n.1 — LANDED, live in prod). The service binds loopback by default (`src/shared/bind-host.ts`; `serve({ fetch, hostname, port })` at `src/app/server.ts:100`), `RUNIR_HOST=0.0.0.0` restores all-interfaces binding, and keyless boot emits the loud `"WARNING — auth is FAIL-OPEN"` (`src/app/server.ts:91-93`).

## 3. Session-start posture

The 2026-06-13 session-opener retirement IS the beta behavior (see `docs/agent-guidance/architecture-canon.md` §1): the manufactured session-open briefing is withdrawn, and `/hooks/recall` returns `{skipped: true, reason: "opener_retired"}` for opener-style prompts (`src/recall/orchestrator/recall-orchestrator.ts:472-473`). **Per-turn recall is the continuity surface.** A "known facts" session-start surface is explicitly post-beta.

## 4. /memory/graph

Works for entity lookup (by `entityId` or `name`) and supporting-memory lookup. **`includeNeighbors` is explicitly UNSUPPORTED in this release**: entity-to-entity links are never populated (`linkEntities` has zero production callers), so an `includeNeighbors` request returns HTTP 200 with `neighbors: []` plus an explicit unsupported indicator instead of a silent always-empty success (honesty fix Rúnir-o75n.5, `src/app/routes/memory/index.ts:435-453`).

## 5. /admin/export

**OUT of beta scope.** Not documented as a beta surface. At beta cut, the vault export read only the legacy `memories` table and omitted all current-era (`semiote`) memory; the Archeion v2 re-point (Rúnir-78sy.2, post-audit Rúnir-o75n.4) has since moved it to `semiote`/`noema`/`project_state` with tenant scoping (`?userId=`, default the configured tenant), §9.2 secret redaction before disk, and diff-based vault cleanup. The alias-enrichment runaway loop found during zed-01 verification is bounded by `RUNIR_EXPORT_ENRICH_BUDGET`. The endpoint remains out of beta scope.

## 6. Maintenance

Consolidation/staleness maintenance runs as an **in-process scheduler** (startup catch-up + hourly, `src/app/server.ts:103-127`) while the service runs — and ONLY when an extraction API key is configured. Without one, startup logs `"runir-service: consolidation scheduler skipped — no capture API key"` (`src/app/server.ts:127`) and no scheduler starts. `POST /hooks/maintenance` with the `MAINTENANCE_SECRET` bearer forces a run (it also 400s without a capture API key). **Keyless installs get NO automatic staleness maintenance.**

## 7. Keyless degraded modes — two different keys

- **Without the extraction-gateway key** (legacy env name `OPENROUTER_API_KEY`; it carries the Requesty bearer):
  - `POST /hooks/capture` returns `{skipped: true, reason: "no capture API key"}` (`src/app/routes/hooks/index.ts:937`). `/hooks/session-end` no longer needs the key — it does zero LLM work (D1).
  - Zero-fact success is a distinct shape from the keyless skip above: with a key configured and extraction finding no facts, `/hooks/capture` returns `{skipped: false, factsFound: 0, outcomes: {...all zeroed}, units: [], rejections: {...all zeroed}}` (`src/app/routes/hooks/index.ts:1057`) — explicit zeroed counters, never omitted.
  - `POST /memory/think` returns a handled JSON 500 (`{error: "think requires the gateway API key"}`, `src/app/routes/hooks/index.ts:656`) when retrieval found evidence; empty retrieval still returns the honest no-answer shape without needing the key.
  - **Recall still works** — retrieval is embedding + DB only.
- **Without `RUNIR_API_KEY`** (service auth): the API-key middleware is **fail-open only when BOTH** `NODE_ENV` is not `production` **and** `RUNIR_REQUIRE_API_KEY` is not `1`; either condition makes a keyless service fail closed with 503 (`src/app/auth.ts:26-56`). The loud startup WARN for the fail-open case is LIVE (`src/app/server.ts:91-93`, Rúnir-o75n.1).

## 8. Required config

| Variable | Beta guidance |
|---|---|
| `OPENROUTER_API_KEY` | Extraction bearer (legacy name; carries the Requesty gateway bearer). Required for capture/think/maintenance (session-end no longer runs any LLM work); recall works without it. |
| `RUNIR_USER_ID` | Default tenant when requests omit `userId`. **Set it.** Code default is `"default"` (`src/app/runtime.ts:49`); the operator's prod sets `owner` via env. |
| `RUNIR_RECALL_RELEVANCE_FLOOR` | Set `0.55` — the calibrated prod value. Code default is `0` = gate off (`src/recall/selection/relevance-gate.ts:27`). |
| `RUNIR_API_KEY` | Service auth bearer. Without it the service is fail-open outside production (§7). |
| `RUNIR_HOST` | Bind address; default loopback `127.0.0.1` (LIVE, Rúnir-o75n.1). Set `0.0.0.0` to expose beyond loopback — set `RUNIR_API_KEY` first. |
| `EMBEDDINGS_PROVIDER` / `EMBEDDINGS_MODEL` / `EMBEDDINGS_DIMENSIONS` | Canonical embedding config names (`EMBEDDER_*` are legacy fallbacks). Defaults: `ollama` / `nomic-embed-text:v1.5` / `768`. |

## 9. Known limitations

- ~~Fresh-install `.env` loading~~ FIXED (Rúnir-o75n.1): `npm run dev` / `npm start` load `.env` themselves via `node --env-file-if-exists=.env`, so `cp .env.example .env && npm run dev` works on a fresh install (engines: Node >= 22.12).
- ~~Session-end paid extraction~~ LANDED (sq3s/D1): `/hooks/session-end` does zero LLM work. Consequence: `project_state` freshness is capture-warmed-only — a documented tradeoff, not a regression.
- ~~Hook endpoints 500 on malformed request bodies~~ FIXED (Rúnir-o75n.2), live-verified 2026-07-03: malformed JSON degrades to `POST /hooks/recall` → 200 `{skipped:true,reason:"adaptive"}`, `POST /hooks/capture` → 200 `{skipped:true,reason:"no messages"}`, `POST /hooks/feedback` → 400 `{error:"retrievalTraceId and answer are required"}`.
- npm audit: 0 known vulnerabilities at cut (20 → 0, lockfile-only, within existing semver ranges) — recorded in `CHANGELOG.md`.

## Appendix: live probe responses (local prod, 2026-07-03, read-only GET)

`GET http://localhost:7700/health`:

```json
{"status":"ok","userId":"owner","reranker":"local","topK":5}
```

`GET http://localhost:7700/ready`:

```json
{"status":"ready","userId":"owner","reranker":"local","topK":5,"bootstrap":{"ready":true,"checkedAt":"2026-06-29T18:29:28.503Z","checks":[{"name":"api-auth-config","ok":true},{"name":"db-ping","ok":true},{"name":"bm25-index","ok":true},{"name":"phase2-schema","ok":true},{"name":"runir-session","ok":true},{"name":"session-watermarks","ok":true},{"name":"session-turns","ok":true},{"name":"entity-repair","ok":true},{"name":"consolidation-locks","ok":true},{"name":"consolidation-log","ok":true},{"name":"consolidation-state","ok":true},{"name":"dedup-state","ok":true},{"name":"staleness-backlog","ok":true},{"name":"embedding-metadata","ok":true},{"name":"entity-tables","ok":true},{"name":"memory-enrichment","ok":true},{"name":"rejection-log","ok":true},{"name":"supersede-shadow","ok":true},{"name":"synthesis-schema","ok":true},{"name":"attribution-fields","ok":true},{"name":"project-state","ok":true},{"name":"salience-schema","ok":true},{"name":"schema-migrations","ok":true},{"name":"backfill-has-path","ok":true},{"name":"embedder-probe","ok":true}]},"db":{"ok":true}}
```
