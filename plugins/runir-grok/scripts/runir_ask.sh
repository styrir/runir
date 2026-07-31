#!/usr/bin/env bash
# Thin ask.sh-compatible entry for headless Runir inject.
# Opt-in: invoke this instead of ask.sh so pre-inference memory is injected.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INJECT="${SCRIPT_DIR}/headless_inject.py"

if [[ ! -f "$INJECT" ]]; then
  echo "error: headless_inject.py not found at $INJECT" >&2
  exit 2
fi

# Usage:
#   runir_ask.sh "prompt text"
#   runir_ask.sh --prompt-file PATH
#   runir_ask.sh --resume SESSION --prompt "..."
# Extra flags are forwarded to headless_inject.py.

if [[ $# -eq 0 ]]; then
  echo "usage: runir_ask.sh [--prompt-file PATH | PROMPT] [--resume SESSION] [headless_inject flags...]" >&2
  exit 2
fi

# If first arg is not a flag, treat it as the prompt text.
if [[ "${1:-}" != -* ]]; then
  exec python3 "$INJECT" --prompt "$1" "${@:2}"
fi

exec python3 "$INJECT" "$@"
