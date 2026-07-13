#!/usr/bin/env python3
"""Codex Stop hook — incremental capture with watermark.

Reads transcript, slices to new-since-watermark messages, POSTs to
/hooks/capture. Advances watermark only on confirmed success.
"""

import json
import os
import sys
import urllib.request
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional

from watermark import load_fallback_hash, load_watermark, save_fallback_hash, save_watermark

RUNIR_BASE = os.environ.get("RUNIR_BASE", "http://127.0.0.1:7700")
RUNIR_USER_ID = os.environ.get("RUNIR_USER_ID")
RUNIR_API_KEY = os.environ.get("RUNIR_API_KEY")
RUNIR_CLIENT = os.environ.get("RUNIR_CODEX_CLIENT", "codex")
RUNIR_USER_AGENT = os.environ.get("RUNIR_CODEX_USER_AGENT", "runir-codex-hook/0.2")
RUNIR_DEBUG = os.environ.get("RUNIR_DEBUG") == "1"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
MAX_BOOTSTRAP_MESSAGES = int(os.environ.get("RUNIR_CAPTURE_BOOTSTRAP_MESSAGES", "8"))
SKIP_PREFIXES = (
    "# AGENTS.md instructions",
    "<skill>",
)

KNOWN_TERMINAL_SKIP_REASONS = frozenset({
    "no messages",
    "no normalizable messages",
    "noise-bank",
})
# Reasons that are NOT terminal (transient/config issues — retry may succeed):
# "no capture API key" — missing env var, might be set before next Stop


def _debug(msg: str) -> None:
    if RUNIR_DEBUG:
        print(f"[runir-capture] {msg}", file=sys.stderr)


def read_messages(transcript_path: Optional[str]) -> List[Dict[str, Any]]:
    """Parse transcript JSONL to user/assistant messages only."""
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
                if item.get("type") != "response_item":
                    continue
                payload = item.get("payload") or {}
                if payload.get("type") != "message":
                    continue
                role = payload.get("role")
                if role not in ("user", "assistant"):
                    continue
                text_parts: List[str] = []
                for content in payload.get("content") or []:
                    if not isinstance(content, dict):
                        continue
                    text = content.get("text") or content.get("content")
                    if text:
                        text_parts.append(text)
                if text_parts:
                    content = "\n".join(text_parts)
                    if role == "user" and should_skip_capture_message(content):
                        continue
                    message: Dict[str, Any] = {"role": role, "content": content}
                    timestamp = item.get("timestamp")
                    if isinstance(timestamp, str) and timestamp:
                        message["timestamp"] = timestamp
                    messages.append(message)
    except Exception:
        return []

    return messages


def should_skip_capture_message(content: str) -> bool:
    """Skip Codex-injected instruction payloads that are not user dialogue."""
    stripped = content.lstrip()
    return any(stripped.startswith(prefix) for prefix in SKIP_PREFIXES)


def select_new_messages(all_messages: List[Dict[str, Any]], watermark: int) -> List[Dict[str, Any]]:
    """Select new messages, bounding first-run backlog capture.

    A long-running Codex Desktop thread may install or resume hooks after many
    turns have already accumulated. Capturing that full backlog can exceed the
    Stop hook timeout and prevent the watermark from ever advancing.
    """
    new_messages = all_messages[watermark:]
    if watermark == 0 and MAX_BOOTSTRAP_MESSAGES > 0 and len(new_messages) > MAX_BOOTSTRAP_MESSAGES:
        return new_messages[-MAX_BOOTSTRAP_MESSAGES:]
    return new_messages


def _fallback_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_successful_response(status_code: int, body: dict) -> bool:
    """Check if response indicates successful capture (watermark should advance).

    Watermark advances when the server has terminally processed the slice:
    - Normal success (factsFound >= 0, no error)
    - Terminal skip reasons (noise-bank, no messages, no normalizable messages)

    Watermark holds when retrying might produce a different result:
    - HTTP errors, malformed JSON, error field in response
    - Transient skip reasons (no capture API key — config might be fixed)
    """
    if status_code < 200 or status_code >= 300:
        return False
    if "error" in body:
        return False
    if body.get("skipped") is True:
        reason = body.get("reason", "")
        return reason in KNOWN_TERMINAL_SKIP_REASONS
    return True


def main() -> int:
    if not RUNIR_USER_ID:
        return 0

    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0

    session_id = event.get("session_id")
    cwd = event.get("cwd")
    transcript_path = event.get("transcript_path")
    last_assistant = event.get("last_assistant_message")

    all_messages = read_messages(transcript_path)
    using_fallback = False
    fallback_hash: Optional[str] = None

    # Fallback: if transcript is empty/missing but we have last_assistant_message,
    # use it as a single-message capture. This preserves the pre-watermark behavior
    # for cases where Codex fires Stop without a readable transcript.
    if not all_messages and last_assistant:
        using_fallback = True
        fallback_hash = _fallback_hash(str(last_assistant))
        if session_id and load_fallback_hash(session_id) == fallback_hash:
            _debug("duplicate last_assistant_message fallback, skipping")
            return 0
        all_messages = [{"role": "assistant", "content": str(last_assistant)}]
        _debug("using last_assistant_message fallback (no transcript)")

    if not all_messages:
        _debug("no messages in transcript or fallback")
        return 0

    total_count = len(all_messages)
    watermark = 0 if using_fallback else (load_watermark(session_id) if session_id else 0)

    # Transcript shorter than watermark → reset (transcript truncation/compaction)
    if not using_fallback and total_count < watermark:
        _debug(f"transcript reset: {total_count} < watermark {watermark}, resetting to 0")
        watermark = 0

    # Slice to only new messages
    new_messages = select_new_messages(all_messages, watermark)
    if not new_messages:
        _debug(f"no new messages (watermark={watermark}, total={total_count})")
        return 0

    _debug(f"capturing {len(new_messages)} new messages (watermark={watermark}, total={total_count})")

    body = json.dumps({
        "messages": new_messages,
        "userId": RUNIR_USER_ID,
        "client": RUNIR_CLIENT,
        "sessionId": session_id,
        "path": cwd,
    }).encode("utf-8")

    headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": RUNIR_USER_AGENT,
        }
    if RUNIR_API_KEY:
        headers["Authorization"] = f"Bearer {RUNIR_API_KEY}"

    req = urllib.request.Request(
        f"{RUNIR_BASE}/hooks/capture",
        data=body,
        headers=headers,
        method="POST",
    )

    try:
        with OPENER.open(req, timeout=10) as resp:
            status_code = resp.status
            raw = resp.read()
            try:
                response_body = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                _debug(f"malformed response body: {raw[:200]}")
                return 0
    except Exception as exc:
        _debug(f"capture request failed: {exc}")
        return 0

    if _is_successful_response(status_code, response_body):
        if session_id:
            if using_fallback and fallback_hash:
                save_fallback_hash(session_id, fallback_hash)
                _debug("saved fallback hash")
            else:
                save_watermark(session_id, total_count)
                _debug(f"watermark advanced to {total_count}")
    else:
        _debug(f"capture not successful (status={status_code}, body={response_body}), watermark held")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
