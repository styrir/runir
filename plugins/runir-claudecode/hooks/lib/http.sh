#!/usr/bin/env bash
# http.sh — Shared HTTP + redaction helpers for runir hooks
# Source this file, then call `runir_post_json` or pipe data through `runir_redact_bearer`.
#
# Environment:
#   RUNIR_API_KEY — bearer token (if set, Authorization header is attached; if unset, no header)
#
# WARNING: `runir_post_json` sets RUNIR_LAST_HTTP_CODE in the caller's shell.
# It MUST be invoked DIRECTLY — never via `$(...)`. Command substitution creates
# a subshell and the status global will not propagate to the caller.
#
# Correct usage (body-to-file pattern):
#   BODY=$(mktemp)
#   runir_post_json "$URL" "$TIMEOUT" "$BODY" -d "$PAYLOAD"
#   case "$RUNIR_LAST_HTTP_CODE" in
#     2*) cat "$BODY" | jq ... ;;
#     *)  : ;;  # caller decides logging / skip
#   esac
#   rm -f "$BODY"
#
# Incorrect usage (BREAKS — subshell loses RUNIR_LAST_HTTP_CODE):
#   RESULT=$(runir_post_json ...)   # don't do this

# Strip `Bearer <token>` occurrences from stdin. Case-insensitive. Matches a run of
# non-whitespace/non-quote characters after `Bearer ` so a token embedded in a JSON
# echo or an `Authorization` header line gets neutralised before hitting a log file.
runir_redact_bearer() {
  sed -E 's/[Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+[^[:space:]"'"'"']+/Bearer [REDACTED]/g'
}

# runir_post_json <url> <timeout_secs> <body_out_path> <payload_args...>
#
# POSTs JSON to <url> with Content-Type: application/json and, if RUNIR_API_KEY
# is set, Authorization: Bearer $RUNIR_API_KEY. Writes the response body to
# <body_out_path> (truncating any existing contents). Sets RUNIR_LAST_HTTP_CODE
# to the HTTP status on success, or "000" on any transport failure. Always
# returns 0 so `set -e` callers are not killed on a 4xx/5xx / network error.
#
# <payload_args> are passed verbatim to curl as argv. Typical shapes:
#   -d '{"key":"value"}'
#   --data-binary @/tmp/payload.json
runir_post_json() {
  local url="$1"
  local timeout="$2"
  local body_path="$3"
  shift 3

  # Start with the common curl args as an argv array. Building by appending to
  # an array (not string concatenation) preserves whitespace, `$`, quotes, and
  # other shell metacharacters in the bearer token value byte-for-byte.
  local curl_args=(
    -sS
    --max-time "$timeout"
    -X POST
    -o "$body_path"
    -w '%{http_code}'
    -H 'Content-Type: application/json'
  )

  # Attach the Authorization header as TWO separate argv elements (-H and the
  # value). Never interpolate the token into a single string — that would let
  # a backtick/`$` in the token be re-interpreted by the shell at expansion.
  if [ -n "${RUNIR_API_KEY:-}" ]; then
    curl_args+=(-H "Authorization: Bearer ${RUNIR_API_KEY}")
  fi

  # Caller's payload args (-d "..." or --data-binary @file) come last so they
  # can override / extend anything above if a future call needs to.
  curl_args+=("$@")

  # Make sure the body file exists BEFORE curl runs so a transport failure
  # that never calls `-o` still leaves a valid empty file for the caller to read.
  : > "$body_path" 2>/dev/null || true

  # `2>/dev/null` silences curl's own transport-error chatter. `|| status="000"`
  # catches DNS / TLS / connection-refused / timeout — we surface failure via
  # RUNIR_LAST_HTTP_CODE=000, not stderr.
  local status
  status=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || status="000"

  # Defensive: treat an empty status as transport failure so state-advancement
  # checks fail closed rather than accidentally matching an empty string.
  if [ -z "$status" ]; then
    status="000"
  fi

  RUNIR_LAST_HTTP_CODE="$status"
  return 0
}
