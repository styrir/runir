# runir-grok

Native Grok lifecycle adapter for Rúnir (thin HTTP client).

## Layout

| Path | Role |
|------|------|
| `hooks/runir-grok.py` | Source of truth for UserPromptSubmit / PreToolUse / Stop |
| `lib/runir_core.py` | Shared auth/HTTP/envelope/identity/lock leaves (path-loaded) |
| `scripts/headless_inject.py` | Headless one-shot: recall → `--prompt-json` → grok → capture |
| `scripts/runir_ask.sh` | Thin ask.sh-compatible wrapper → `headless_inject.py` |
| `templates/user-hooks.json` | Hooks document template (`__PLUGIN_ROOT__`, PreToolUse matcher `.*`) |
| `scripts/install_hooks.py` | Deploy template → `~/.grok/hooks/runir-grok.json` |
| `scripts/verify_hooks.py` | Matcher-equals-template + representative matches; timeouts; `--skill`; `--launch-agent` |
| `scripts/install_skill.py` | Deploy all `skills/*/SKILL.md` → `~/.grok/skills/<name>/` (`--skill` to narrow) |
| `scripts/install_launch_agent.py` | Deploy embed-warm LaunchAgent SoT → `~/Library/LaunchAgents/` |
| `launchd/com.runir.embed-warm.plist` | SoT for nomic embed warmer (`keep_alive:-1`, StartInterval 240) |
| `scripts/runir_inspect.py` | On-demand inspector (`last|session|captures|errors|bridge|status`) |
| `scripts/runir_watch.py` | Live second-pane tail (`--mode once|watch`) |
| `skills/runir/SKILL.md` | `/runir` slash skill (SoT; user-invocable) |
| `skills/runir-recall/SKILL.md` | Model-invocable recall skill (search/get/lineage/traces rate/store) |
| `scripts/memory_bridge.py` | Idempotent `[memory]` config + write-only **global** MEMORY.md bridge |
| `tests/` | Unit/integration + isolated-`GROK_HOME` canaries (D1–D4 + P + identity/native/bridge) |

## Lifecycle (hybrid native + correction)

| Turn | What happens |
|------|----------------|
| **Session turn 1 (UPS)** | Snapshot managed-block ids → `native-{digest}.json` **baseline** → live Rúnir recall → write recall-state v2 (prompt, `selectionId`, `memoryIds`, `retrievalTraceId`) → **synchronous** `memory_bridge.sync_once()` into global `MEMORY.md` (bounded by `RUNIR_SYNC_FIRST_TURN_TIMEOUT_S`) → gate armed unless selection ⊆ baseline |
| **Later tool turns** | PreToolUse matcher `.*` (includes qualified MCP names) may deny once with untrusted envelope; D3 selection dedupe + native baseline suppress bound re-burn |
| **Later no-tool turns** | Stop emits `hookSpecificOutput.additionalContext` (default) rather than error-style `decision:block` (escape hatch: `RUNIR_GROK_STOP_MODE=block`) |
| **Capture** | Posts original state prompt when present, plus `retrievalTraceId` / `memoryIds` when non-empty |

**Honest caveat — mid-session MEMORY.md re-read:** Whether Grok re-reads the global `MEMORY.md` mid-session is **not verified**. Suppression therefore keys on the managed-block contents **as of session start** (`baselineIds`), so newly published facts are only assumed visible from the **next** session. Set `RUNIR_GROK_NATIVE_SUPPRESS=0` to disable suppression entirely (correction gate always armed when context is present).

**Honest caveat — Stop additionalContext:** Host support for `hookSpecificOutput.additionalContext` on Stop is **unverified**. If ignored, memory is silently dropped on the Stop channel. Use `RUNIR_GROK_STOP_MODE=block` for the legacy deny/block shape; deliver trace events record `mode=…`.

## Hardening

- **D1** — Stale capture bail: pending markers older than `RUNIR_CAPTURE_STALE_S` (5s) are marked `stale` and UPS continues.
- **D2** — `fcntl.flock` on recall consume / write / dedupe / bridge RMW (local state + MEMORY lock files).
- **D3** — Selection-identity dedupe (`selectionId` = sha256 of sorted unique memory ids; falls back to `sha256(context)` when ids empty). TTL 3600s, max 32. Legacy content-hash entries simply miss — at most one extra delivery.
- **D4** — PreToolUse matcher is `.*` (template is SoT) so MCP `server__tool` / `mcp__server__tool` first-tools are covered. Re-burn bounded by selection dedupe + native baseline suppress. `verify_hooks` checks matcher **equals template** and matches a representative set including MCP names.
- **P** — Batch sibling re-deny within `RUNIR_BATCH_SIBLING_S` (2s) so multi-tool drafts all see the same correction once.
- **Bridge** — Global-only projection into `<!-- runir-bridge:begin/end -->`. Fetch failure **preserves** the prior managed block (never wipe). Full read-modify-write under advisory lock with pre-image stat re-check (max 3 attempts → `preserved`). `lastSyncAt` advances **only after successful sync**; the hook holds a short in-flight lease (`RUNIR_SYNC_LEASE_S`) instead of burning the throttle window on failed spawn. Advisory lock does not bind Grok's own writer — best-effort only.

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

Embed-warm LaunchAgent (sibling installer; keeps nomic-embed-text resident via
ollama `keep_alive:-1`, interval 240s):

```bash
python3 plugins/runir-grok/scripts/install_launch_agent.py --user --dry-run
python3 plugins/runir-grok/scripts/install_launch_agent.py --user
python3 plugins/runir-grok/scripts/verify_hooks.py --launch-agent
# With ollama running: also assert nomic is resident with far-future expiry
python3 plugins/runir-grok/scripts/verify_hooks.py --launch-agent --live
```

Install is idempotent (content compare + `.bak` on first overwrite). Pass
`--no-load` to skip `launchctl` (tests/offline). Uninstall:

```bash
python3 plugins/runir-grok/scripts/install_launch_agent.py --user --uninstall
```

## Observability

**Grok has no Pi-style memory footer** (including Grok 0.2.x). There is no
in-chat chrome for recall/delivery. Use:

| Mode | Tool |
|------|------|
| **On-demand** | `/runir` slash skill → `scripts/runir_inspect.py` |
| **Real-time** | Second terminal pane: `python3 scripts/runir_watch.py --mode watch` |

### State files (digest-only, no secrets)

Under `$GROK_HOME/state/runir/` (default `~/.grok/state/runir/`):

- `trace-{sha256(sessionId)}.jsonl` — ring of last **100** events (hard cap; rewrite when over limit)
- `status-{sha256(sessionId)}.json` — latest turn phase/counts
- `recall-{digest}.json` — undelivered/delivered context for the turn (**includes original prompt** + rendered context + identity fields)
- `native-{digest}.json` — session baseline managed ids + first-turn publish status
- `bridge-sync.json` — throttle / lease / `lastStatus` (schema v2)
- `dedupe-{digest}.json` — recent selection ids

Event kinds: `recall`, `deliver`, `skip`, `capture`, `error`. Trace/status bodies store
counts, `hash12` (contentHash prefix), `selection12`, opaque `retrievalTraceId`,
durations, HTTP status, phase, and exception **class names** only — never prompts,
recalled context, headers, credentials, or plaintext session ids. The original
prompt lives only in `recall-*.json` (already held recalled context).

**Deliver `promptId` self-attribution:** Grok PreToolUse/Stop payloads often
omit `promptId`, which used to bucket delivers under `promptId=_none` in
`/runir session`. The adapter now prefers any event `promptId`, else reads
the turn's `promptId` from the recall-state file (hash-verified against the
delivered `contentHash` when present; fail-open to no promptId if state is
missing/corrupt/mismatched). `contentHash` remains `sha256(context)` and is
**not** repointed at `selectionId`.

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
   `RUNIR_GROK_DISABLE_GATE=1` so installed TUI hooks no-op for this child
   (including first-turn native publish).
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
| `GROK_HOME` | Grok host root (default `~/.grok`); state + global memory paths derive from this at call time |
| `RUNIR_USER_ID` | Required (process env or `RUNIR_ENV_FILE`) |
| `RUNIR_API_KEY` | Optional bearer for Rúnir HTTP (parent process only; stripped from headless grok child env) |
| `RUNIR_BASE` / `RUNIR_RECALL_URL` / `RUNIR_CAPTURE_URL` | Endpoints (loopback http(s) by default; non-loopback requires HTTPS + `RUNIR_ALLOW_REMOTE_ENDPOINTS=1`) |
| `RUNIR_ENV_FILE` | dotenv fallback for credentials (stripped from headless grok child env) |
| `RUNIR_ALLOW_REMOTE_ENDPOINTS=1` | Opt-in: allow non-loopback HTTPS recall/capture URLs |
| `RUNIR_GROK_DISABLE_GATE=1` | Full no-op of hook `main()` (all events, including first-turn publish). Set automatically on the headless child; also usable for manual suppression. Exact `"1"` only. |
| `RUNIR_GROK_NATIVE_SUPPRESS` | Default on; set to `0` to never suppress the correction gate against session baseline |
| `RUNIR_GROK_STOP_MODE` | `additional_context` (default) or `block` |
| `RUNIR_SYNC_MIN_S` | Min seconds between successful bridge syncs (default 300); first session prompt always eligible after lease |
| `RUNIR_SYNC_LEASE_S` | In-flight lease after hook claims a later-turn sync (default 60) |
| `RUNIR_SYNC_FIRST_TURN_TIMEOUT_S` | Bound for synchronous first-turn `sync_once` (default 8; UPS timeout is 45s) |
| `RUNIR_E2E=1` | Opt-in live canary `tests/test_e2e_headless_live.py` |

## Tests

```bash
pytest plugins/runir-grok/tests -q
# Isolated GROK_HOME canaries (no real ~/.grok writes) are included above.
# Live canary (needs running Rúnir + grok + credentials):
RUNIR_E2E=1 pytest plugins/runir-grok/tests/test_e2e_headless_live.py -q
```

## Non-goals

ACP multi-turn wrapper (deferred), embeddings (`[memory.embedding]` unset), Stop UX A/B beyond the documented mode switch,
host chrome / Pi ExtensionAPI footer parity, OpenMemory views, edits to external
`ask.sh`, `systemPromptOverride` for per-turn memory, **workspace `MEMORY.md` writes**,
product-name hardcodes, Leit/Dolt schema changes.
