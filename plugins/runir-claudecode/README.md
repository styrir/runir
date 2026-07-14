# runir-claudecode

Claude Code plugin that wires Rúnir into the native Claude plugin lifecycle. The install truth is the installed plugin representation that Claude creates after marketplace install, not a symlinked home-hook layout.

## Package surfaces

- Manifest: `.claude-plugin/plugin.json`
- Native hook config: `hooks/hooks.json`
- MCP: `.mcp.json` → bundled `mcp/runir-mcp.mjs` (`runir_store` tool)
- Marketplace entry: repo root `.claude-plugin/marketplace.json`

## What it does

| Phase | Hook event | Script | Purpose |
|-------|-----------|--------|---------|
| Session open | `SessionStart` (startup/resume/clear/compact) | `runir-opener.sh` | Fetches session-opener payload (project state + continuity hits + next-steps summary) and injects it via `hookSpecificOutput.additionalContext` |
| Each turn | `UserPromptSubmit` | `runir-recall.sh` | Recalls relevant memories from Rúnir before each user turn and prepends them via `hookSpecificOutput.additionalContext` |
| After turn | `Stop` + `StopFailure` | `runir-capture.sh` → `runir_capture.py` | Incrementally captures the new assistant turn to Rúnir with watermark tracking |
| Session end | `SessionEnd` | `runir-session-end.sh` | Flushes remaining messages, attaches git evidence for sparse sessions, advances cursor |
| Explicit save | MCP tool `runir_store` | `mcp/runir-mcp.mjs` | User-scope `POST /memory/store` when the model saves deliberately |

`RUNIR_USER_ID` and `RUNIR_API_KEY` must be present in the process environment for MCP (no credentials in plugin config; no default tenant). Rebuild the bundled adapter after changing `src/mcp/`: `npm run build:runir-mcp`.

## Install

From the repo root:

```bash
claude plugin validate .
claude plugin marketplace add ./.claude-plugin/marketplace.json --scope local
claude plugin install runir-claudecode@runir-local-claude --scope local
```

`hooks/hooks.json` uses `${CLAUDE_PLUGIN_ROOT}` so Claude can run the copied plugin from its installed cache layout without relying on repo checkout paths.

## Required env vars

Set these in the active Claude scope (`~/.claude/settings.json`, project settings, or managed settings):

| Variable | Required | Description |
|----------|----------|-------------|
| `RUNIR_USER_ID` | Yes | Your Rúnir userId. Hooks skip silently if unset. |
| `RUNIR_API_KEY` | Yes | Bearer token for the Rúnir service. |

Optional overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNIR_BASE` | `http://127.0.0.1:7700` | Service base URL |
| `RUNIR_RECALL_URL` | `$RUNIR_BASE/hooks/recall` | Recall endpoint |
| `RUNIR_CAPTURE_URL` | `$RUNIR_BASE/hooks/capture` | Capture endpoint |
| `RUNIR_SESSION_END_URL` | `$RUNIR_BASE/hooks/session-end` | Session-end endpoint |
| `RUNIR_OPENER_URL` | `$RUNIR_BASE/hooks/recall` | Opener endpoint |
| `RUNIR_CLIENT` | `claudecode` | Client identity tag sent to server |
| `RUNIR_DEBUG` | `0` | Set to `1` to log 2xx and transport failures (4xx/5xx always log) |
| `RUNIR_RECALL_TIMEOUT` | `20` | Recall curl max-time (seconds) |
| `RUNIR_CAPTURE_TIMEOUT` | `30` | Capture HTTP timeout (seconds) |
| `RUNIR_SESSION_END_TIMEOUT` | `60` | Session-end curl max-time (seconds) |
| `RUNIR_OPENER_TIMEOUT` | `10` | Opener curl max-time (seconds) |
| `RUNIR_MAX_TRANSCRIPT_BYTES` | `10485760` | Skip sessions with transcripts above this size |
| `RUNIR_SPARSE_THRESHOLD` | `10` | Sessions below this message count get git evidence attached |
| `RUNIR_MAX_DIFF_CHARS` | `2000` | Max chars of git diff to include per session |
| `RUNIR_GIT_SRC_PREFIX` | `src/` | git diff path prefix for sparse-session evidence |

The localhost default is the local daily-driver profile. Packaged or remote deployments should set `RUNIR_BASE` or the endpoint-specific URL variables explicitly rather than relying on that default.

## Validation

```bash
claude plugin validate .
npm run test:hooks:contract:local
```

For a reinstall or version bump, update `.claude-plugin/plugin.json`, run `claude plugin marketplace update runir-local-claude`, then reinstall or update the plugin so Claude refreshes the cached copy.

## Logs and state

The plugin still writes runtime state to `~/.claude/state/runir/`:

| File | Written by |
|------|-----------|
| `recall-debug.log` | `runir-recall.sh` |
| `opener-debug.log` | `runir-opener.sh` |
| `session-end.log` | `runir-session-end.sh` |
| `capture.log` | `runir_capture.py` |
| `capture-watermarks.json` | `runir_capture.py` |
| `session-end-state.json` | `runir-session-end.sh` |

When debugging `SessionEnd`, do **not** rely on transcript attachments alone. Claude Code writes most hook stdout to debug logs rather than the transcript, and `SessionEnd` is especially easy to misread if you only inspect the JSONL tail. Use `~/.claude/state/runir/session-end.log` (plus `--debug` when needed) as the authoritative signal for whether the hook ran and which exit reason it saw.

The session-end hook also forwards Claude’s lifecycle reason to the server as `terminationReason` (for example `resume`, `clear`, or `prompt_input_exit`) so downstream processing can distinguish a resumed handoff from a true prompt exit.

On the server side, `/hooks/session-end` marks the `runir_session` row closed, and later active routes (opener/recall/capture) re-mark that same row active when work resumes on the same native session identity.
