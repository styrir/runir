# runir-grok

Native Grok lifecycle adapter for Rúnir (thin HTTP client).

## Layout

| Path | Role |
|------|------|
| `hooks/runir-grok.py` | Source of truth for UserPromptSubmit / Stop (TUI) |
| `lib/runir_core.py` | Shared auth/HTTP/envelope/identity/lock leaves (path-loaded) |
| `scripts/headless_inject.py` | Headless one-shot: recall → `--prompt-json` → grok → capture |
| `scripts/runir_ask.sh` | Thin ask.sh-compatible wrapper → `headless_inject.py` |
| `templates/user-hooks.json` | Hooks document template (`__PLUGIN_ROOT__`; UPS + Stop only) |
| `scripts/install_hooks.py` | Replace the dedicated `~/.grok/hooks/runir-grok.json` from template (UPS + Stop only; first-overwrite backup) |
| `scripts/verify_hooks.py` | Events + timeouts; errors if Rúnir PreToolUse remains; `--skill`; `--launch-agent` |
| `scripts/install_skill.py` | Deploy all `skills/*/SKILL.md` → `~/.grok/skills/<name>/` (`--skill` to narrow) |
| `scripts/install_launch_agent.py` | Deploy embed-warm LaunchAgent SoT → `~/Library/LaunchAgents/` |
| `launchd/com.runir.embed-warm.plist` | SoT for nomic embed warmer (`keep_alive:-1`, StartInterval 240) |
| `scripts/runir_inspect.py` | On-demand inspector (`last|session|captures|errors|bridge|status`) |
| `scripts/runir_watch.py` | Live second-pane tail (`--mode once|watch`) |
| `skills/runir/SKILL.md` | `/runir` slash skill (SoT; user-invocable) |
| `skills/runir-recall/SKILL.md` | Explicit recall skill (**prompt-blind / session-stale** ambient is not enough) |
| `scripts/memory_bridge.py` | Idempotent `[memory]` config + write-only **global** MEMORY.md bridge |
| `tests/` | Unit/integration + isolated-`GROK_HOME` canaries |

## Lifecycle (TUI floor — honest)

| Turn | What happens |
|------|----------------|
| **Session turn 1 (UPS)** | Snapshot managed-block ids → `native-{digest}.json` **baseline** → **prompt-only** turn state (no TUI `/hooks/recall` HTTP) → **synchronous** `memory_bridge.sync_once()` into global `MEMORY.md` (bounded by `RUNIR_SYNC_FIRST_TURN_TIMEOUT_S`) |
| **Later UPS turns** | Prompt-only state write + throttled detached bridge sync |
| **Stop (`end_turn`)** | **Capture-only** — posts turn messages (+ optional identity if present). No `additionalContext`, no `decision:block` memory transport |
| **PreToolUse** | **Retired.** Deny-for-memory transport removed. Stale installed PreToolUse entries are inert (no deny JSON). `install_hooks` + `verify_hooks` prune/error on Rúnir PreToolUse |

### Labels (read carefully)

- **Ambient MEMORY.md (bridge)** — **prompt-blind / session-stale**: the host may or may not re-read global `MEMORY.md` mid-session. Managed-block facts published this session are only assumed visible from the **next** session unless the host reloads memory.
- **Explicit `runir-recall` skill** — same limits for ambient; use when you need on-demand search/get/lineage against the Rúnir server.
- **Headless inject** — separate path: real `/hooks/recall` + `RECALL_FEEDBACK_PREFIX` envelope into `grok --prompt-json` (pre-inference). Not the TUI.

### Retired transports (do not reintroduce)

- PreToolUse `decision:deny` carrying recalled memory
- Stop `hookSpecificOutput.additionalContext` / `decision:block` carrying recalled memory
- TUI UPS HTTP `/hooks/recall` that claimed the model saw content never delivered pre-inference

## Hardening (retained)

- **D1** — Stale capture bail: pending markers older than `RUNIR_CAPTURE_STALE_S` (5s) are marked `stale` and UPS continues.
- **flock** — advisory locks on turn state / bridge RMW (local FS only).
- **Bridge** — Global-only projection into `<!-- runir-bridge:begin/end -->`. Fetch failure **preserves** the prior managed block (never wipe). Full read-modify-write under advisory lock with pre-image stat re-check (max 3 attempts → `preserved`). `lastSyncAt` advances **only after successful sync**; the hook holds a short in-flight lease (`RUNIR_SYNC_LEASE_S`) instead of burning the throttle window on failed spawn. Advisory lock does not bind Grok's own writer — best-effort only.

## Install (machine-local)

```bash
python3 plugins/runir-grok/scripts/install_hooks.py --user --dry-run
python3 plugins/runir-grok/scripts/install_hooks.py --user
python3 plugins/runir-grok/scripts/verify_hooks.py --user
python3 plugins/runir-grok/scripts/memory_bridge.py --write-config
python3 plugins/runir-grok/scripts/memory_bridge.py --sync --canary
```

Requires `RUNIR_USER_ID` (and optional `RUNIR_API_KEY` / `RUNIR_BASE`) for live capture / bridge / headless.

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

### State files (owner-only; latest turn prompt retained)

Under `$GROK_HOME/state/runir/` (default `~/.grok/state/runir/`). Files are
written mode `0600`, but `recall-*.json` contains the latest original prompt
for its session and has no automatic TTL; remove stale state files according to
your local retention policy.

- `trace-{sha256(sessionId)}.jsonl` — ring of last **100** events (hard cap; rewrite when over limit)
- `status-{sha256(sessionId)}.json` — latest turn phase/counts
- `recall-{digest}.json` — turn prompt (+ optional identity for capture)
- `native-{digest}.json` — session baseline managed ids + first-turn publish status
- `bridge-sync.json` — throttle / lease / `lastStatus` (schema v2)

Event kinds: `skip`, `capture`, `error`, plus bridge-related `recall`/`skip` for native publish. Trace/status bodies store counts, durations, HTTP status, phase, and exception **class names** only — never prompts, recalled context, headers, credentials, or plaintext session ids. The original prompt lives only in `recall-*.json`.

Instrumentation is **fail-open**: state write failures never change hook exit codes.

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

## Headless inject (programmatic one-shots)

TUI cannot inject memory pre-inference. For ask.sh-style / batch callers that need
**pre-inference** memory, use the headless path:

```bash
# Direct
python3 plugins/runir-grok/scripts/headless_inject.py \
  --prompt "What did we decide about the API?" --json

# ask.sh-compatible thin wrapper (opt-in; ask.sh itself is untouched)
plugins/runir-grok/scripts/runir_ask.sh "What did we decide about the API?" --json
```

Flow:

1. Resolve the **real Grok session UUID**: pre-generate one UUID for a fresh
   turn, or use the existing `--resume` UUID for a resumed turn. Use that same
   UUID for recall and capture.
2. `POST /hooks/recall` → `prependContext` + `retrievalTraceId` + `memoryIds`
   (fail-open empty inject on error).
3. Build `grok --prompt-json` content blocks: **memory text first** (with
   `RECALL_FEEDBACK_PREFIX` untrusted envelope), **user prompt second**. Never
   sets `systemPromptOverride`.
4. Spawns `grok --prompt-json … --output-format json`: fresh turns pass the
   pre-generated UUID with `--session-id`; resume turns pass only `--resume`.
   `RUNIR_GROK_DISABLE_GATE=1` makes installed TUI hooks no-op for this child
   (including first-turn native publish). Credentials (`RUNIR_API_KEY`,
   `RUNIR_ENV_FILE`) are stripped from the child env.
5. Parses Grok `sessionId` + `modelUsage.*.modelCalls`, then requires Grok's
   returned `sessionId` to exactly match the UUID used for recall. A missing or
   mismatched ID fails closed before capture. Expect `modelCalls == 1` when no
   gate re-burn or tool loop occurs under `--max-turns 1`.
6. `POST /hooks/capture` with the **original** user text + assistant reply,
   plus the verified real Grok `sessionId`, `retrievalTraceId`, and `memoryIds`.
   The headless client requests an opt-in capture receipt; Rúnir validates those
   fields against the owner-scoped retrieval trace and persists the exact prompt
   and answer on that trace for `GET /hooks/traces/:id` readback. This is capture
   evidence, not usefulness feedback. Skipped under `--no-capture`; capture failure
   remains non-fatal to the returned model answer.

### Flags

| Flag | Meaning |
|------|---------|
| `--prompt TEXT` / `--prompt-file PATH` | User prompt (required, exclusive) |
| `--resume SESSION` | Resume the existing Grok session UUID; also use it for recall+capture (no `-s` is passed) |
| `--path CWD` | Workspace for recall/capture/`--cwd` |
| `--yolo` | Maps to grok `--always-approve`. **High risk with recalled text:** poisoned or misleading memory can influence automatically approved filesystem/network tools; avoid unless the prompt, memories, and workspace are trusted. |
| `--no-capture` | Skip post-turn capture |
| `--timeout SECONDS` | Subprocess timeout |
| `--json` | Print structured result (see keys below) |
| `--max-turns N` | Pass `--max-turns` to grok (canary uses `1` to pin `modelCalls`) |
| `--no-memory` | Pass `--no-memory` to grok (disable native cross-session memory) |
| `--disable-web-search` | Pass `--disable-web-search` to grok |

### `--json` keys

| Key | Meaning |
|-----|---------|
| `sessionId` | Verified real Grok session UUID, shared by recall + Grok + capture and usable with `--resume` |
| `modelCalls` | Summed model calls (expect `1` for single-turn inject) |
| `text` | Assistant text |
| `memoryInjected` | Whether recall returned non-empty context |
| `retrievalTraceId` | Trace id from recall (empty when none) |
| `memoryIds` | Selected memory ids from recall (list; may be empty) |
| `stopReason` | Grok stop reason if present |

Exit codes: `0` ok · `2` usage/missing `RUNIR_USER_ID` · `3` spawn/nonzero · `4` unparseable stdout or session identity mismatch.

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
# The live canary hard-requires fresh + resumed receipt readback for the exact
# sessionId, retrievalTraceId, memoryIds, original prompt, and final answer.
```

## Non-goals

ACP multi-turn wrapper (deferred), embeddings (`[memory.embedding]` unset),
restoring PreToolUse deny / Stop additionalContext memory buses, host chrome /
Pi ExtensionAPI footer parity, OpenMemory views, edits to external `ask.sh`,
`systemPromptOverride` for per-turn memory, **workspace `MEMORY.md` writes**,
product-name hardcodes, Leit/Dolt schema changes. UPS host `additionalContext`
channel request is tracked separately (Rúnir-12v). Headless T1/T2 proof is
Rúnir-4e8.
