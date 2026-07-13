# Local dogfood service — `com.runir.local` (launchd)

The local Runir instance on **:7700** that we "eat our own dogfood" against is managed by a user LaunchAgent. The plist lives at `~/Library/LaunchAgents/com.runir.local.plist` (NOT in this repo); this doc is the canonical reference + reload procedure.

## The orphan-leak bug (fixed 2026-06-01, `Rúnir-x41m.8`)
The old `ProgramArguments` ran the **Volta node shim** (`~/.volta/bin/node`):
```
/bin/zsh -lc 'cd <repo> && set -a; source .env; set +a; exec /Users/brooks/.volta/bin/node --import tsx/esm index.ts'
```
The Volta shim **fork+execs** the real node, so launchd tracked the *shim* while the real server ran as its child. On `kickstart -k`, launchd killed the shim but the child got reparented to init (ppid=1) and kept squatting :7700 → an orphan accumulated on **every restart** (cleaned 20+ across sessions). A second cause: the SIGTERM handler closed the DB but never the HTTP server, so the port lingered until SIGKILL.

## The fix
1. **Plist** — make launchd own the **real node** directly (no forking shim) and load `.env` in-process:
   ```
   /bin/zsh -c 'cd <repo> && exec "$(/Users/brooks/.volta/bin/volta which node)" --import tsx/esm --import dotenv/config index.ts'
   ```
   - `exec "$(volta which node)"` → the shell replaces itself with the **real** node binary (resolved dynamically, so it survives Volta node upgrades — no hardcoded image path). launchd's tracked PID == the listener PID.
   - `--import dotenv/config` loads `.env` in-process (replaces the shell `source .env`; dotenv does NOT override the plist's pinned `EnvironmentVariables`, which is correct).
   - `-c` not `-lc` (avoid login-shell runtime drift).
   - Logs stay at `.omx/logs/runir-local-launchd.{out,err}.log` (that path is correct — it exists and is written; it is NOT a typo for `.omc`).
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
  <string>/bin/zsh</string>
  <string>-c</string>
  <string>cd /Users/brooks/Code/runir &amp;&amp; exec "$(/Users/brooks/.volta/bin/volta which node)" --import tsx/esm --import dotenv/config index.ts</string>
</array>
```
Pinned `EnvironmentVariables`: `PORT=7700`, `RUNIR_VERBATIM_CODE_SHADOW=1`, `RUNIR_EXTRACTOR_MODEL=openai/gpt-5.4-mini`, `PATH` (incl. `~/.volta/bin`). The rest of the service env comes from `.env` (loaded in-process via `dotenv/config`).
