#!/usr/bin/env bash
# stability.sh — File stability retry library for session capture
# Source this file and call stabilize_file <path>

# Busy-wait until `file_path` stops growing (or max_retries is hit).
# Returns 0 when stable, 1 on timeout. Exists because Claude Code may still be
# flushing the JSONL transcript when the Stop hook fires.
stabilize_file() {
  local file_path="$1"
  # Overridable per-call via env. Defaults: 8 polls × 250ms = 2s max wait.
  local max_retries="${MAX_RETRIES:-8}"
  local retry_interval_ms="${RETRY_INTERVAL_MS:-250}"

  # If file doesn't exist or is empty, treat as stable immediately
  # Nothing to wait for; caller can decide to skip.
  if [[ ! -f "$file_path" ]] || [[ ! -s "$file_path" ]]; then
    return 0
  fi

  # Convert ms → seconds for `sleep`, which wants a decimal like 0.250.
  local sleep_secs
  sleep_secs=$(awk -v ms="$retry_interval_ms" 'BEGIN {printf "%.3f", ms/1000}')

  # Sentinel: -1 guarantees the first iteration can't match by accident.
  local last_size=-1
  local i=0
  # Poll loop.
  while (( i < max_retries )); do
    local current_size
    # Byte count of the file. `2>/dev/null || echo 0` keeps us going if wc fails mid-race.
    current_size=$(wc -c < "$file_path" 2>/dev/null || echo 0)
    # `wc -c` pads with whitespace on some platforms; `+ 0` coerces to a clean integer.
    current_size=$(( current_size + 0 ))  # trim whitespace from wc

    # Stable when two consecutive reads match AND the file is non-empty.
    if (( current_size == last_size && current_size > 0 )); then
      return 0
    fi

    # Remember this sample for the next comparison and wait before polling again.
    last_size=$current_size
    sleep "$sleep_secs"
    (( i++ ))
  done

  # Fell out of the loop — file is still growing or flapping. Caller decides how to handle.
  return 1
}
