# runir-grok

Native Grok lifecycle adapter for Rúnir (thin HTTP client).

## Layout

| Path | Role |
|------|------|
| `hooks/runir-grok.py` | Source of truth for UserPromptSubmit / PreToolUse / Stop |
| `templates/user-hooks.json` | Hooks document template (`__PLUGIN_ROOT__`, narrowed PreToolUse matcher) |
| `scripts/install_hooks.py` | Deploy template → `~/.grok/hooks/runir-grok.json` |
| `scripts/verify_hooks.py` | Assert matcher ≠ `.*`, command path, timeout floors |
| `scripts/memory_bridge.py` | Idempotent `[memory]` config + write-only MEMORY.md bridge |
| `tests/` | Unit tests for D1–D4 + P (+ fail-open) |

## Hardening

- **D1** — Stale capture bail: pending markers older than `RUNIR_CAPTURE_STALE_S` (5s) are marked `stale` and UPS continues.
- **D2** — `fcntl.flock` on recall consume / write / dedupe (local `~/.grok/state/runir` only).
- **D3** — `sha256(context)` cross-turn dedupe (TTL 3600s, max 32).
- **D4** — PreToolUse matcher is a frozen tool-name regex (not `.*`). MCP `server__tool` first-tools skip the gate; Stop still delivers later.
- **P** — Batch sibling re-deny within `RUNIR_BATCH_SIBLING_S` (2s) so multi-tool drafts all see the same correction once.

## Install (machine-local)

```bash
python3 plugins/runir-grok/scripts/install_hooks.py --user --dry-run
python3 plugins/runir-grok/scripts/install_hooks.py --user
python3 plugins/runir-grok/scripts/verify_hooks.py --user
python3 plugins/runir-grok/scripts/memory_bridge.py --write-config
python3 plugins/runir-grok/scripts/memory_bridge.py --sync --canary
```

Requires `RUNIR_USER_ID` (and optional `RUNIR_API_KEY` / `RUNIR_BASE`) for live recall/capture.

## Tests

```bash
python3 -m pytest plugins/runir-grok/tests -q
```

## Non-goals

ACP wrapper, embeddings (`[memory.embedding]` unset), Stop UX A/B.
