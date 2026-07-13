#!/usr/bin/env bash
# SessionStart hook — fires once when Claude Code starts/resumes a session.
# POSTs to /hooks/recall with sessionKind="opener" to retrieve the session-opener
# payload (project state + continuity hits + next-steps summary) and injects it
# into the session's initial context via additionalContext.
#
# Configuration (set in ~/.claude/settings.json "env" block — shared with other hooks):
#   RUNIR_USER_ID        — your runir userId (required; hook skips silently if unset)
#   RUNIR_API_KEY        — bearer token for the configured Rúnir service. If unset the hook still
#                          runs but the server will 401 — check
#                          ~/.claude/state/runir/opener-debug.log for status=401.
#   RUNIR_BASE           — service base URL (default: http://127.0.0.1:7700)
#   RUNIR_OPENER_URL     — full endpoint URL (default: $RUNIR_BASE/hooks/recall)
#   RUNIR_CLIENT         — client identity tag sent to server (default: claudecode)
#   RUNIR_OPENER_TIMEOUT — curl max-time in seconds (default: 10)
#   RUNIR_DEBUG=1        — log 2xx and transport-failure (000) round-trips to the debug log.
#                          4xx/5xx always log regardless of RUNIR_DEBUG.

set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${HOOK_DIR}/.." && pwd)}"

# Shared HTTP + redaction helpers (runir_post_json, runir_redact_bearer).
source "${PLUGIN_ROOT}/hooks/lib/http.sh"

RUNIR_BASE="${RUNIR_BASE:-http://127.0.0.1:7700}"
OPENER_URL="${RUNIR_OPENER_URL:-${RUNIR_BASE}/hooks/recall}"
OPENER_CLIENT="${RUNIR_CLIENT:-claudecode}"
OPENER_TIMEOUT="${RUNIR_OPENER_TIMEOUT:-10}"
DEBUG_LOG="${HOME}/.claude/state/runir/opener-debug.log"

# Skip silently if userId not configured — hook is a no-op without identity.
[[ -z "${RUNIR_USER_ID:-}" ]] && exit 0

INPUT=$(cat)

# Extract fields from the SessionStart event JSON.
# Fields: session_id, cwd, source (startup|resume|clear|compact), transcript_path.
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null || echo "")
SOURCE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('source',''))" 2>/dev/null || echo "")

# Fallback: derive session_id from transcript_path filename (uuid.jsonl → uuid)
# Same pattern as Stage 1.5 fix in runir-recall.sh:29-31.
if [ -z "$SESSION_ID" ] && [ -n "$TRANSCRIPT_PATH" ]; then
  SESSION_ID=$(basename "$TRANSCRIPT_PATH" .jsonl)
fi

# Build request payload using python so quotes/newlines/unicode are JSON-encoded
# safely. Empty sessionId → omit the field (same as Stage 1.5 pattern).
PAYLOAD=$(python3 -c "
import sys, json
d = {
    'userId': sys.argv[1],
    'client': sys.argv[2],
    'sessionKind': 'opener',
    'prompt': '',
}
sid = sys.argv[3]
if sid:
    d['sessionId'] = sid
cwd = sys.argv[4]
if cwd:
    d['path'] = cwd
source = sys.argv[5]
if source:
    d['resumeReason'] = source
print(json.dumps(d))
" "$RUNIR_USER_ID" "$OPENER_CLIENT" "$SESSION_ID" "$CWD" "$SOURCE")

# POST via the shared helper. MUST be a direct call, not \$(runir_post_json ...)
# — command substitution would drop RUNIR_LAST_HTTP_CODE.
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
runir_post_json "$OPENER_URL" "$OPENER_TIMEOUT" "$BODY" -d "$PAYLOAD"
STATUS="${RUNIR_LAST_HTTP_CODE:-000}"

# Logging policy: 4xx/5xx always logged (so a silent server regression is visible
# without RUNIR_DEBUG). 2xx and transport failures (000) only when RUNIR_DEBUG=1.
# All bodies pipe through runir_redact_bearer so bearer tokens never hit disk.
should_log=0
case "$STATUS" in
  4*|5*) should_log=1 ;;
  *)     [ "${RUNIR_DEBUG:-0}" = "1" ] && should_log=1 ;;
esac
if [ "$should_log" = "1" ]; then
  mkdir -p "$(dirname "$DEBUG_LOG")"
  TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  REDACTED=$(runir_redact_bearer < "$BODY")
  {
    echo "--- $TS status=$STATUS session=$SESSION_ID source=$SOURCE ---"
    echo "RESPONSE: $REDACTED"
    echo ""
  } >> "$DEBUG_LOG"
fi

# Inject the session-opener payload into the session's initial context — only on 2xx.
# SessionStart requires the hookSpecificOutput.additionalContext shape (not the legacy
# top-level additionalContext shape used by UserPromptSubmit).
case "$STATUS" in
  2*)
    CONTEXT=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('prependContext') or '')" < "$BODY" 2>/dev/null || echo "")
    if [ -n "$CONTEXT" ]; then
      python3 -c "import sys,json; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': sys.argv[1]}}))" "$CONTEXT"
    fi
    ;;
esac

exit 0
