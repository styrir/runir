"""Capture watermark for incremental message slicing.

Stores per-session message counts in ~/.codex/runir/capture-watermarks.json.
Atomic writes via temp-file-then-rename. Last-writer-wins in v1.
"""

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

WATERMARK_DIR = os.path.join(os.path.expanduser("~"), ".codex", "runir")
_WATERMARK_FILENAME = "capture-watermarks.json"


def _watermark_path() -> Path:
    return Path(WATERMARK_DIR) / _WATERMARK_FILENAME


def _read_all() -> Dict:
    path = _watermark_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _write_all(data: Dict) -> None:
    dir_path = Path(WATERMARK_DIR)
    dir_path.mkdir(parents=True, exist_ok=True)

    target = _watermark_path()
    fd, tmp_path = tempfile.mkstemp(dir=str(dir_path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp_path, str(target))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _load_entry(data: Dict, session_id: str) -> Dict:
    entry = data.get(session_id)
    return entry if isinstance(entry, dict) else {}


def load_watermark(session_id: str) -> int:
    data = _read_all()
    entry = _load_entry(data, session_id)
    count = entry.get("messageCount", 0)
    return count if isinstance(count, int) and count >= 0 else 0


def load_fallback_hash(session_id: str) -> Optional[str]:
    data = _read_all()
    entry = _load_entry(data, session_id)
    value = entry.get("lastFallbackHash")
    return value if isinstance(value, str) and value else None


def save_watermark(session_id: str, message_count: int) -> None:
    data = _read_all()
    entry = _load_entry(data, session_id)
    data[session_id] = {
        "messageCount": message_count,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "lastFallbackHash": entry.get("lastFallbackHash"),
    }
    _write_all(data)


def save_fallback_hash(session_id: str, fallback_hash: str) -> None:
    data = _read_all()
    entry = _load_entry(data, session_id)
    message_count = entry.get("messageCount", 0)
    data[session_id] = {
        "messageCount": message_count if isinstance(message_count, int) and message_count >= 0 else 0,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "lastFallbackHash": fallback_hash,
    }
    _write_all(data)
