# runir-grok

Native Grok lifecycle adapter for Rúnir (thin HTTP client).

## Layout

| Path | Role |
|------|------|
| `hooks/runir-grok.py` | Source of truth for UserPromptSubmit / PreToolUse / Stop |
| `templates/user-hooks.json` | Hooks document template (`__PLUGIN_ROOT__`, narrowed PreToolUse matcher) |
| `scripts/install_hooks.py` | Deploy template → `~/.grok/hooks/runir-grok.json` |
| `scripts/verify_hooks.py` | Assert matcher ≠ `.*`, command path, timeout floors; `--skill` for /runir |
| `scripts/install_skill.py` | Deploy `skills/runir/SKILL.md` → `~/.grok/skills/runir/` |
| `scripts/runir_inspect.py` | On-demand inspector (`last|session|captures|errors|bridge|status`) |
| `scripts/runir_watch.py` | Live second-pane tail (`--mode once|watch`) |
| `skills/runir/SKILL.md` | `/runir` slash skill (SoT; user-invocable) |
| `scripts/memory_bridge.py` | Idempotent `[memory]` config + write-only MEMORY.md bridge |
| `tests/` | Unit tests for D1–D4 + P (+ fail-open + observability) |

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

Skill install (sibling installer; does not touch hooks):

```bash
python3 plugins/runir-grok/scripts/install_skill.py --user
python3 plugins/runir-grok/scripts/verify_hooks.py --user --skill
```

## Observability

**Grok has no Pi-style memory footer** (including Grok 0.2.x). There is no
in-chat chrome for recall/delivery. Use:

| Mode | Tool |
|------|------|
| **On-demand** | `/runir` slash skill → `scripts/runir_inspect.py` |
| **Real-time** | Second terminal pane: `python3 scripts/runir_watch.py --mode watch` |

### State files (digest-only, no secrets)

Under `~/.grok/state/runir/`:

- `trace-{sha256(sessionId)}.jsonl` — ring of last **100** events (hard cap; rewrite when over limit)
- `status-{sha256(sessionId)}.json` — latest turn phase/counts

Event kinds: `recall`, `deliver`, `skip`, `capture`, `error`. Bodies store
counts, `hash12` (contentHash prefix), durations, HTTP status, phase, and
exception **class names** only — never prompts, recalled context, headers,
credentials, or plaintext session ids.

### Inspector

```bash
python3 plugins/runir-grok/scripts/runir_inspect.py last --json
python3 plugins/runir-grok/scripts/runir_inspect.py session --latest --limit 20
python3 plugins/runir-grok/scripts/runir_inspect.py captures
python3 plugins/runir-grok/scripts/runir_inspect.py errors
python3 plugins/runir-grok/scripts/runir_inspect.py bridge
python3 plugins/runir-grok/scripts/runir_inspect.py status
```

### Watch pane

```bash
python3 plugins/runir-grok/scripts/runir_watch.py --mode once   # snapshot
python3 plugins/runir-grok/scripts/runir_watch.py --mode watch  # live tail
```

Instrumentation is **fail-open**: state write failures never change hook exit
codes or decision JSON.

## Tests

```bash
python3 -m pytest plugins/runir-grok/tests -q
```

## Non-goals

ACP wrapper, embeddings (`[memory.embedding]` unset), Stop UX A/B, host chrome /
Pi ExtensionAPI footer parity, OpenMemory views.
