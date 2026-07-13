#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${HOOK_DIR}/.." && pwd)}"
HOOK_LIB_DIR="${PLUGIN_ROOT}/hooks/lib"
FILTER="${HOOK_LIB_DIR}/extract-messages.jq"

source "${HOOK_LIB_DIR}/stability.sh"
source "${HOOK_LIB_DIR}/state.sh"
source "${HOOK_LIB_DIR}/http.sh"

RUN_ID="${1:-unknown}"
INPUT_PATH="${2:-}"
LOG_FILE="${3:-${HOME}/.claude/state/runir/session-end.log}"
RUNIR_BASE="${RUNIR_BASE:-http://127.0.0.1:7700}"
ENDPOINT="${RUNIR_SESSION_END_URL:-${RUNIR_BASE}/hooks/session-end}"
SESSION_END_TIMEOUT="${RUNIR_SESSION_END_TIMEOUT:-60}"

stage="worker_start"
tmp_jsonl=""
tmp_messages=""
tmp_payload=""
body_tmp=""
session_id=""
session_log_id="unknown"
session_log_reason="unknown"
transcript_path=""

log() {
  mkdir -p "$(dirname "$LOG_FILE")"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"
}

cleanup() {
  rm -f "${INPUT_PATH:-}" "${tmp_jsonl:-}" "${tmp_messages:-}" "${tmp_payload:-}" "${body_tmp:-}"
}

on_exit() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    log "exit: run=${RUN_ID} session=${session_log_id} reason=${session_log_reason} stage=${stage} rc=${rc}"
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT

if [[ -z "$INPUT_PATH" || ! -f "$INPUT_PATH" ]]; then
  stage="missing_input"
  log "exit: run=${RUN_ID} session=${session_log_id} reason=${session_log_reason} stage=${stage} rc=missing_input"
  exit 0
fi

stage="parse_event"
transcript_path=$(python3 -c "import json; d=json.load(open('$INPUT_PATH')); print(d.get('transcript_path',''))" 2>/dev/null || echo "")
session_id=$(python3 -c "import json; d=json.load(open('$INPUT_PATH')); print(d.get('session_id',''))" 2>/dev/null || echo "")
session_end_reason=$(python3 -c "import json; d=json.load(open('$INPUT_PATH')); print(d.get('reason',''))" 2>/dev/null || echo "")
cwd=$(python3 -c "import json; d=json.load(open('$INPUT_PATH')); print(d.get('cwd',''))" 2>/dev/null || echo "")

if [[ -z "$session_id" && -n "$transcript_path" ]]; then
  session_id=$(basename "$transcript_path" .jsonl)
fi
session_log_id="${session_id:-unknown}"
session_log_reason="${session_end_reason:-unknown}"

if [[ -z "$transcript_path" || "$transcript_path" == "null" ]]; then
  stage="skip_no_transcript"
  log "skip: run=${RUN_ID} no transcript_path session=${session_log_id} reason=${session_log_reason}"
  exit 0
fi

if [[ ! -f "$transcript_path" ]]; then
  stage="skip_missing_transcript"
  log "skip: run=${RUN_ID} transcript not found session=${session_log_id} reason=${session_log_reason} path=$transcript_path"
  exit 0
fi

: "${RUNIR_MAX_TRANSCRIPT_BYTES:=10485760}"
size=$(wc -c <"$transcript_path" | tr -d ' ')
if [ "$size" -gt "$RUNIR_MAX_TRANSCRIPT_BYTES" ]; then
  stage="skip_transcript_too_large"
  log "skip: run=${RUN_ID} session=${session_log_id} reason=transcript_too_large exit_reason=${session_log_reason} bytes=${size} limit=${RUNIR_MAX_TRANSCRIPT_BYTES}"
  exit 0
fi

stage="stabilize_transcript"
tmp_jsonl=$(mktemp)
cp "$transcript_path" "$tmp_jsonl"
stabilize_file "$transcript_path" && cp "$transcript_path" "$tmp_jsonl" || true

stage="read_state"
eval "$(read_state "$session_id")"

stage="extract_messages"
tmp_messages=$(mktemp)
jq -Rr -f "$FILTER" "$tmp_jsonl" | \
  awk "NR > ${last_line}" | \
  jq -s '.' > "$tmp_messages" 2>/dev/null || echo "[]" > "$tmp_messages"

new_msg_count=$(jq 'length' < "$tmp_messages" 2>/dev/null || echo "0")
if [[ "$new_msg_count" -eq 0 ]]; then
  stage="skip_no_new_messages"
  log "skip: run=${RUN_ID} no new messages session=${session_log_id} reason=${session_log_reason} last_line=${last_line}"
  exit 0
fi

stage="prepare_payload"
total_lines=$(wc -l < "$tmp_jsonl" | tr -d ' ')
new_message_count=$((message_count + new_msg_count))
tmp_payload=$(mktemp)
python3 -c "
import json, sys, subprocess, os

msgs = json.load(open(sys.argv[1]))
cwd             = sys.argv[4]
user_id         = sys.argv[5]
client          = sys.argv[6]
sparse_threshold = int(sys.argv[7])
max_diff_chars   = int(sys.argv[8])
src_prefix       = sys.argv[9]

payload = {
    'sessionId': sys.argv[2],
    'userId': user_id,
    'messages': msgs,
    'messageOffset': int(sys.argv[3]),
    'terminationReason': sys.argv[10] or None,
    'client': client,
}
if cwd:
    payload['path'] = cwd

SPARSE_THRESHOLD = sparse_threshold
MAX_DIFF_CHARS    = max_diff_chars
SRC_PREFIX        = src_prefix
EXCLUDED          = ('test/', '__tests__/', 'node_modules/', '.beads/')

def is_git_repo(path):
    try:
        r = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                           cwd=path, capture_output=True, text=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False

def git(args, cwd_):
    try:
        r = subprocess.run(['git'] + args, cwd=cwd_,
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ''
    except Exception:
        return ''

def collect_git_commits(repo, since_iso):
    raw = git(['log', '--after=' + since_iso, '--format=%H %s'], repo)
    if not raw:
        return []
    commits = []
    used_diff_chars = 0
    for line in raw.splitlines():
        sp = line.index(' ')
        h, subj = line[:sp], line[sp+1:].strip()
        stat = git(['show', h, '--stat', '--no-patch'], repo)
        diff_snippet = ''
        if used_diff_chars < MAX_DIFF_CHARS:
            raw_diff = git(['show', h, '--unified=3', '--', SRC_PREFIX], repo)
            filtered = '\\n'.join(
                l for l in raw_diff.splitlines()
                if not any(e in l.lower() for e in EXCLUDED)
            )
            budget = MAX_DIFF_CHARS - used_diff_chars
            diff_snippet = filtered[:budget]
            used_diff_chars += len(diff_snippet)
        commits.append({
            'hash': h,
            'subject': subj,
            'statSummary': stat,
            'diffSnippet': diff_snippet,
        })
    return commits

if len(msgs) < SPARSE_THRESHOLD and cwd and is_git_repo(cwd):
    since_iso = None
    for m in msgs:
        ts = m.get('timestamp') or m.get('created_at') or m.get('ts')
        if ts:
            since_iso = ts
            break
    if not since_iso:
        import datetime
        since_iso = (datetime.datetime.utcnow() -
                     datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
    commits = collect_git_commits(cwd, since_iso)
    if commits:
        payload['gitCommits'] = commits

print(json.dumps(payload))
" "$tmp_messages" "$session_id" "$new_message_count" "$cwd" \
   "$RUNIR_USER_ID" \
   "${RUNIR_CLIENT:-claudecode}" \
   "${RUNIR_SPARSE_THRESHOLD:-10}" \
   "${RUNIR_MAX_DIFF_CHARS:-2000}" \
   "${RUNIR_GIT_SRC_PREFIX:-src/}" \
   "${session_end_reason}" \
   > "$tmp_payload"

body_tmp=$(mktemp)

stage="post_begin"
log "stage: run=${RUN_ID} session=${session_log_id} reason=${session_log_reason} stage=${stage}"
runir_post_json "$ENDPOINT" "$SESSION_END_TIMEOUT" "$body_tmp" \
  --data-binary "@$tmp_payload"
http_code="${RUNIR_LAST_HTTP_CODE:-000}"
[[ -z "$http_code" ]] && http_code="000"

stage="post_end"
log "stage: run=${RUN_ID} session=${session_log_id} reason=${session_log_reason} stage=${stage} http=${http_code}"

if [[ "$http_code" =~ ^2 ]]; then
  stage="write_state"
  write_state "$session_id" "$total_lines" "$new_message_count"
  prune_old_sessions
  stage="complete"
  log "ok: run=${RUN_ID} session=${session_log_id} reason=${session_log_reason} new_msgs=${new_msg_count} total=${new_message_count} http=${http_code}"
else
  stage="error"
  response_preview="$(head -c 200 "$body_tmp" 2>/dev/null | runir_redact_bearer | tr '\n' ' ' || true)"
  if [[ -n "$response_preview" ]]; then
    log "error: run=${RUN_ID} session=${session_log_id} reason=${session_log_reason} http=${http_code} new_msgs=${new_msg_count} body=${response_preview}"
  else
    log "error: run=${RUN_ID} session=${session_log_id} reason=${session_log_reason} http=${http_code} new_msgs=${new_msg_count}"
  fi
fi
