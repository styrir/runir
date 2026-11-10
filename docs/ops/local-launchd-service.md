# Local dogfood service — `com.runir.local` (launchd)

The local Runir instance on **:7700** that we "eat our own dogfood" against is managed by a user LaunchAgent. The plist lives at `~/Library/LaunchAgents/com.runir.local.plist` (NOT in this repo); this doc is the canonical reference + reload procedure.

## The orphan-leak bug (fixed 2026-06-01, `Rúnir-x41m.8`)
The old `ProgramArguments` ran the **Volta node shim** (`~/.volta/bin/node`):
```
/bin/zsh -lc 'cd <repo> && set -a; source .env; set +a; exec <home>/.volta/bin/node --import tsx/esm index.ts'
```
The Volta shim **fork+execs** the real node, so launchd tracked the *shim* while the real server ran as its child. On `kickstart -k`, launchd killed the shim but the child got reparented to init (ppid=1) and kept squatting :7700 → an orphan accumulated on **every restart** (cleaned 20+ across sessions). A second cause: the SIGTERM handler closed the DB but never the HTTP server, so the port lingered until SIGKILL.

## The fix
1. **Plist + wrapper** — launchd executes the machine-local
   `~/Library/Application Support/runir/runir-launchd-wrapper.sh`. The installed
   source is `scripts/runir-launchd-wrapper.sh`; the rollout status below records
   its actual launchd qualification. The wrapper obtains credentials independently,
   exports the provider key and source HMAC, and `exec`s the real Node binary with
   `--import dotenv/config`.
   - launchd's tracked PID remains the listener PID;
   - the current provider/model profile is pinned in the wrapper; other settings
     come from `RUNIR_ENV_FILE` (default `$RUNIR_ROOT/.env`), explicitly exported as
     `DOTENV_CONFIG_PATH`;
   - credentials come from Infisical and are never written to disk;
   - logs go to
     `~/Library/Application Support/runir/logs/runir-local-launchd.{out,err}.log`.
2. **Graceful shutdown** (`src/app/shutdown.ts` + `registerShutdownHandlers`) — on SIGTERM/SIGINT: stop consolidation → `server.close()` → `await db.close()` → `exit(0)`, with a force-exit backstop. Releases :7700 promptly so launchd restarts cleanly instead of waiting for SIGKILL.

## Safe reload procedure (after editing the plist)
Do NOT use `kickstart -k` for the *transition off the old broken plist* — it can orphan the child. Use:
```
uid=$(id -u)
launchctl bootout gui/$uid/com.runir.local            # stop current job
lsof -ti tcp:7700 | xargs -r kill -9                   # kill any lingering listener (the orphan)
plutil -lint ~/Library/LaunchAgents/com.runir.local.plist
launchctl bootstrap gui/$uid ~/Library/LaunchAgents/com.runir.local.plist
curl -s --retry 25 --retry-delay 1 --retry-all-errors http://localhost:7700/health
# verify: launchd tracked pid == the :7700 listener pid (no shim in between)
```
Once the fixed plist is installed, ordinary restarts are just `launchctl kickstart -k gui/$uid/com.runir.local` (now clean — no orphan).

## Canonical ProgramArguments
```xml
<key>ProgramArguments</key>
<array>
  <string><home>/Library/Application Support/runir/runir-launchd-wrapper.sh</string>
</array>
```

Pinned plist `EnvironmentVariables`: `PATH`, `PORT`, `RUNIR_ROOT`,
`RUNIR_RECALL_RELEVANCE_FLOOR`, `RUNIR_SUPERSEDE_SHADOW`, and
`RUNIR_VERBATIM_CODE_SHADOW`. The rest of the non-secret service environment
comes from `.env`.

## Source installation and rollout gates

The tracked wrapper is the installed and live-qualified source for vk-2684.
The first attempt was restored after credential warnings; actual launchd
requalification and the later NanoGPT rollout passed. See Verk for current
evidence and acceptance status. Do not install it until the
vk-2683 receipt establishes retryable capture failure without completing source
turns or advancing client watermarks. Run the offline fake-process check first:

```sh
python3 scripts/test-runir-launchd-wrapper.py
```

After that prerequisite, scoped provider review, clean plist-environment
credential qualification, and representative background-lane checks, install
from the reviewed checkout:

```sh
install -m 755 scripts/runir-launchd-wrapper.sh \
  "$HOME/Library/Application Support/runir/runir-launchd-wrapper.sh"
```

Installation does not reload the service. Use the reload procedure above and
verify launchd's tracked PID equals the listener PID, readiness, the existing
source-key fingerprint, and an actual installed-hook capture/recall/Think chain.
The synthetic capture/Think probes do not qualify background lanes or automatic
host delivery. Preserve the existing `.env` and its backup.

The native `/opt/homebrew/bin/python3 -I` helper bounds each credential command
with `subprocess.run(timeout=20)`, preserving stdout and numeric exit status
(124 timeout, 127 missing command, 126 other execution failure). It kills and
reaps the direct child only; descendants are outside this timeout ceiling.
Missing Python never falls back to an unbounded command. Multiple acquisitions
can consume multiple 20-second deadlines.

## Owner-local model routing

The wrapper pins the current NanoGPT profile:

```dotenv
RUNIR_LLM_BASE_URL=https://api.nano-gpt.com/api/v1
EXTRACT_MODEL=openai/gpt-5.4-mini
RUNIR_EXTRACTOR_MODEL=openai/gpt-5.4-mini
RUNIR_ENTITY_MODEL=openai/gpt-5.4-mini
RUNIR_SEGMENT_MODEL=openai/gpt-5.4-mini
RUNIR_CONTINUITY_MODEL=openai/gpt-5.4-mini
RUNIR_THINK_MODEL=openai/gpt-5.6-luna
RUNIR_STALENESS_MODEL=openai/gpt-5.4-mini
RUNIR_SUPERSEDE_JUDGE_MODEL=openai/gpt-5.4-mini
ENRICH_MODEL=openai/gpt-5.4-mini
SYNTHESIS_MODEL=openai/gpt-5.4-mini
RERANKER_PROVIDER=local
```

NanoGPT secret `nanogpt` comes from the existing native Infisical CLI's cached
operator authentication: styrir project
`402716ac-2805-4864-b3ce-e11b838f78b3`, `prod`, `/providers`. This fetch receives
neither an inherited `INFISICAL_TOKEN` nor a `--token` machine credential.

Source HMAC acquisition retains the existing runir Universal Auth identity:
Keychain services `runir.infisical.client-id` and `runir.infisical.client-secret`,
project `2588c473-4c4c-4b5a-b0f5-e261184b6b53`, `dev`, `/`,
secret `RUNIR_SOURCE_HMAC_KEY`. Existing `RUNIR_INFISICAL_CLIENT_ID`,
`RUNIR_INFISICAL_CLIENT_SECRET`, and corresponding `_SERVICE` overrides remain
supported. Never rotate this HMAC or grant that identity access to other projects.
Temporary authentication values are not exported to Node.

Both exported keys start empty; failed acquisition cannot fall back to stale
dotenv credentials. Dotenv override is disabled. Credential errors emit only
static warnings and still launch the service for reads. Missing HMAC keeps source
writes closed; missing provider credentials require vk-2683's retryable capture
behavior. Either acquisition can succeed independently of the other.

`EXTRACT_MODEL` is capture-only. This provider migration also pins the shared
fallback, topic segmentation, entity extraction and continuity explicitly to
`openai/gpt-5.4-mini`, preventing stale provider-specific dotenv overrides. The
independent Think pin selects GPT-5.6 Luna for `/memory/think`; its request does
not include a reasoning-effort parameter.

Do not use `RUNIR_EXTRACTOR_MODEL` for a capture-only promotion. It is a legacy
shared fallback and also feeds topic segmentation, entity extraction,
continuity, and `/memory/think`.
