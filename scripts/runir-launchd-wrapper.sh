#!/bin/zsh
# Source for the operator-local com.runir.local launchd wrapper.
set -u
RUNIR_ROOT="${RUNIR_ROOT:-$HOME/Code/runir}"
cd "$RUNIR_ROOT" || {
  echo "[runir-launchd-wrapper] FATAL: cannot cd to RUNIR_ROOT=$RUNIR_ROOT" >&2
  exit 1
}

INFISICAL_BIN="/opt/homebrew/bin/infisical"
RUNIR_ENV_FILE="${RUNIR_ENV_FILE:-$RUNIR_ROOT/.env}"
export DOTENV_CONFIG_PATH="$RUNIR_ENV_FILE"
# dotenv must preserve injected values, including empty credentials on failure.
unset DOTENV_CONFIG_OVERRIDE
export OPENROUTER_API_KEY=""
export RUNIR_SOURCE_HMAC_KEY=""
unset INFISICAL_TOKEN INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET

export RUNIR_LLM_BASE_URL="https://api.nano-gpt.com/api/v1"
export EXTRACT_MODEL="openai/gpt-5.4-mini"
export RUNIR_EXTRACTOR_MODEL="openai/gpt-5.4-mini"
export RUNIR_ENTITY_MODEL="openai/gpt-5.4-mini"
export RUNIR_SEGMENT_MODEL="openai/gpt-5.4-mini"
export RUNIR_CONTINUITY_MODEL="openai/gpt-5.4-mini"
export RUNIR_THINK_MODEL="openai/gpt-5.6-luna"
export RUNIR_STALENESS_MODEL="openai/gpt-5.4-mini"
export RUNIR_SUPERSEDE_JUDGE_MODEL="openai/gpt-5.4-mini"
export ENRICH_MODEL="openai/gpt-5.4-mini"
export SYNTHESIS_MODEL="openai/gpt-5.4-mini"
export RERANKER_PROVIDER="local"

with_timeout() {
  # ponytail: direct-child timeout; use group supervision if Infisical starts workers.
  /opt/homebrew/bin/python3 -I -c '
import errno
import subprocess
import sys

try:
    result = subprocess.run(sys.argv[1:], timeout=20)
except subprocess.TimeoutExpired:
    sys.exit(124)
except OSError as error:
    sys.exit(127 if error.errno == errno.ENOENT else 126)
sys.exit(result.returncode if result.returncode >= 0 else 128 - result.returncode)
' "$@"
}

keychain_read() {
  with_timeout /usr/bin/security find-generic-password -s "$1" -w 2>/dev/null
}

is_single_ascii_token() {
  [[ -n "$1" && "$1" != *$'\n'* ]] && printf '%s' "$1" | LC_ALL=C grep -Eq '^[!-~]{20,}$'
}

load_source_hmac() {
  local client_id client_secret token key
  client_id="${RUNIR_INFISICAL_CLIENT_ID:-$(keychain_read "${RUNIR_INFISICAL_CLIENT_ID_SERVICE:-runir.infisical.client-id}")}"
  client_secret="${RUNIR_INFISICAL_CLIENT_SECRET:-$(keychain_read "${RUNIR_INFISICAL_CLIENT_SECRET_SERVICE:-runir.infisical.client-secret}")}"
  is_single_ascii_token "$client_id" && is_single_ascii_token "$client_secret" || return 1
  token="$(with_timeout "$INFISICAL_BIN" login \
    --method universal-auth --client-id "$client_id" --client-secret "$client_secret" \
    --plain --silent 2>/dev/null)" || return 1
  is_single_ascii_token "$token" || return 1
  key="$(with_timeout "$INFISICAL_BIN" secrets get RUNIR_SOURCE_HMAC_KEY \
    --projectId 2588c473-4c4c-4b5a-b0f5-e261184b6b53 \
    --env dev --path / --plain --silent --token "$token" 2>/dev/null)" || return 1
  is_single_ascii_token "$key" || return 1
  export RUNIR_SOURCE_HMAC_KEY="$key"
}

load_nanogpt() {
  local key
  # Cached operator authentication only: never use the runir machine token here.
  key="$(with_timeout /usr/bin/env -u INFISICAL_TOKEN "$INFISICAL_BIN" secrets get nanogpt \
    --projectId 402716ac-2805-4864-b3ce-e11b838f78b3 \
    --env prod --path /providers --plain --silent 2>/dev/null)" || return 1
  is_single_ascii_token "$key" || return 1
  export OPENROUTER_API_KEY="$key"
}

if [[ -x "$INFISICAL_BIN" ]]; then
  load_source_hmac ||
    echo "[runir-launchd-wrapper] WARN: source HMAC unavailable; source writes remain closed" >&2
  load_nanogpt ||
    echo "[runir-launchd-wrapper] WARN: NanoGPT credential unavailable; capture must remain retryable" >&2
else
  echo "[runir-launchd-wrapper] WARN: Infisical unavailable; source writes and model capture unavailable" >&2
fi
# Do not pass optional machine-identity overrides to the service process.
unset RUNIR_INFISICAL_CLIENT_ID RUNIR_INFISICAL_CLIENT_SECRET

NODE_BIN="${RUNIR_NODE_BIN:-/opt/homebrew/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[runir-launchd-wrapper] FATAL: no node binary found (set RUNIR_NODE_BIN)" >&2
  exit 1
fi
exec "$NODE_BIN" --import tsx/esm --import dotenv/config index.ts
