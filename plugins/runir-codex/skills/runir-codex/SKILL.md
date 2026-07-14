---
name: runir-codex
description: Install, verify, or debug the Rúnir Codex dogfooding setup for this repo. Use when Codex should wire or inspect Rúnir recall/capture hooks, update Codex hook config, or replay Codex hook payloads against the Rúnir service.
---

# Rúnir Codex

Use this skill when the task is about making Codex itself dogfood Rúnir in this repo.

## What this package owns

- The packaged Codex skill surface under `skills/`
- Hook handler scripts under `hooks/`
- Companion activation and verification helpers under `scripts/`
- MCP adapter: `.mcp.json` + bundled `mcp/runir-mcp.mjs` (`runir_store` for explicit remember; requires `RUNIR_USER_ID` + `RUNIR_API_KEY` in the environment)

## Mechanism

The plugin package and the hook configuration are separate surfaces.

- `plugins/runir-codex/hooks/runir_user_prompt.py` calls `/hooks/recall`
- `plugins/runir-codex/hooks/runir_stop_capture.py` calls `/hooks/capture`
- `plugins/runir-codex/hooks/gitnexus-hook.cjs` mirrors the GitNexus agent hook behavior for Codex `PreToolUse` and `PostToolUse`
- `plugins/runir-codex/scripts/activate_companion_hooks.py` writes companion hook entries to either project-scoped or user-scoped `hooks.json`, preferring the extracted Codex marketplace checkout when one is present
- `plugins/runir-codex/scripts/verify_companion_hooks.py` reports which scope is active and which target path is in use
- Codex `hooks.json` supports only the root `hooks` object. Hook trust state belongs in `config.toml` under `[hooks.state]`; a root `state` object makes Codex reject the hook config.

## Explicit remember (MCP)

After plugin install, MCP exposes **`runir_store`** from the bundled
`mcp/runir-mcp.mjs` (see `.mcp.json`). Requires `RUNIR_USER_ID` and
`RUNIR_API_KEY` in the environment (no credentials in the plugin config).
Companion hooks remain a **separate** activation surface; MCP store works without them.

## Required environment

- `RUNIR_BASE`
- `RUNIR_USER_ID`
- `RUNIR_API_KEY` (for MCP store and authenticated hooks)
- Codex hooks enabled in `~/.codex/config.toml` with the canonical feature key:

```toml
[features]
hooks = true
```

`codex_hooks = true` is only the deprecated alias.

## Validation

Project-scoped activation:

```bash
codex plugin marketplace add .
python3 plugins/runir-codex/scripts/activate_companion_hooks.py --scope project
python3 plugins/runir-codex/scripts/verify_companion_hooks.py
```

User-scoped activation:

```bash
codex plugin marketplace add .
python3 plugins/runir-codex/scripts/activate_companion_hooks.py --scope user
python3 plugins/runir-codex/scripts/verify_companion_hooks.py
```

Then replay the fixture tests or targeted Vitest coverage for the hook scripts.

## Important boundary

Do not claim that Codex plugin installation alone provides automatic memory injection. The automatic behavior comes from separately activated companion hooks; the plugin package ships the assets and helpers, but the hook config remains a separate Codex surface.
