#!/usr/bin/env bash
# state.sh — Session-end hook state management library
# Source this file and call read_state, write_state, prune_old_sessions

# All per-session cursors live in one JSON file under ~/.claude/state/runir/ by default.
# Overridable via STATE_DIR env so tests can use a scratch path.
STATE_DIR="${STATE_DIR:-${HOME}/.claude/state/runir}"
STATE_FILE="${STATE_DIR}/session-end-state.json"

# Emit `last_line=N` and `message_count=M` on stdout for the given session_id.
# Caller invokes via `eval "$(read_state "$session_id")"` to pull both values into locals.
# Missing file / missing session / parse error all degrade to "0 / 0" (start from scratch).
read_state() {
  local session_id="$1"
  local last_line=0
  local message_count=0
  if [[ -f "$STATE_FILE" ]]; then
    local result
    # Inline python so we don't need jq here; also lets us be lenient on parse errors.
    # Success path prints two lines (last_line, message_count). Error path prints "0\n0"
    # and logs to stderr so we don't wedge a legit session on a corrupt state file.
    result=$(python3 -c "
import json, sys
try:
    data = json.loads(open('$STATE_FILE').read())
    s = data.get('sessions', {}).get(sys.argv[1], {})
    print(s.get('last_line', 0))
    print(s.get('message_count', 0))
except Exception as e:
    import sys as _sys
    print('ERROR: ' + str(e), file=_sys.stderr)
    print(0)
    print(0)
" "$session_id" 2>/dev/null)
    # Split the two-line result into separate variables.
    last_line=$(echo "$result" | sed -n '1p')
    message_count=$(echo "$result" | sed -n '2p')
    # Default to "0" if either line came back empty (defense-in-depth for `eval`).
    last_line="${last_line:-0}"
    message_count="${message_count:-0}"
  fi
  # These two echoes are the function's "return value" — consumed by `eval` in the caller.
  echo "last_line=${last_line}"
  echo "message_count=${message_count}"
}

# Upsert this session's cursor into the state file.
# Args: session_id, last_line (new cursor), message_count (running total).
write_state() {
  local session_id="$1"
  local last_line="$2"
  local message_count="$3"
  # Timestamp is what `prune_old_sessions` uses to age out stale entries.
  local updated_at
  updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Make sure the state dir exists before we try to write.
  mkdir -p "$STATE_DIR"
  # Start from the existing file, or an empty `{sessions:{}}` skeleton on first run.
  local current_json='{"sessions":{}}'
  [[ -f "$STATE_FILE" ]] && current_json=$(cat "$STATE_FILE")
  # Write to a .tmp sibling first, then `mv` atomically over the real file so a crash
  # mid-write can't leave the state file half-written / unparseable.
  python3 -c "
import json, sys
data = json.loads(sys.argv[1])
data.setdefault('sessions', {})[sys.argv[2]] = {
    'last_line': int(sys.argv[3]),
    'message_count': int(sys.argv[4]),
    'updated_at': sys.argv[5]
}
print(json.dumps(data, indent=2))
" "$current_json" "$session_id" "$last_line" "$message_count" "$updated_at" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

# Drop session entries that haven't been updated in 7+ days.
# Keeps the state file from growing unbounded as new sessions accumulate.
prune_old_sessions() {
  # No state file → nothing to prune.
  [[ -f "$STATE_FILE" ]] || return 0
  # Rebuild the sessions dict with only entries younger than the 7-day cutoff.
  # `replace('Z','+00:00')` lets fromisoformat handle the Z suffix on older Pythons.
  # Missing/unparseable updated_at defaults to the epoch → will be pruned.
  # Same atomic-rename pattern as write_state.
  python3 -c "
import json, sys
from datetime import datetime, timezone, timedelta
cutoff = datetime.now(timezone.utc) - timedelta(days=7)
data = json.loads(open(sys.argv[1]).read())
sessions = data.get('sessions', {})
kept = {k: v for k, v in sessions.items()
        if datetime.fromisoformat(v.get('updated_at','1970-01-01T00:00:00Z').replace('Z','+00:00')) > cutoff}
data['sessions'] = kept
print(json.dumps(data, indent=2))
" "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
}
