# extract-messages.jq — Extract user/assistant messages from Claude Code JSONL
# Usage: jq -Rr -f extract-messages.jq <session.jsonl>
# Raw-line ingestion: each line parsed individually; malformed lines silently skipped.

# `-R` feeds each line as a raw string; `fromjson?` tries to parse it as JSON,
# and the `?` suppresses errors so bad lines just evaluate to `empty` and disappear.
fromjson? |
# Drop anything that parsed to null (empty objects, null literals, etc.).
select(. != null) |
# Claude Code transcript entries tag themselves by type — we only care about conversation turns.
select(.type == "user" or .type == "assistant") |
# Some entries wrap the real content under `.message`; others are the message themselves.
# This `//` picks `.message` when present, falls back to the top-level object otherwise.
(.message // .) |
# Belt-and-braces: after unwrapping, confirm it actually carries a user/assistant role.
select(.role == "user" or .role == "assistant") |
# Project down to the minimal shape runir consumes.
{
  role: .role,
  content: (
    # Content can be a plain string (older format) or an array of content blocks (newer format).
    if (.content | type) == "string" then .content
    # For the array form, keep only text blocks, pull out `.text`, and join with newlines.
    # Non-text blocks (tool_use, images, thinking) become empty strings and are effectively dropped.
    elif (.content | type) == "array" then
      [ .content[] | if type == "object" and .type == "text" then (.text // "") else "" end ] | join("\n")
    else "" end |
    # Strip any previously-injected <relevant-memories>…</relevant-memories> envelope so recall
    # results from earlier turns don't round-trip back into the memory store (feedback loop).
    gsub("<relevant-memories>[\\s\\S]*?</relevant-memories>\\n?"; "") |
    # Trim leading/trailing whitespace left behind after the strip.
    gsub("^\\s+|\\s+$"; "")
  )
} |
# Drop messages whose cleaned content is empty (tool-only turns, fully-stripped memory blocks, etc.).
select(.content | length > 0)
