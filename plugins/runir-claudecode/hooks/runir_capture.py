#!/usr/bin/env python3
"""Claude Code Stop/StopFailure hook — incremental capture with watermark.

Pure-Python port of plugins/runir-codex/hooks/runir_stop_capture.py with:
  - Claude Code JSONL schema parser (top-level .type=="user"|"assistant")
  - ~/.claude/state/runir/ watermark paths (separate from Codex ~/.codex/runir/)
  - claudecode default client tag
  - Bearer redaction on logged response snippets (port of lib/http.sh:runir_redact_bearer)
  - HTTP 4xx/5xx/transport log split (mirror of runir-session-end.sh:262-264)
  - Bounded JSONL byte-offset reader with native turn keys and v1 migration
  - StopFailure handling (identical path — watermark skip protects no-op fires)

Reads: stdin (Claude Code hook event JSON).
Writes: ~/.claude/state/runir/capture.log, ~/.claude/state/runir/capture-watermarks.json.
"""

import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runir_watermark import load_entry, save_entry  # type: ignore  # noqa: E402

RUNIR_USER_ID = os.environ.get("RUNIR_USER_ID")
RUNIR_API_KEY = os.environ.get("RUNIR_API_KEY", "")
RUNIR_BASE = os.environ.get("RUNIR_BASE", "http://127.0.0.1:7700").rstrip("/")
RUNIR_CAPTURE_URL = os.environ.get(
    "RUNIR_CAPTURE_URL", f"{RUNIR_BASE}/hooks/capture"
)
RUNIR_CLIENT = os.environ.get("RUNIR_CLIENT", "claudecode")
RUNIR_CAPTURE_TIMEOUT = int(os.environ.get("RUNIR_CAPTURE_TIMEOUT", "30"))
RUNIR_SESSION_END_TIMEOUT = max(1, int(os.environ.get("RUNIR_SESSION_END_TIMEOUT", "60")))
RUNIR_CAPTURE_READ_BUDGET_BYTES = max(1, int(os.environ.get("RUNIR_CAPTURE_READ_BUDGET_BYTES", str(16 * 1024 * 1024))))
RUNIR_CAPTURE_MAX_LINE_BYTES = max(1, int(os.environ.get("RUNIR_CAPTURE_MAX_LINE_BYTES", str(8 * 1024 * 1024))))
RUNIR_CAPTURE_BOOTSTRAP_MESSAGES = int(os.environ.get("RUNIR_CAPTURE_BOOTSTRAP_MESSAGES", "8"))
RUNIR_CAPTURE_BATCH_MESSAGES = min(200, max(1, int(os.environ.get("RUNIR_CAPTURE_BATCH_MESSAGES", "200"))))

RUNIR_USER_AGENT = os.environ.get("RUNIR_USER_AGENT", "runir-claudecode-hook/0.1")

LOG_PATH = Path.home() / ".claude" / "state" / "runir" / "capture.log"
# v5.1 plan §5 Stage 3: match `Bearer X` anywhere (not only after Authorization:),
# case-insensitive, stops at whitespace/double-quote/single-quote. Preserves the
# trailing `bearer` capture so the bash parity replacement `\1 [REDACTED]` (with
# brackets) produces byte-identical log output to lib/http.sh:27-29's sed.
BEARER_REDACT_RE = re.compile(r'(?i)(bearer)\s+[^\s"\']+')
# Empty ProxyHandler bypasses system proxies — we POST directly to the runir host.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TYPE_PREFIX_RE = re.compile(rb'^\s*\{\s*"type"\s*:\s*"([^"\\]*)"')
SKIP_PREFIXES = (
    "# AGENTS.md instructions",
    "<skill>",
)

KNOWN_TERMINAL_SKIP_REASONS = frozenset({
    "no messages",
    "no normalizable messages",
    "noise-bank",
    "already captured",
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


def parse_line(raw: bytes, stats: Dict[str, int]) -> Optional[Dict[str, Any]]:
    # Only fast-reject when the first top-level field is literally type.
    # Other key orders still receive a full JSON parse.
    type_prefix = TYPE_PREFIX_RE.match(raw)
    if type_prefix and type_prefix.group(1) not in (b"user", b"assistant"):
        return None
    try:
        item = json.loads(raw.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeError):
        stats["invalid"] = stats.get("invalid", 0) + 1
        return None
    if not isinstance(item, dict) or item.get("type") not in ("user", "assistant"):
        return None
    role = item["type"]
    message = item.get("message")
    message = message if isinstance(message, dict) else item
    content = message.get("content")
    if isinstance(content, str):
        parts = [content] if content else []
    elif isinstance(content, list):
        parts = [block.get("text") for block in content
                 if isinstance(block, dict) and block.get("type") == "text"
                 and isinstance(block.get("text"), str) and block.get("text")]
    else:
        parts = []
    if not parts:
        return None
    value = "\n".join(parts)
    if role == "user" and should_skip_capture_message(value):
        return None
    native = message.get("id") if role == "assistant" else item.get("uuid")
    if not isinstance(native, str) or not native:
        native = item.get("uuid")
    if not isinstance(native, str) or not native:
        # Stable across retries for older synthetic or unusual transcript lines.
        native = hashlib.sha256(raw).hexdigest()
    out = {"role": role, "content": value, "turnKey": f"claude:{native}",
           "sessionEpoch": "claude-native"}
    if isinstance(item.get("timestamp"), str) and item["timestamp"]:
        out["timestamp"] = item["timestamp"]
    return out


def v1_counted_line(raw: bytes, stats: Dict[str, int]) -> bool:
    """Match the old Python reader's per-line count, without grouping."""
    try:
        item = json.loads(raw.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeError):
        stats["invalid"] = stats.get("invalid", 0) + 1
        return False
    if not isinstance(item, dict) or not isinstance(item.get("message"), dict):
        return False
    return parse_line(raw, stats) is not None


def read_messages(transcript_path: Optional[str]) -> List[Dict[str, Any]]:
    """Legacy test helper; production capture uses bounded byte scans below."""
    result: List[Dict[str, Any]] = []
    if not transcript_path or not Path(transcript_path).exists():
        return result
    with open(transcript_path, "rb") as handle:
        for raw in handle:
            msg = parse_line(raw, {})
            if msg:
                msg["turnIndex"] = len(result)
                result.append(msg)
    return result


def file_identity(path: str) -> Dict[str, Any]:
    stat = os.stat(path)
    with open(path, "rb") as handle:
        prefix = handle.read(1024)
    return {"path": os.path.realpath(path), "dev": stat.st_dev, "inode": stat.st_ino,
            "size": stat.st_size, "headLen": len(prefix),
            "headSha256": hashlib.sha256(prefix).hexdigest()}


def same_head(entry: Dict[str, Any], path: str, size: int) -> bool:
    length = entry.get("headLen", 1024)
    if not isinstance(length, int) or length < 0 or size < length:
        return False
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read(length)).hexdigest() == entry.get("headSha256")


def scan_lines(path: str, offset: int, budget: int, line_cap: int, stats: Dict[str, int]):
    """Yield complete (start, end, raw) lines; budget cuts retry from line start."""
    with open(path, "rb") as handle:
        handle.seek(offset)
        start = offset
        while start - offset < budget:
            remaining = budget - (start - offset)
            raw = handle.readline(min(line_cap + 1, remaining + 1))
            if not raw:
                break
            if len(raw) > line_cap or (len(raw) > remaining and not raw.endswith(b"\n")):
                # A known over-cap line must be discarded through newline even
                # when that extends past this invocation's byte budget.
                if len(raw) > line_cap:
                    while raw and not raw.endswith(b"\n"):
                        raw = handle.readline(65536)
                    if raw.endswith(b"\n"):
                        stats["oversized"] = stats.get("oversized", 0) + 1
                        end = handle.tell()
                        yield start, end, None
                        start = end
                    break
                break
            if not raw.endswith(b"\n") or len(raw) > remaining:
                break
            end = handle.tell()
            yield start, end, raw
            start = end


def _previous_newline(handle, before: int) -> int:
    pos = before
    while pos > 0:
        start = max(0, pos - 65536)
        handle.seek(start)
        found = handle.read(pos - start).rfind(b"\n")
        if found >= 0:
            return start + found
        pos = start
    return -1


def bootstrap_tail(path: str, count: int, line_cap: int, stats: Dict[str, int]):
    """Seek backward by newline; never read more than one capped line at once."""
    if count <= 0:
        return []
    found = []
    seen = set()
    with open(path, "rb") as handle:
        size = os.fstat(handle.fileno()).st_size
        last_newline = _previous_newline(handle, size)
        if last_newline < 0:
            return []
        line_end = last_newline
        while line_end >= 0 and len(found) < count:
            previous = _previous_newline(handle, line_end)
            start = previous + 1
            length = line_end - start
            if 0 < length <= line_cap:
                handle.seek(start)
                msg = parse_line(handle.read(length), stats)
                if msg and msg["turnKey"] not in seen:
                    found.append(msg)
                    seen.add(msg["turnKey"])
            elif length > line_cap:
                stats["oversized"] = stats.get("oversized", 0) + 1
            line_end = previous
    return list(reversed(found))


def assembled(lines, hold_open: bool, last_assistant: str):
    """Last contiguous assistant snapshot wins; return complete groups and held start."""
    groups = []
    current = None
    for start, end, message in lines:
        if not message:
            continue
        if current and current[2]["role"] == "assistant" and message["role"] == "assistant" and current[2]["turnKey"] == message["turnKey"]:
            current = (current[0], end, message)
            continue
        if current:
            groups.append(current)
        current = (start, end, message)
    held = None
    if current:
        if current[2]["role"] == "assistant" and hold_open:
            held = current[0]
        else:
            groups.append(current)
    return groups, held

def should_skip_capture_message(content: str) -> bool:
    """Skip hook-injected instruction payloads that are not user dialogue."""
    stripped = content.lstrip()
    return any(stripped.startswith(prefix) for prefix in SKIP_PREFIXES)


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


def _cursor(identity: Dict[str, Any], offset: int, ordinal: int, keys: List[str], **extra) -> Dict[str, Any]:
    return {"version": 2, "path": identity["path"], "offset": offset,
            "dev": identity["dev"], "inode": identity["inode"],
            "headLen": identity["headLen"], "headSha256": identity["headSha256"],
            "messageOrdinal": ordinal, "recentKeys": keys[-512:], **extra}


def _payload(messages: List[Dict[str, Any]], session_id: str, cwd: str) -> Dict[str, Any]:
    payload = {"messages": messages, "userId": RUNIR_USER_ID, "client": RUNIR_CLIENT}
    if session_id:
        payload["sessionId"] = session_id
    if cwd:
        payload["path"] = cwd
    return payload


def _send(messages: List[Dict[str, Any]], session_id: str, cwd: str) -> bool:
    status, body, raw = post_capture(_payload(messages, session_id, cwd))
    advance, reason = is_successful_response(status, body)
    if advance:
        log(f"ok: session={session_id} new_count={len(messages)} http={status} reason={reason}")
        return True
    snippet = redact_bearer(raw.decode("utf-8", errors="replace"))[:256].replace("\n", " ")
    label = "error_transport" if status == 0 else "error_http_4xx" if status < 500 else "error_http_5xx" if status < 600 else "hold"
    log(f"{label}: session={session_id} http={status:03d} reason={reason or '?'} body={snippet}")
    return False


def _capture(event: Dict[str, Any], flush: bool = False) -> bool:
    session_id = str(event.get("session_id") or "")
    path = str(event.get("transcript_path") or "")
    cwd = str(event.get("cwd") or "")
    last_assistant = str(event.get("last_assistant_message") or "")
    if not session_id:
        return True
    root = Path.home() / ".claude" / "state" / "runir"
    root.mkdir(parents=True, exist_ok=True)
    lock_name = hashlib.sha256(session_id.encode()).hexdigest() + ".lock"
    with (root / lock_name).open("a+b") as lock:
        deadline = time.monotonic() + (RUNIR_SESSION_END_TIMEOUT if flush else 0.25)
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    log(f"skip: session={session_id} reason=lock_contention")
                    return not flush
                time.sleep(0.01)
        try:
            if path and os.path.isfile(path):
                if not _capture_locked(session_id, path, cwd, last_assistant, flush):
                    return False
            elif last_assistant:
                entry = load_entry(session_id)
                digest = fallback_hash(last_assistant)
                if digest != entry.get("lastFallbackHash"):
                    if not _send([{"role": "assistant", "content": last_assistant}], session_id, cwd):
                        return False
                    save_entry(session_id, {**entry, "lastFallbackHash": digest})
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    return True


def _capture_locked(session_id: str, path: str, cwd: str, last_assistant: str, flush: bool) -> bool:
    identity = file_identity(path)
    entry = load_entry(session_id)
    stats: Dict[str, int] = {}
    budget = RUNIR_CAPTURE_READ_BUDGET_BYTES
    size = identity["size"]
    replaced = bool(entry and entry.get("version") == 2 and
                    (size < entry.get("offset", 0) or
                     not same_head(entry, path, size)))
    if not entry or replaced or (entry.get("version") != 2 and int(entry.get("messageCount", 0)) == 0):
        messages = bootstrap_tail(path, RUNIR_CAPTURE_BOOTSTRAP_MESSAGES, RUNIR_CAPTURE_MAX_LINE_BYTES, stats)
        # Bootstrap is a tail-only policy. A replacement is a new native file;
        # local keys and the server's native key both suppress copied-prefix turns.
        keys = list(entry.get("recentKeys", []))[-512:] if replaced else []
        known = set(keys)
        unique = []
        ordinal = int(entry.get("messageOrdinal", 0)) if replaced else 0
        for msg in messages:
            if msg["turnKey"] not in known:
                msg["turnIndex"] = ordinal
                ordinal += 1
                unique.append(msg)
                known.add(msg["turnKey"])
        if unique and not _send(unique, session_id, cwd):
            return False
        fallback_digest = entry.get("lastFallbackHash")
        if not messages and last_assistant:
            digest = fallback_hash(last_assistant)
            if digest != fallback_digest:
                if not _send([{"role": "assistant", "content": last_assistant}], session_id, cwd):
                    return False
                fallback_digest = digest
        keys.extend(m["turnKey"] for m in unique)
        with open(path, "rb") as handle:
            complete_end = _previous_newline(handle, size) + 1
        save_entry(session_id, _cursor(identity, complete_end, ordinal, keys,
                                       lastFallbackHash=fallback_digest))
        log(f"bootstrap: session={session_id} count={len(unique)} offset={complete_end} invalid={stats.get('invalid', 0)}")
        return True
    if entry.get("version") != 2:
        target = max(0, int(entry.get("messageCount", 0)))
        counted = max(0, int(entry.get("v1Counted", 0)))
        scan_offset = max(0, int(entry.get("scanOffset", 0)))
        if counted < target:
            for start, end, raw in scan_lines(path, scan_offset, budget, RUNIR_CAPTURE_MAX_LINE_BYTES, stats):
                scan_offset = end
                if raw and v1_counted_line(raw, stats):
                    counted += 1
                    if counted >= target:
                        break
            budget = max(0, budget - (scan_offset - int(entry.get("scanOffset", 0))))
            if counted < target:
                save_entry(session_id, {**entry, "v1Counted": counted, "scanOffset": scan_offset})
                log(f"migration: session={session_id} counted={counted} target={target} offset={scan_offset}")
                return True
        entry = _cursor(identity, scan_offset, target, [], v1ConsumedOffset=scan_offset,
                        lastFallbackHash=entry.get("lastFallbackHash"))
        save_entry(session_id, entry)
    # A copied file retains the same prefix and cursor even if inode/dev changed.
    if size < entry["offset"]:
        return True
    metadata_changed = (entry.get("dev") != identity["dev"] or
                        entry.get("inode") != identity["inode"] or
                        (entry.get("headLen", 0) < 1024 and size >= 1024))
    if entry.get("headLen", 0) < 1024 and size >= 1024:
        entry = {**entry, "headLen": 1024, "headSha256": identity["headSha256"]}
    if entry.get("dev") != identity["dev"] or entry.get("inode") != identity["inode"]:
        entry = {**entry, "dev": identity["dev"], "inode": identity["inode"]}
    start_offset = max(entry["offset"], entry.get("v1ConsumedOffset", 0))
    lines = [(start, end, parse_line(raw, stats) if raw else None)
             for start, end, raw in scan_lines(path, start_offset, budget,
                                               RUNIR_CAPTURE_MAX_LINE_BYTES, stats)]
    complete_eof = bool(lines and lines[-1][1] >= size)
    groups, held = assembled(lines, not flush and not complete_eof, last_assistant)
    # Even at EOF, an assistant snapshot can still grow. Only the native hook's
    # final text or SessionEnd proves that it is ready to emit.
    if groups and groups[-1][2]["role"] == "assistant" and not flush and groups[-1][2]["content"] != last_assistant:
        last_group = groups.pop()
        held = last_group[0]
    limit = held if held is not None else (lines[-1][1] if lines else start_offset)
    keys = list(entry.get("recentKeys", []))[-512:]
    known = set(keys)
    ordinal = int(entry.get("messageOrdinal", 0))
    batch = []
    batch_end = start_offset
    for start, end, msg in groups:
        if end > limit:
            break
        key = msg["turnKey"]
        if key in known:
            batch_end = end
            continue
        msg["turnIndex"] = ordinal
        ordinal += 1
        batch.append(msg)
        known.add(key)
        keys.append(key)
        batch_end = end
        if len(batch) >= RUNIR_CAPTURE_BATCH_MESSAGES:
            if not _send(batch, session_id, cwd):
                return False
            entry = _cursor(identity, batch_end, ordinal, keys, v1ConsumedOffset=entry.get("v1ConsumedOffset", 0),
                            lastFallbackHash=entry.get("lastFallbackHash"))
            save_entry(session_id, entry)
            batch = []
    if batch and not _send(batch, session_id, cwd):
        return False
    fallback_pending = (not groups and last_assistant and
                        not any(message for _, _, message in lines) and
                        (bool(lines) or start_offset == 0))
    if fallback_pending:
        digest = fallback_hash(last_assistant)
        if digest != entry.get("lastFallbackHash"):
            if not _send([{"role": "assistant", "content": last_assistant}], session_id, cwd):
                return False
            entry = {**entry, "lastFallbackHash": digest}
    # A line without normalizable content still advances, unless a held group
    # starts before it. No successful POST is needed for terminal skips.
    if batch or limit != entry["offset"] or entry.get("dev") != identity["dev"] or fallback_pending or metadata_changed:
        entry = _cursor(identity, limit, ordinal, keys, v1ConsumedOffset=entry.get("v1ConsumedOffset", 0),
                        lastFallbackHash=entry.get("lastFallbackHash"))
        save_entry(session_id, entry)
    if stats:
        log(f"scan: session={session_id} offset={limit} invalid={stats.get('invalid', 0)} oversized={stats.get('oversized', 0)}")
    return True


def main() -> int:
    if not RUNIR_USER_ID:
        return 0
    parser = argparse.ArgumentParser()
    parser.add_argument("--flush", action="store_true")
    parser.add_argument("--session-end-messages", type=int, default=0)
    args = parser.parse_args()
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0
    if args.session_end_messages:
        path = event.get("transcript_path") or ""
        messages = bootstrap_tail(path, min(200, args.session_end_messages),
                                  RUNIR_CAPTURE_MAX_LINE_BYTES, {}) if os.path.isfile(path) else []
        # SessionEnd needs a normalizable body to close an already-captured row.
        # The most recent native turn is safe to replay under its stable key.
        for index, message in enumerate(messages):
            message["turnIndex"] = index
        print(json.dumps(messages))
    else:
        return 0 if _capture(event, flush=args.flush) else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
