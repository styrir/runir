"""Observability: runir_watch.py --mode once is read-only and exits 0."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import load_script_module  # noqa: E402


def _digest(sid: str) -> str:
    return hashlib.sha256(sid.encode("utf-8")).hexdigest()


def test_watch_once_snapshot_read_only(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    sid = "watch-sess"
    d = _digest(sid)
    status = {
        "schema": 1,
        "updatedAt": "2026-07-31T12:00:00.000Z",
        "phase": "recall",
        "lastKind": "recall",
        "counts": {"recall": 1, "deliver": 0, "skip": 0, "capture": 0, "error": 0},
    }
    status_path = state / f"status-{d}.json"
    trace_path = state / f"trace-{d}.jsonl"
    status_path.write_text(json.dumps(status), encoding="utf-8")
    trace_path.write_text(
        json.dumps(
            {
                "schema": 1,
                "at": "2026-07-31T12:00:00.000Z",
                "ms": 1,
                "kind": "recall",
                "contextChars": 4,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    before = {
        p.name: (p.stat().st_mtime_ns, p.stat().st_size)
        for p in state.iterdir()
        if p.is_file()
    }
    listing = sorted(p.name for p in state.iterdir())

    mod = load_script_module("runir_watch.py")
    old = sys.argv
    try:
        sys.argv = [
            "runir_watch.py",
            "--mode",
            "once",
            "--state-dir",
            str(state),
            "--digest",
            d,
        ]
        import io
        from contextlib import redirect_stdout, redirect_stderr

        buf = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(err):
            code = mod.main()
        out = buf.getvalue()
    finally:
        sys.argv = old

    assert code == 0
    assert "phase=recall" in out
    assert "recall" in out

    after_listing = sorted(p.name for p in state.iterdir())
    assert after_listing == listing
    after = {
        p.name: (p.stat().st_mtime_ns, p.stat().st_size)
        for p in state.iterdir()
        if p.is_file()
    }
    assert after == before
