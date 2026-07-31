# runir-grok

Native Grok lifecycle adapter for Rúnir (thin HTTP client).

## Layout

| Path | Role |
|------|------|
| `hooks/runir-grok.py` | Source of truth for UserPromptSubmit / PreToolUse / Stop |
| `lib/runir_core.py` | Shared auth/HTTP/envelope/recall+capture leaves (path-loaded) |
| `scripts/headless_inject.py` | Headless one-shot: recall → `--prompt-json` → grok → capture |
| `scripts/runir_ask.sh` | Thin ask.sh-compatible wrapper → `headless_inject.py` |
| `templates/user-hooks.json` | Hooks document template (`__PLUGIN_ROOT__`, narrowed PreToolUse matcher) |
| `scripts/install_hooks.py` | Deploy template → `~/.grok/hooks/runir-grok.json` |
| `scripts/verify_hooks.py` | Assert matcher ≠ `.*`, command path, timeout floors; `--skill` for /runir |
| `scripts/install_skill.py` | Deploy `skills/runir/SKILL.md` → `~/.grok/skills/runir/` |
| `scripts/runir_inspect.py` | On-demand inspector (`last|session|captures|errors|bridge|status`) |
| `scripts/runir_watch.py` | Live second-pane tail (`--mode once|watch`) |
| `skills/runir/SKILL.md` | `/runir` slash skill (SoT; user-invocable) |
| `scripts/memory_bridge.py` | Idempotent `[memory]` config + write-only MEMORY.md bridge |
| `tests/` | Unit tests for D1–D4 + P (+ fail-open + observability + headless) |

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

## Headless inject (programmatic one-shots)

TUI hooks use a correction gate (deny + re-prompt) that can burn an extra model
round. For ask.sh-style / batch callers that need **pre-inference** memory without
that re-burn, use the headless path:

```bash
# Direct
python3 plugins/runir-grok/scripts/headless_inject.py \
  --prompt "What did we decide about the API?" --json --yolo

# ask.sh-compatible thin wrapper (opt-in; ask.sh itself is untouched)
plugins/runir-grok/scripts/runir_ask.sh "What did we decide about the API?" --json --yolo
```

Flow:

1. `POST /hooks/recall` → `prependContext` (fail-open empty inject on error)
2. Build `grok --prompt-json` content blocks: **memory text first** (with
   `RECALL_FEEDBACK_PREFIX` untrusted envelope), **user prompt second**. Never
   sets `systemPromptOverride`.
3. Spawns `grok --prompt-json … --output-format json` with
   `RUNIR_GROK_DISABLE_GATE=1` so installed TUI hooks no-op for this child.
4. Parses `sessionId` + `modelUsage.*.modelCalls` (expect `1` when no gate re-burn).
5. `POST /hooks/capture` with the **original** user text + assistant reply
   (skipped under `--no-capture`; capture failure is non-fatal).

### Flags

| Flag | Meaning |
|------|---------|
| `--prompt TEXT` / `--prompt-file PATH` | User prompt (required, exclusive) |
| `--resume SESSION` | Pass through to `grok --resume` |
| `--path CWD` | Workspace for recall/capture/`--cwd` |
| `--yolo` | Maps to grok `--always-approve` |
| `--no-capture` | Skip post-turn capture |
| `--timeout SECONDS` | Subprocess timeout |
| `--json` | Print `{sessionId,modelCalls,text,memoryInjected,…}` |

Exit codes: `0` ok · `2` usage/missing `RUNIR_USER_ID` · `3` spawn/nonzero · `4` unparseable stdout.

### Privacy note (`--prompt-json` argv)

Verified `grok --help`: `--prompt-json` takes **inline JSON content blocks**, not a
file path. The script still writes a mode-`0600` tempfile as intermediate storage,
but the JSON string is passed on argv (visible to local `ps` for the process
lifetime). Do not use this path for highly sensitive prompts on multi-user hosts
until the CLI gains a path/`@file` form.

### Env

| Variable | Role |
|----------|------|
| `RUNIR_USER_ID` | Required (process env or `RUNIR_ENV_FILE`) |
| `RUNIR_API_KEY` | Optional bearer for Rúnir HTTP (parent process only; stripped from headless grok child env) |
| `RUNIR_BASE` / `RUNIR_RECALL_URL` / `RUNIR_CAPTURE_URL` | Endpoints (loopback http(s) by default; non-loopback requires HTTPS + `RUNIR_ALLOW_REMOTE_ENDPOINTS=1`) |
| `RUNIR_ENV_FILE` | dotenv fallback for credentials (stripped from headless grok child env) |
| `RUNIR_ALLOW_REMOTE_ENDPOINTS=1` | Opt-in: allow non-loopback HTTPS recall/capture URLs |
| `RUNIR_GROK_DISABLE_GATE=1` | Full no-op of hook `main()` (all events). Set automatically on the headless child; also usable for manual suppression. Exact `"1"` only. |
| `RUNIR_E2E=1` | Opt-in live canary `tests/test_e2e_headless_live.py` |

## Tests

```bash
pytest plugins/runir-grok/tests -q
# Live canary (needs running Rúnir + grok + credentials):
RUNIR_E2E=1 pytest plugins/runir-grok/tests/test_e2e_headless_live.py -q
```

## Non-goals

ACP multi-turn wrapper (deferred), embeddings (`[memory.embedding]` unset), Stop UX A/B,
host chrome / Pi ExtensionAPI footer parity, OpenMemory views, edits to external
`ask.sh`, `systemPromptOverride` for per-turn memory.
