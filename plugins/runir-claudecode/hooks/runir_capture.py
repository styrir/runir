#!/usr/bin/env python3
"""Claude Code Stop/StopFailure hook — incremental capture with watermark.

Pure-Python port of plugins/runir-codex/hooks/runir_stop_capture.py with:
  - Claude Code JSONL schema parser (top-level .type=="user"|"assistant")
  - ~/.claude/state/runir/ watermark paths (separate from Codex ~/.codex/runir/)
  - claudecode default client tag
  - Bearer redaction on logged response snippets (port of lib/http.sh:runir_redact_bearer)
  - HTTP 4xx/5xx/transport log split (mirror of runir-session-end.sh:262-264)
  - Transcript-size guard (mirror of runir-session-end.sh transcript_too_large skip)
  - StopFailure handling (identical path — watermark skip protects no-op fires)

Reads: stdin (Claude Code hook event JSON).
Writes: ~/.claude/state/runir/capture.log, ~/.claude/state/runir/capture-watermarks.json.
"""

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Local import — runir_watermark.py sits next to this script in the plugin hooks directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runir_watermark import (  # type: ignore  # noqa: E402
    load_fallback_hash,
    load_watermark,
    save_fallback_hash,
    save_watermark,
)

RUNIR_USER_ID = os.environ.get("RUNIR_USER_ID")
RUNIR_API_KEY = os.environ.get("RUNIR_API_KEY", "")
RUNIR_BASE = os.environ.get("RUNIR_BASE", "http://127.0.0.1:7700").rstrip("/")
RUNIR_CAPTURE_URL = os.environ.get(
    "RUNIR_CAPTURE_URL", f"{RUNIR_BASE}/hooks/capture"
)
RUNIR_CLIENT = os.environ.get("RUNIR_CLIENT", "claudecode")
RUNIR_CAPTURE_TIMEOUT = int(os.environ.get("RUNIR_CAPTURE_TIMEOUT", "30"))
RUNIR_MAX_TRANSCRIPT_BYTES = int(
    os.environ.get("RUNIR_MAX_TRANSCRIPT_BYTES", str(10 * 1024 * 1024))
)
RUNIR_CAPTURE_BOOTSTRAP_MESSAGES = int(os.environ.get("RUNIR_CAPTURE_BOOTSTRAP_MESSAGES", "8"))
RUNIR_USER_AGENT = os.environ.get("RUNIR_USER_AGENT", "runir-claudecode-hook/0.1")

LOG_PATH = Path.home() / ".claude" / "state" / "runir" / "capture.log"
# v5.1 plan §5 Stage 3: match `Bearer X` anywhere (not only after Authorization:),
# case-insensitive, stops at whitespace/double-quote/single-quote. Preserves the
# trailing `bearer` capture so the bash parity replacement `\1 [REDACTED]` (with
# brackets) produces byte-identical log output to lib/http.sh:27-29's sed.
BEARER_REDACT_RE = re.compile(r'(?i)(bearer)\s+[^\s"\']+')
# Empty ProxyHandler bypasses system proxies — we POST directly to the runir host.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SKIP_PREFIXES = (
    "# AGENTS.md instructions",
    "<skill>",
)

KNOWN_TERMINAL_SKIP_REASONS = frozenset({
    "no messages",
    "no normalizable messages",
    "noise-bank",
})
# Non-terminal reasons (transient/config issues — retry may succeed):
#   "no capture API key" — missing env var, might be set before next Stop


def log(msg: str) -> None:
    """Append a UTC-timestamped line to capture.log. Creates dir on first use."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(f"{ts} {msg}\n")


def redact_bearer(text: str) -> str:
    """Port of lib/http.sh:runir_redact_bearer (v5.1 plan §5 Stage 3).

    Matches `Bearer X` ANYWHERE in text (not just after Authorization:), case-insensitive,
    stops at whitespace/double-quote/single-quote. Replacement format matches bash:
    `Bearer [REDACTED]` with brackets, so log-grep queries behave identically across
    bash (session-end.log, recall-debug.log) and Python (capture.log) outputs.

    Documented parity gap with bash: `{"bearer":"abc123"}` (JSON-embedded) is NOT
    redacted because the `":"` separator is not whitespace — matches bash's
    lib/http.sh:27-29 regex behavior. If JSON-embedded bearer redaction is ever
    required, widen BOTH implementations together; do not let them diverge.
    """
    return BEARER_REDACT_RE.sub(r"\1 [REDACTED]", text)


def read_messages(transcript_path: Optional[str]) -> List[Dict[str, Any]]:
    """Parse Claude Code JSONL transcript → [{role, content, timestamp?}].

    Claude Code JSONL schema (differs from Codex — see plan v4 §Schema divergence):
      {"type":"user","message":{"role":"user","content":"<string>"},"timestamp":"..."}
      {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."},...]}}

    Also handles the looser schema some transcripts use (`.message.content` as a
    bare string on user lines, or content block lists on both roles). Only
    user/assistant entries with non-empty text are kept. Semantics mirror
    the plugin's extract-messages jq filter semantics.
    """
    messages: List[Dict[str, Any]] = []
    if not transcript_path:
        return messages
    path = Path(transcript_path)
    if not path.exists():
        return messages
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                role = item.get("type")
                if role not in ("user", "assistant"):
                    continue
                message = item.get("message") or {}
                content = message.get("content")
                text_parts: List[str] = []
                if isinstance(content, str):
                    if content:
                        text_parts.append(content)
                elif isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "text":
                            t = block.get("text")
                            if t:
                                text_parts.append(t)
                if not text_parts:
                    continue
                content = "\n".join(text_parts)
                if role == "user" and should_skip_capture_message(content):
                    continue
                out: Dict[str, Any] = {"role": role, "content": content}
                ts = item.get("timestamp")
                if isinstance(ts, str) and ts:
                    out["timestamp"] = ts
                messages.append(out)
    except Exception:
        return []
    return messages


def should_skip_capture_message(content: str) -> bool:
    """Skip hook-injected instruction payloads that are not user dialogue."""
    stripped = content.lstrip()
    return any(stripped.startswith(prefix) for prefix in SKIP_PREFIXES)


def select_new_messages(all_messages: List[Dict[str, Any]], watermark: int) -> List[Dict[str, Any]]:
    """Select new messages, bounding first-run backlog capture.

    A long-running Claude Code session may first enable this hook after a large
    transcript already exists. Capturing that whole backlog can exceed the
    detached worker timeout and prevent the watermark from ever advancing.
    """
    new_messages = all_messages[watermark:]
    if watermark == 0 and RUNIR_CAPTURE_BOOTSTRAP_MESSAGES > 0 and len(new_messages) > RUNIR_CAPTURE_BOOTSTRAP_MESSAGES:
        return new_messages[-RUNIR_CAPTURE_BOOTSTRAP_MESSAGES:]
    return new_messages


def fallback_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_successful_response(status_code: int, body: Dict[str, Any]) -> Tuple[bool, str]:
    """Port of Codex runir_stop_capture.py:_is_successful_response.

    Returns (advance_watermark, reason_tag). advance_watermark controls whether
    we save the new watermark; reason_tag is echoed into the log for observability.
    """
    if status_code < 200 or status_code >= 300:
        return (False, "")
    if "error" in body:
        return (False, "__error_field__")
    if body.get("skipped") is True:
        reason = body.get("reason", "") or ""
        return (reason in KNOWN_TERMINAL_SKIP_REASONS, reason)
    return (True, "__normal__")


def post_capture(payload: Dict[str, Any]) -> Tuple[int, Dict[str, Any], bytes]:
    """Port of lib/http.sh:runir_post_json.

    POSTs JSON + Bearer header, returns (status_code, parsed_body, raw_bytes).
    Transport/DNS/TLS/timeout failures return (0, {}, b"") so the caller can
    branch into error_transport logging without special-casing exceptions.
    """
    body_bytes = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": RUNIR_USER_AGENT,
    }
    if RUNIR_API_KEY:
        headers["Authorization"] = f"Bearer {RUNIR_API_KEY}"
    req = urllib.request.Request(
        RUNIR_CAPTURE_URL, data=body_bytes, headers=headers, method="POST"
    )
    try:
        with OPENER.open(req, timeout=RUNIR_CAPTURE_TIMEOUT) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read() if hasattr(e, "read") else b""
        status = e.code
    except Exception:
        return (0, {}, b"")
    try:
        parsed = json.loads(raw) if raw else {}
    except Exception:
        parsed = {}
    return (status, parsed if isinstance(parsed, dict) else {}, raw)


def main() -> int:
    # Skip silently if userId is unset — matches bash hooks' fail-closed semantics.
    if not RUNIR_USER_ID:
        return 0
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0

    session_id = event.get("session_id") or ""
    cwd = event.get("cwd") or ""
    transcript_path = event.get("transcript_path") or ""
    last_assistant = event.get("last_assistant_message") or ""

    # Transcript-size guard (mirror of runir-session-end.sh's transcript_too_large skip).
    if transcript_path and os.path.exists(transcript_path):
        size = os.path.getsize(transcript_path)
        if size > RUNIR_MAX_TRANSCRIPT_BYTES:
            log(f"skip: session={session_id} reason=transcript_too_large bytes={size}")
            return 0

    all_messages = read_messages(transcript_path)
    using_fallback = False
    fb_hash: Optional[str] = None

    # Fallback: transcript empty but last_assistant_message present
    # (mirror of Codex runir_stop_capture.py:129-136 semantics).
    if not all_messages and last_assistant:
        using_fallback = True
        fb_hash = fallback_hash(str(last_assistant))
        if session_id and load_fallback_hash(session_id) == fb_hash:
            log(f"skip: session={session_id} reason=duplicate_fallback")
            return 0
        all_messages = [{"role": "assistant", "content": str(last_assistant)}]

    if not all_messages:
        log(f"skip: session={session_id} reason=no_messages")
        return 0

    total_count = len(all_messages)
    watermark = 0 if using_fallback else (load_watermark(session_id) if session_id else 0)

    # Transcript shorter than watermark → reset (compaction / truncation).
    if not using_fallback and total_count < watermark:
        log(f"reset: session={session_id} total={total_count} watermark={watermark}")
        watermark = 0

    new_messages = select_new_messages(all_messages, watermark)
    if not new_messages:
        log(f"skip: session={session_id} reason=no_new watermark={watermark} total={total_count}")
        return 0

    payload: Dict[str, Any] = {
        "messages": new_messages,
        "userId": RUNIR_USER_ID,
        "client": RUNIR_CLIENT,
    }
    if session_id:
        payload["sessionId"] = session_id
    if cwd:
        payload["path"] = cwd

    status, response_body, raw_body = post_capture(payload)
    advance, reason = is_successful_response(status, response_body)

    if advance:
        if using_fallback and fb_hash and session_id:
            save_fallback_hash(session_id, fb_hash)
        elif session_id:
            save_watermark(session_id, total_count)
        log(
            f"ok: session={session_id} new_count={len(new_messages)} "
            f"total={total_count} http={status} reason={reason or '__normal__'}"
        )
    else:
        # Redact Bearer from any response body snippet we log.
        snippet = redact_bearer(raw_body.decode("utf-8", errors="replace"))[:256]
        snippet = snippet.replace("\n", " ")
        http_s = f"{status:03d}" if status else "000"
        if 400 <= status < 500:
            log(
                f"error_http_4xx: session={session_id} http={http_s} "
                f"reason={reason or '?'} body={snippet}"
            )
        elif 500 <= status < 600:
            log(
                f"error_http_5xx: session={session_id} http={http_s} "
                f"reason={reason or '?'} body={snippet}"
            )
        elif status == 0:
            log(
                f"error_transport: session={session_id} http=000 "
                f"reason={reason or '?'} body={snippet}"
            )
        else:
            log(
                f"hold: session={session_id} http={http_s} "
                f"reason={reason or '?'} body={snippet}"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
