# Local dogfood service — `com.runir.local` (launchd)

The local Runir instance on **:7700** that we "eat our own dogfood" against is managed by a user LaunchAgent. The plist lives at `~/Library/LaunchAgents/com.runir.local.plist` (NOT in this repo); this doc is the canonical reference + reload procedure.

## The orphan-leak bug (fixed 2026-06-01, `Rúnir-x41m.8`)
The old `ProgramArguments` ran the **Volta node shim** (`~/.volta/bin/node`):
```
/bin/zsh -lc 'cd <repo> && set -a; source .env; set +a; exec /Users/brooks/.volta/bin/node --import tsx/esm index.ts'
```
The Volta shim **fork+execs** the real node, so launchd tracked the *shim* while the real server ran as its child. On `kickstart -k`, launchd killed the shim but the child got reparented to init (ppid=1) and kept squatting :7700 → an orphan accumulated on **every restart** (cleaned 20+ across sessions). A second cause: the SIGTERM handler closed the DB but never the HTTP server, so the port lingered until SIGKILL.

## The fix
1. **Plist + wrapper** — launchd executes the machine-local
   `~/Library/Application Support/runir/runir-launchd-wrapper.sh`. The wrapper
   obtains the Requesty bearer with Infisical Universal Auth, exports it only to
   the service process, and `exec`s the real Node binary with
   `--import dotenv/config`.
   - launchd's tracked PID remains the listener PID;
   - model IDs and other non-secret settings come from `.env`;
   - the gateway credential comes from Infisical, not a committed or manually
     supplied API key;
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
  <string>/Users/brooks/Library/Application Support/runir/runir-launchd-wrapper.sh</string>
</array>
```

Pinned plist `EnvironmentVariables`: `PATH`, `PORT`, `RUNIR_ROOT`,
`RUNIR_RECALL_RELEVANCE_FLOOR`, `RUNIR_SUPERSEDE_SHADOW`, and
`RUNIR_VERBATIM_CODE_SHADOW`. The rest of the non-secret service environment
comes from `.env`.

## Owner-local model routing

Capture extraction mirrors the accepted benchmark profile:

```dotenv
RUNIR_LLM_BASE_URL=https://router.requesty.ai/v1
EXTRACT_MODEL=vertex/gemini-3.1-flash-lite@us
RUNIR_THINK_MODEL=openai/gpt-5.4-mini
```

The Requesty credential is injected by the launch wrapper from Infisical
Universal Auth; it is not supplied in this configuration block.
`EXTRACT_MODEL` is capture-only. Topic segmentation, entity extraction, and
continuity keep their existing `openai/gpt-5.4-mini` code defaults, while the
explicit think pin preserves the prior owner-local `/memory/think` behavior.

Do not use `RUNIR_EXTRACTOR_MODEL` for a capture-only promotion. It is a legacy
shared fallback and also feeds topic segmentation, entity extraction,
continuity, and `/memory/think`.
