#!/bin/bash
# UserPromptSubmit hook — recalls relevant memories from runir before each turn
#
# Configuration (set in your environment or ~/.claude/settings.json "env" block):
#   RUNIR_USER_ID        — your runir userId (required; hook skips silently if unset)
#   RUNIR_API_KEY        — bearer token for the configured Rúnir service. If unset
#                          the hook still runs but the server will 401 — check
#                          ~/.claude/state/runir/recall-debug.log for status=401 to diagnose.
#   RUNIR_BASE           — service base URL (default: http://127.0.0.1:7700)
#   RUNIR_RECALL_URL     — full endpoint URL (default: $RUNIR_BASE/hooks/recall)
#   RUNIR_CLIENT         — client identity tag sent to server (default: claudecode)
#   RUNIR_RECALL_TIMEOUT — curl max-time in seconds (default: 20)
#   RUNIR_DEBUG=1        — log 2xx and transport-failure (000) round-trips to the debug log.
#                          4xx/5xx always log regardless of RUNIR_DEBUG.

RUNIR_BASE="${RUNIR_BASE:-http://127.0.0.1:7700}"
RECALL_URL="${RUNIR_RECALL_URL:-${RUNIR_BASE}/hooks/recall}"
RECALL_CLIENT="${RUNIR_CLIENT:-claudecode}"
RECALL_TIMEOUT="${RUNIR_RECALL_TIMEOUT:-20}"
DEBUG_LOG="$HOME/.claude/state/runir/recall-debug.log"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${HOOK_DIR}/.." && pwd)}"

# Shared HTTP + redaction helpers (runir_post_json, runir_redact_bearer).
source "${PLUGIN_ROOT}/hooks/lib/http.sh"

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('prompt',''))" 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null)
CWD=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)
# Fallback: derive session_id from transcript_path filename (uuid.jsonl → uuid)
if [ -z "$SESSION_ID" ] && [ -n "$TRANSCRIPT_PATH" ]; then
  SESSION_ID=$(basename "$TRANSCRIPT_PATH" .jsonl)
fi
if [ -z "$PROMPT" ]; then exit 0; fi
if [ -z "${RUNIR_USER_ID:-}" ]; then exit 0; fi

# Build request payload using python so quotes/newlines/unicode in the prompt
# and cwd are JSON-encoded safely (bash string splicing can't do this).
PROMPT_JSON=$(python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" <<< "$PROMPT")
CWD_JSON=$(python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" <<< "${CWD:-${PWD:-}}")
SESSION_ID_JSON=$(python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" <<< "${SESSION_ID:-}")
PAYLOAD=$(python3 -c "
import sys, json
d = {'prompt': json.loads(sys.argv[1]), 'userId': sys.argv[3], 'client': sys.argv[4]}
cwd = json.loads(sys.argv[2])
if cwd:
    d['path'] = cwd
sid = json.loads(sys.argv[5])
if sid:
    d['sessionId'] = sid
print(json.dumps(d))
" "$PROMPT_JSON" "$CWD_JSON" "$RUNIR_USER_ID" "$RECALL_CLIENT" "$SESSION_ID_JSON")

# POST via the shared helper. MUST be a direct call, not `RESULT=$(runir_post_json ...)`
# — command substitution would drop RUNIR_LAST_HTTP_CODE.
BODY=$(mktemp)
runir_post_json "$RECALL_URL" "$RECALL_TIMEOUT" "$BODY" -d "$PAYLOAD"
STATUS="${RUNIR_LAST_HTTP_CODE:-000}"

# Logging policy: 4xx/5xx always logged (so a silent server regression is visible
# without needing RUNIR_DEBUG). 2xx and transport failures (000) only when the
# operator opts in via RUNIR_DEBUG=1. All bodies pipe through runir_redact_bearer
# so a server that echoes the auth header back never leaks the token to disk.
should_log=0
case "$STATUS" in
  4*|5*) should_log=1 ;;
  *)     [ "${RUNIR_DEBUG:-0}" = "1" ] && should_log=1 ;;
esac
if [ "$should_log" = "1" ]; then
  mkdir -p "$(dirname "$DEBUG_LOG")"
  PROMPT_SNIP=$(echo "$PROMPT" | head -c 120 | tr '\n' ' ')
  TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  REDACTED_BODY=$(runir_redact_bearer < "$BODY")
  {
    echo "--- $TS status=$STATUS ---"
    echo "PROMPT: $PROMPT_SNIP"
    echo "RESPONSE: $REDACTED_BODY"
    echo ""
  } >> "$DEBUG_LOG"
fi

# Build context to inject into the turn. Only 2xx responses are trusted for
# content extraction — any other status produces no context.
CONTEXT=""
case "$STATUS" in
  2*)
    CONTEXT=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('prependContext') or '')" < "$BODY" 2>/dev/null)
    ;;
esac
rm -f "$BODY"

# Drift detection: if the debug log has recent 401s, surface a one-line warning
# to the next user turn so a server-side token rotation is visible immediately
# instead of silently failing for days. Requires the log to exist (which the
# 4xx/5xx-always-log policy above guarantees on any 401 path).
WARN=""
if [ -f "$DEBUG_LOG" ] && tail -n 50 "$DEBUG_LOG" 2>/dev/null | grep -q 'status=401'; then
  # $'...' applies ANSI-C escape interpretation so \n ends up as a real newline
  # in the additionalContext JSON string, not the literal two-character sequence.
  WARN=$'⚠️ runir hook has logged recent 401 responses — check RUNIR_API_KEY in ~/.claude/settings.json\n\n'
fi

if [ -n "$CONTEXT" ] || [ -n "$WARN" ]; then
  COMBINED="${WARN}${CONTEXT}"
  # argv, not stdin — avoids a trailing newline getting embedded in the JSON string.
  python3 -c "import sys,json; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': sys.argv[1]}}))" "$COMBINED"
fi
exit 0
