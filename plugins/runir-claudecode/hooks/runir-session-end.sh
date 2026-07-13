#!/usr/bin/env bash
set -euo pipefail

# Configuration (set in your environment or ~/.claude/settings.json "env" block):
#   RUNIR_USER_ID              — your runir userId (required; hook skips silently if unset)
#   RUNIR_API_KEY              — bearer token for the configured Rúnir service. If unset,
#                                hook still runs but the server will 401 — check
#                                ~/.claude/state/runir/session-end.log for http=401.
#   RUNIR_BASE                 — service base URL (default: http://127.0.0.1:7700)
#   RUNIR_SESSION_END_URL      — full endpoint URL (default: $RUNIR_BASE/hooks/session-end)
#   RUNIR_CLIENT               — client identity tag sent to server (default: claudecode)
#   RUNIR_SESSION_END_TIMEOUT  — curl max-time in seconds (default: 60)
#   RUNIR_SPARSE_THRESHOLD     — sessions below this message count get git evidence attached (default: 10)
#   RUNIR_MAX_DIFF_CHARS       — max characters of git diff to include per session (default: 2000)
#   RUNIR_GIT_SRC_PREFIX       — git diff path prefix to filter to (default: src/)

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${HOOK_DIR}/.." && pwd)}"
LOG_FILE="${HOME}/.claude/state/runir/session-end.log"
WORKER="${HOOK_DIR}/runir-session-end-worker.sh"

# RUNIR_USER_ID must be set; skip silently if missing so hook never errors Claude Code
if [[ -z "${RUNIR_USER_ID:-}" ]]; then exit 0; fi

# One-line UTC-timestamped log append; creates the log directory on first use.
log() { mkdir -p "$(dirname "$LOG_FILE")"; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }
# Best-effort removal of every mktemp file we created, regardless of how the script exits.
cleanup() { [[ "${handoff_complete:-0}" == "1" ]] || rm -f "${tmp_input:-}"; }
# Register cleanup so it runs on any exit path (success, error, signal).
trap cleanup EXIT

# Read stdin
tmp_input=$(mktemp)
cat > "$tmp_input"

# Extract fields from stdin JSON
# Transcript path = location of the JSONL file holding this session's full message history.
transcript_path=$(python3 -c "import sys,json; d=json.load(open('$tmp_input')); print(d.get('transcript_path',''))" 2>/dev/null || echo "")
# Session ID uniquely identifies this Claude Code conversation across turns.
session_id=$(python3 -c "import sys,json; d=json.load(open('$tmp_input')); print(d.get('session_id',''))" 2>/dev/null || echo "")
# Session-end reason distinguishes prompt_input_exit/clear/logout/other exit paths.
session_end_reason=$(python3 -c "import sys,json; d=json.load(open('$tmp_input')); print(d.get('reason',''))" 2>/dev/null || echo "")

# Fallback: extract session_id from transcript_path filename
# If the event didn't include session_id, derive it from the JSONL filename (which IS the uuid).
if [[ -z "$session_id" && -n "$transcript_path" ]]; then
  session_id=$(basename "$transcript_path" .jsonl)
fi

session_log_id="${session_id:-unknown}"
session_log_reason="${session_end_reason:-unknown}"
session_run_id="se-$(date -u +%Y%m%dT%H%M%SZ)-$$"
log "start: run=${session_run_id} session=${session_log_id} reason=${session_log_reason} path=${transcript_path:-none}"

if [[ ! -x "$WORKER" ]]; then
  log "error: run=${session_run_id} session=${session_log_id} reason=${session_log_reason} stage=launch_worker missing_worker=$WORKER"
  exit 0
fi

log "handoff: run=${session_run_id} session=${session_log_id} reason=${session_log_reason} stage=launch_worker"
nohup "$WORKER" "$session_run_id" "$tmp_input" "$LOG_FILE" \
  >/dev/null 2>&1 &
disown || true
handoff_complete=1

# Parent exits immediately; background subshell handles the actual POST + state update.
exit 0
