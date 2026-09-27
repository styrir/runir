"""Locked, atomic per-session Claude Code capture cursors."""

import fcntl
import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

WATERMARK_DIR = os.path.join(os.path.expanduser("~"), ".claude", "state", "runir")
_WATERMARK_FILENAME = "capture-watermarks.json"


def _watermark_path() -> Path:
    return Path(WATERMARK_DIR) / _WATERMARK_FILENAME


@contextmanager
def _global_lock():
    root = Path(WATERMARK_DIR)
    root.mkdir(parents=True, exist_ok=True)
    with (root / "capture-watermarks.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _read_all() -> Dict:
    try:
        data = json.loads(_watermark_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (ValueError, OSError):
        return {}


def _write_all(data: Dict) -> None:
    root = Path(WATERMARK_DIR)
    fd, tmp = tempfile.mkstemp(dir=str(root), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.replace(tmp, _watermark_path())
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_entry(session_id: str) -> Dict:
    with _global_lock():
        entry = _read_all().get(session_id)
        return dict(entry) if isinstance(entry, dict) else {}


def save_entry(session_id: str, entry: Dict) -> None:
    with _global_lock():
        data = _read_all()
        data[session_id] = {**entry, "updatedAt": datetime.now(timezone.utc).isoformat()}
        _write_all(data)


# Compatibility for existing hook tests and v1 state. The capture path uses
# load_entry/save_entry and never resets its native identity on compaction.
def load_watermark(session_id: str) -> int:
    value = load_entry(session_id).get("messageCount", 0)
    return value if isinstance(value, int) and value >= 0 else 0


def load_epoch(session_id: str) -> int:
    value = load_entry(session_id).get("sessionEpoch", 0)
    return value if isinstance(value, int) and value >= 0 else 0


def bump_epoch(session_id: str) -> int:
    entry = load_entry(session_id)
    epoch = load_epoch(session_id) + 1
    save_entry(session_id, {**entry, "messageCount": 0, "sessionEpoch": epoch})
    return epoch


def load_fallback_hash(session_id: str) -> Optional[str]:
    value = load_entry(session_id).get("lastFallbackHash")
    return value if isinstance(value, str) and value else None


def save_watermark(session_id: str, message_count: int) -> None:
    entry = load_entry(session_id)
    save_entry(session_id, {**entry, "messageCount": message_count})


def save_fallback_hash(session_id: str, fallback_hash: str) -> None:
    entry = load_entry(session_id)
    save_entry(session_id, {**entry, "lastFallbackHash": fallback_hash})
