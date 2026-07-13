#!/usr/bin/env bash
# Stop / StopFailure fire-and-forget wrapper for runir_capture.py (plan v5.1 §5 Stage 3).
# Hook runner exec's this script; we background the Python script in a subshell + disown
# so Claude Code's wait-for-child returns before the HTTP call completes.
#
# Why not exec python3 directly from settings.json?
#   - Python does fork()-portability work to stay detached; easier in bash.
#   - Keeps the bash convention consistent with runir-recall.sh / runir-session-end.sh
#     (which is what existing settings.json entries and docs reference).
#
# Configuration env vars (consumed by runir_capture.py directly via os.environ):
#   RUNIR_USER_ID, RUNIR_API_KEY, RUNIR_CAPTURE_URL, RUNIR_CLIENT,
#   RUNIR_CAPTURE_TIMEOUT, RUNIR_MAX_TRANSCRIPT_BYTES.

set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${HOOK_DIR}/runir_capture.py"

# Skip silently if the Python script is missing (e.g. partial rollback).
if [ ! -f "$PY" ]; then exit 0; fi

# Capture stdin once — we can't read it from the background subshell because Claude Code
# closes stdin after the hook process exits.
INPUT=$(cat)

# Fire-and-forget: Python handles everything (transcript parse, watermark, POST, log).
# The subshell + disown pattern matches runir-session-end.sh:246-270. No temp files.
(
  echo "$INPUT" | python3 "$PY"
) &
disown

exit 0
