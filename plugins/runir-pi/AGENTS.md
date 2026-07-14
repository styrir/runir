# Rúnir Pi plugin

## Purpose

Product-shipped Pi extension for Rúnir memory (recall/capture + OM lanes). Thin HTTP client only.

## Ownership

- `extensions/runir-memory.ts` — global Rúnir memory integration for Pi lifecycle recall/capture, the OM compaction-projection lanes (`pre_compaction` / `post_compaction_validation`), the `runir_recall` LLM tool, plus `/runir` inspector and `/om:*` command UI.

Ouroboros integration is handled by the upstream `npm:pi-ouroboros` package, not by this package. MCP integration is handled by the global `pi-mcp-adapter` package, not by this package. Standard MCP server config lives in `~/.config/mcp/mcp.json`.

## Local Contracts

- This package is the Rúnir Pi client only. Other Pi tools stay outside this product repo.
- Rúnir defaults for local daily-driver use:
  - `RUNIR_BASE=http://127.0.0.1:7700`
  - `RUNIR_USER_ID=brooks`
  - `RUNIR_API_KEY` is read from the Pi process environment first, then from `RUNIR_ENV_FILE` (default `/Users/brooks/Code/runir/.env`); never store it in this package.
  - Per-turn capture timeout defaults to 45 seconds (`RUNIR_CAPTURE_TIMEOUT_MS=45000`) because live `/hooks/capture` extraction can exceed 10 seconds even when the local service and SurrealDB are healthy.
  - Footer status uses the `ᚱ` rune without memory counts: `ᚱ ready`, `ᚱ /runir`, `ᚱ skip`, `ᚱ err /runir`.
  - Memory counts/content, request durations, and opt-in nested timing breakdowns are visible only from `/runir`, `/runir:last`, `/runir:session`, `/runir:captures`, `/runir:errors`, and `/om:view`; `/runir:debug on|off` toggles debug capture timing breakdowns in capture entries; automatic recall must not emit visible `[runir]` chat messages.
- OM banded compaction trigger (Rúnir-tfxt.5):
  - Bands evaluate RAW `ctx.getContextUsage().percent` on `turn_end` (Pi does not expose reserveTokens/usable-context to extensions), each with a once-per-crossing latch that re-arms below the threshold or after any compaction: soft `RUNIR_OM_SOFT_PERCENT=55` (full-branch capture flush — inherits the old single-threshold lane, NOT gated by `RUNIR_OM_DISABLED`; legacy `RUNIR_PRECOMPACT_PERCENT` overrides it), plan `RUNIR_OM_PLAN_PERCENT=70` (prepares a `pre_compaction` projection for the summarizer; success-only disarm with `RUNIR_OM_PLAN_RETRY_MS=60000` cooldown), forced `RUNIR_OM_FORCED_PERCENT=85` OR `RUNIR_OM_FORCED_TOKEN_CEILING=200000` tokens (absolute backstop for huge windows).
  - The forced band ARMS on `turn_end` but EXECUTES at `agent_end`: `ctx.compact()` aborts in-flight agent operations and `turn_end` fires mid-run inside tool loops. Mid-run overflow is left to Pi's native auto-compaction. Execution refreshes the prepared projection if older than `RUNIR_OM_PREPARED_FRESH_MS=120000` (reusing an in-flight plan fetch), then compacts with the projection as summarizer focus behind an ignore-embedded-instructions hygiene line — or without one on honest empty. A `compactGuardSince` timestamp (any pending/observed compaction; expires after `RUNIR_OM_COMPACT_PENDING_TTL_MS=120000`) prevents overlap.
  - The prepared slot is separate from the injection slot (staging it there would inject without a compaction); it is generation-guarded and dropped on `session_start`/`session_compact`. Band ordering: only plan < forced is enforced (soft is independent — legacy 75 above plan 70 is valid); invalid configs warn and use defaults.
- OM recall bridge (Rúnir-tfxt.6): `/om:recall <id> [lineage]` and the `runir_recall(id, lineage?)` LLM tool are deterministic id expansion over `GET /memory/get` + `GET /memory/lineage` (deep surfaces — `userId` always explicit; no /memory/think or /memory/search here). A get-404 always consults lineage before reporting not-found (`/memory/get` is active-rows-only; superseded ids live in the chain), and chain states are labeled CURRENT vs stale. The tool THROWS on infra failures (Pi marks the result as a tool error); invalid-id and not-found are normal text. The command is fully fail-soft. Retrieved memory text is wrapped in the UNTRUSTED-data envelope. Not gated by `RUNIR_OM_DISABLED` (read-only, explicitly invoked).
- OM compaction projection (Rúnir-tfxt.4; server side is Runir OM-2):
  - `session_before_compact` awaits a `pre_compaction` budgeted projection fetch (bounded by `RUNIR_OM_RECALL_TIMEOUT_MS=4000`, composed with Pi's abort signal; fire-and-forget on overflow-recovery `willRetry`) and stages it; `session_compact` fire-and-forgets a `post_compaction_validation` fetch that REPLACES a staged pre projection when it lands. Never inject both.
  - The staged projection is injected ONE-SHOT into the next turn's system prompt ahead of per-turn recall, before the API-key check and the client skip filter, and even when per-turn recall fails. Every turn start closes the injection window (late in-flight fetches are discarded, even when the slot was empty). Staleness drops: TTL (`RUNIR_OM_STAGED_TTL_MS=900000`), session change, path change, any `session_start`.
  - Thin-client boundary: the adapter never parses, compares, or summarizes projections — the server renders; the adapter stages and injects. An honest-null `prependContext` means "compact without a projection", not an error. Nothing in the OM lanes may block or cancel a compaction or a turn beyond the single bounded awaited fetch.
  - Budgets: `RUNIR_OM_PRE_BUDGET_TOKENS=1000`, `RUNIR_OM_POST_BUDGET_TOKENS=500` (live-measured floors: projectState-only pre render >150 tokens; 5-item post render ≈300). Kill switch `RUNIR_OM_DISABLED=1` disables only the OM lanes (existing capture/recall unaffected).
  - `/om:ping` reports service reachability (auth-exempt `/health`) plus an authenticated `/hooks/recall` check (empty-prompt adaptive skip — cheap, no retrieval); `/om:view` (also `/runir om`) shows the staged slot and om-* traces. Invalid `RUNIR_OM_*` numeric values fall back to defaults with a console warning.
- Ouroboros defaults:
  - install as `pi install npm:pi-ouroboros`; it provides Pi-native `oo_*` tools and slash commands like `/oo-init`, not the legacy `/ooo` bridge.
  - keep the `npm:pi-ouroboros` package filtered with `prompts: []` in `~/.pi/agent/settings.json` until upstream stops double-loading prompts from both manifest and `resources_discover`.
  - local installed package patches currently remove the visible-prone routing reminder hook and translate `/oo-init`/`/oo-onboard` prompts to English; `pi update` or reinstall may overwrite them.
- MCP defaults:
  - use `pi-mcp-adapter`
  - configure servers in `~/.config/mcp/mcp.json`
  - prefer `lifecycle: "lazy"`
  - keep `directTools: false` unless a specific high-frequency tool is intentionally promoted.

## Work Guidance

- Install globally with `pi install /Users/brooks/Code/runir/plugins/runir-pi` rather than symlinking individual files.
- Use `npm:pi-ouroboros` for Ouroboros behavior; do not restore or load the removed local legacy `/ooo` bridge from this package.
- Use `pi-mcp-adapter` plus standard MCP config for MCP servers.
- Keep project-specific behavior in the relevant project repo.
- Secrets must come from environment variables or an external secret manager; do not write API keys into this repo.
- Reload Pi with `/reload` after changing extension source or MCP config.

## Verification

```bash
npx --yes esbuild extensions/runir-memory.ts --bundle --platform=node --format=esm --outfile=/tmp/pi-tools-runir-memory.mjs --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-tui
test/run.sh   # OM-4/5/6 regression harnesses (stub server; no Pi, no Runir needed)
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
pi list
python3 -m json.tool ~/.pi/agent/settings.json
python3 -m json.tool ~/.config/mcp/mcp.json
curl http://127.0.0.1:7700/health
```

`test/om*-harness.mjs` drive the bundled extension with fake Pi runtimes against a controllable stub Runir server (49 cases across staging/injection, band latching, and the recall bridge). `test/om*-live-smoke.mjs` hit the REAL service on `:7700` as tenant brooks — run individually, not in CI-style loops.
