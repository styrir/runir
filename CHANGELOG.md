# Changelog

## 1.0.0 (2026-07-13)

Stable 1.0 cut of Rúnir (`Rúnir-gpaf.1`). Builds on the zed-01 beta (`1.0.0-beta.1`, tag `zed-01`) after the measurement bar closed: retrieval calibration decision package, product-eval real-extraction mode, and cross-adapter co-run Package A (fair answer harness + documented mem0 retrieval co-run).

### What 1.0 is

- Same frozen HTTP surface as the zed-01 beta scope ([docs/zed-01-beta-scope.md](docs/zed-01-beta-scope.md)); no new public endpoints required for this cut.
- Supported clients remain **runir-claudecode** and **runir-codex** (hook-contract gates green at cut).
- Install: Node `>=22.12`, `cp .env.example .env`, local SurrealDB, `npm ci` / `npm start` (or `npm run dev`).
- Deploy posture unchanged: local npm scripts; launchd remains owner-ops.

### Bar items closed since beta (1.0 distance)

- **Correction reliability for 1.0** — safety-biased matcher path (pn1l.13.4); default-ON supersession flip remains **parked** (not required to cut).
- **Rúnir-aa98** — retrieval calibration: max-sentence + candidate-floor NO-GO; `RUNIR_RRF_ENTITY_WEIGHT` plumbing; entity default flip **HOLD** pending conv-30 re-ingest.
- **Rúnir-imaf.5** — `/memory/graph` neighbors honesty (`neighborsUnsupported`).
- **Rúnir-x41m.1** — product eval real-extraction ingest mode + pe-02 extract smoke.
- **Rúnir-x41m.5 / .6** — thin A′ trace rating + Package A co-run spine (pinned AnswerClient, matched mem0 retrieval co-run). Residuals (dashboard, Package B fair-answer, competitive MemPalace slate) are **non-blocking**.

### Quality gates at cut

- `npm run typecheck` / `lint` / `test:ci` (4422 passed)
- Hook contracts: claudecode + codex local PASS
- `npm audit --omit=dev`: **0 vulnerabilities**
- Fresh-clone: `npm ci` + typecheck; keyless boot `/health` on isolated Surreal ns/db

### Explicitly not in 1.0

- Supersession flip default-ON; atomicFact identity-proof default-ON (h435 observational only)
- Full multi-adapter paid answer leaderboard; MemPalace adapter (post-1.0 residual)
- Web Memory Impact dashboard / counterfactual replay polish
- Hermes / OpenClaw / Pi as supported clients

### Rollback

Git tag `v1.0.0`. Service rollback = check out prior tag/sha + restart local service. Surreal data is not versioned with the tag.


## 1.0.0 (2026-07-13)

Stable 1.0 cut of Rúnir (`Rúnir-gpaf.1`). Builds on the zed-01 beta (`1.0.0-beta.1`, tag `zed-01`) after the measurement bar closed: retrieval calibration decision package, product-eval real-extraction mode, and cross-adapter co-run Package A (fair answer harness + documented mem0 retrieval co-run).

### What 1.0 is

- Same frozen HTTP surface as the zed-01 beta scope ([docs/zed-01-beta-scope.md](docs/zed-01-beta-scope.md)); no new public endpoints required for this cut.
- Supported clients remain **runir-claudecode** and **runir-codex** (hook-contract gates green at cut).
- Install: Node `>=22.12`, `cp .env.example .env`, local SurrealDB, `npm ci` / `npm start` (or `npm run dev`).
- Deploy posture unchanged: local npm scripts; launchd remains owner-ops.

### Bar items closed since beta (1.0 distance)

- **Correction reliability for 1.0** — safety-biased matcher path (pn1l.13.4); default-ON supersession flip remains **parked** (not required to cut).
- **Rúnir-aa98** — retrieval calibration: max-sentence + candidate-floor NO-GO; `RUNIR_RRF_ENTITY_WEIGHT` plumbing; entity default flip **HOLD** pending conv-30 re-ingest.
- **Rúnir-imaf.5** — `/memory/graph` neighbors honesty (`neighborsUnsupported`).
- **Rúnir-x41m.1** — product eval real-extraction ingest mode + pe-02 extract smoke.
- **Rúnir-x41m.5 / .6** — thin A′ trace rating + Package A co-run spine (pinned AnswerClient, matched mem0 retrieval co-run). Residuals (dashboard, Package B fair-answer, competitive MemPalace slate) are **non-blocking**.

### Quality gates at cut

- `npm run typecheck` / `lint` / `test:ci` (4422 passed)
- Hook contracts: claudecode + codex local PASS
- `npm audit --omit=dev`: **0 vulnerabilities**
- Fresh-clone: `npm ci` + typecheck; keyless boot `/health` on isolated Surreal ns/db

### Explicitly not in 1.0

- Supersession flip default-ON; atomicFact identity-proof default-ON (h435 observational only)
- Full multi-adapter paid answer leaderboard; MemPalace adapter (post-1.0 residual)
- Web Memory Impact dashboard / counterfactual replay polish
- Hermes / OpenClaw / Pi as supported clients

### Rollback

Git tag `v1.0.0`. Service rollback = check out prior tag/sha + restart local service. Surreal data is not versioned with the tag.

---

## zed-01 — 1.0.0-beta.1 (2026-07-03)

Initial beta cut of Rúnir, the standalone local HTTP memory service. Scope, supported clients, and degraded modes are defined in [docs/zed-01-beta-scope.md](docs/zed-01-beta-scope.md); the API contract lives in [README.md](README.md).

### What this beta is

- Frozen surface: `POST /hooks/recall|capture|session-end|feedback|maintenance`, `POST /memory/think|search`, `GET /memory/get/:id|lineage/:id`, memory CRUD, `GET /health|ready`. Admin routes are owner-ops, not beta surface.
- Supported clients: **runir-claudecode** (supported; gate `npm run test:hooks:contract:local`) and **runir-codex** (supported with smoke gate; `npm run test:hooks:contract:codex:local`). Hermes, OpenClaw, and Pi are out of scope.
- Deploy posture: npm scripts (`cp .env.example .env && npm run dev`), Node >= 22.12. `.env` loads via `--env-file-if-exists`; launchd remains owner-ops.

### Changed in this cut

- **Session-end runs zero LLM work** (turn-based-only extraction): `/hooks/session-end` = watermark + raw-turn recording + session close, response `{skipped:false, rawTurnsRecorded:N, extraction:"disabled"}`. The retroactive staleness pass relocated to the in-process maintenance scheduler (stored-memory mode on `semiote`); session enrichment dropped from automatic paths.
- **Fresh-install hardening:** `.env` actually loads on `npm start`/`dev`; server binds `127.0.0.1` by default (`RUNIR_HOST` opt-out); keyless fail-open boots emit a loud warning; `.env.example` documents required config incl. `RUNIR_RECALL_RELEVANCE_FLOOR=0.55`.
- **Honest surfaces:** malformed JSON bodies degrade instead of 500 on recall/capture/feedback; `/memory/graph` `includeNeighbors` returns an explicit `neighborsUnsupported: true` instead of a silently empty array; `/admin/export` requires `VAULT_EXPORT_PATH` (personal-path fallback removed).
- **Dependencies:** npm audit 20 → 0 vulnerabilities (lockfile-only, within existing semver ranges).
- **Docs:** README rewritten against the live service (retired session-opener and defunct PM2 deploy content removed; `/memory/think` documented); `docs/production-contract.md` retired to a redirect stub; agent-guidance drift fixed (canon §7, storage-retrieval semiote/Requesty).

### Known limitations

- Maintenance (consolidation + relocated staleness) runs in-process while the service runs and **requires the extraction API key**; keyless installs get no automatic staleness maintenance. Forced run: `POST /hooks/maintenance` with `MAINTENANCE_SECRET`.
- Keyless degraded modes: capture returns `{skipped:true, reason:"no capture API key"}`; `/memory/think` returns a handled JSON 500 without the extraction-gateway key. Recall works keyless.
- `project_state` freshness downgraded to capture-warmed-only after the session-end change (documented tradeoff; recall's continuity overlay sees staler snapshots).
- `/memory/graph` entity→entity neighbors are not populated in this release.
- `/admin/export` is out of beta scope: it reads only the legacy `memories` table (measured 2026-07-03: 81 synthetic rows; the live corpus is in `semiote`) and has a known runaway alias-enrichment bug (bead filed).
- npm audit: 0 known vulnerabilities at cut (registry advisories only).

### Rollback

The beta cut is a git tag, not a deploy. Each landing commit records its own revert path; service rollback = `git revert <sha>` + `scripts/restart-local-launchd.sh` + `curl :7700/health`. Pre-cut SurrealDB export: `.pipeline/backups/surreal-main-main-pre-sq3s-2026-07-03.surql`.
