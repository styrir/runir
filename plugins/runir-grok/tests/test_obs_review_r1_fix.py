"""Regression for review r1 blocking+major (ordering, ring, watch, scope, errors, promptId, RMW)."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock


sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import load_script_module  # noqa: E402


def _digest(sid: str) -> str:
    return hashlib.sha256(sid.encode("utf-8")).hexdigest()


def test_stop_capture_only_no_stdout_transport(hook, monkeypatch, capsys):
    """Rúnir-ysk: Stop never emits memory decision JSON (capture-only)."""
    called = []
    monkeypatch.setattr(hook, "detach_capture", lambda e: called.append("cap"))
    hook.write_recall_state("sess-flush", "p-flush", "flush-before-lock")
    hook.handle_stop(
        {
            "sessionId": "sess-flush",
            "promptId": "p-flush",
            "reason": "end_turn",
        }
    )
    assert capsys.readouterr().out.strip() == ""
    assert called == ["cap"]


def test_ring_hard_cap_never_exceeds_trace_limit(hook, monkeypatch):
    """Blocking: no soft-max band of TRACE_LIMIT+1 .. SOFT_MAX events."""
    monkeypatch.setattr(hook, "TRACE_LIMIT", 3)
    sid = "sess-hard-cap"
    for i in range(8):
        hook.record_event(sid, "recall", contextChars=i)
        path = hook.trace_path(sid)
        n = len(
            [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        )
        assert n <= 3, f"after event {i}: len={n}"
    lines = [
        ln
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert len(lines) == 3
    assert [json.loads(ln)["contextChars"] for ln in lines] == [5, 6, 7]


def test_watch_inode_rotation_no_full_ring_replay(tmp_path):
    """Major r2: ring rewrite via os.replace must not reprint retained lines.

    After TRACE_LIMIT trim, each os.replace yields a new inode. Resetting the
    byte offset to 0 re-tails the whole ring every poll. Fingerprint the last
    seen line and emit only lines after it; aged-out marker → seek-to-end.
    """
    mod = load_script_module("runir_watch.py")
    state = tmp_path / "state"
    state.mkdir()
    d = "abc123digest"
    path = state / f"trace-{d}.jsonl"
    line_recall = json.dumps({"schema": 1, "kind": "recall", "ms": 1})
    line_deliver = json.dumps({"schema": 1, "kind": "deliver", "ms": 2})
    line_capture = json.dumps({"schema": 1, "kind": "capture", "ms": 3})
    path.write_text(line_recall + "\n", encoding="utf-8")
    ino1 = path.stat().st_ino
    size1 = path.stat().st_size
    last_seen = line_recall

    # Simulate ring rewrite: retain prior + new event via temp + os.replace.
    temporary = path.with_name(f".{path.name}.tmp")
    retained = line_recall + "\n" + line_deliver + "\n"
    temporary.write_text(retained, encoding="utf-8")
    os.replace(temporary, path)
    ino2 = path.stat().st_ino
    size2 = path.stat().st_size
    assert ino2 != ino1 or size2 != size1  # rewritten

    last_trace_size = size1
    last_trace_ino = ino1
    ts = mod.file_size(path)
    ino = mod.file_inode(path)
    rotated = ts < last_trace_size or (
        last_trace_ino is not None and ino is not None and ino != last_trace_ino
    )
    assert rotated
    all_lines = mod.read_all_nonempty_lines(path)
    new_lines = mod.lines_after_marker(all_lines, last_seen)
    kinds = [e["kind"] for e in mod.parse_events(new_lines)]
    # Only the post-marker event — not a full-ring replay of recall.
    assert kinds == ["deliver"]
    assert "recall" not in kinds

    # Second rotation after marker ages out of ring → seek-to-end, empty.
    temporary.write_text(line_capture + "\n", encoding="utf-8")
    os.replace(temporary, path)
    all2 = mod.read_all_nonempty_lines(path)
    # last_seen still recall (aged out of ring)
    assert mod.lines_after_marker(all2, last_seen) == []
    # after advancing marker to deliver, capture-only rewrite still empty
    assert mod.lines_after_marker(all2, line_deliver) == []
    # true new line after marker prints
    all3 = [line_deliver, line_capture]
    assert [
        e["kind"] for e in mod.parse_events(mod.lines_after_marker(all3, line_deliver))
    ] == ["capture"]


def test_bare_errors_captures_scan_all_sessions(tmp_path):
    """Major: bare errors/captures must not pin latest_digest only."""
    mod = load_script_module("runir_inspect.py")
    state = tmp_path / "state"
    state.mkdir()
    d1, d2 = _digest("s1"), _digest("s2")
    for d, where in ((d1, "h1"), (d2, "h2")):
        (state / f"trace-{d}.jsonl").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "at": "2026-07-31T00:00:00.000Z",
                    "ms": 1,
                    "kind": "error",
                    "where": where,
                    "type": "RuntimeError",
                }
            )
            + "\n"
            + json.dumps(
                {
                    "schema": 1,
                    "at": "2026-07-31T00:00:01.000Z",
                    "ms": 2,
                    "kind": "capture",
                    "status": "done",
                    "messages": 1,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (state / f"capture-{d}.json").write_text(
            json.dumps({"status": "done", "token": "t" * 16, "updatedAt": 1.0}),
            encoding="utf-8",
        )
        (state / f"status-{d}.json").write_text(
            json.dumps({"schema": 1, "phase": "error", "counts": {}}),
            encoding="utf-8",
        )
    # Touch d2 later so latest would be d2 if wrongly pinned.
    os.utime(state / f"status-{d2}.json", None)

    old = sys.argv
    try:
        import io as _io
        from contextlib import redirect_stdout, redirect_stderr

        for cmd in ("errors", "captures"):
            sys.argv = ["runir_inspect.py", cmd, "--state-dir", str(state), "--json"]
            buf, err = _io.StringIO(), _io.StringIO()
            with redirect_stdout(buf), redirect_stderr(err):
                code = mod.main()
            assert code == 0, err.getvalue()
            data = json.loads(buf.getvalue())
            if cmd == "errors":
                wheres = {e.get("where") for e in data["errors"]}
                assert wheres == {"h1", "h2"}
            else:
                digests = {m["digest"] for m in data["markers"]}
                assert digests == {d1, d2}
    finally:
        sys.argv = old


def test_tui_ups_never_calls_recall_http(hook, monkeypatch):
    """Rúnir-ysk: TUI UPS is prompt-only — post_json unused even on failure mocks."""
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    sid = "sess-http-err"
    posts = []

    def boom(*a, **k):
        posts.append(1)
        return None

    monkeypatch.setattr(hook, "post_json", boom)
    hook.handle_recall(
        {"sessionId": sid, "promptId": "p-net", "prompt": "hello network"}
    )
    assert posts == []
    events = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert any(e.get("reason") == "prompt_only" for e in events if e["kind"] == "skip")
    assert not any(e["kind"] == "error" for e in events)


def test_capture_and_handler_error_include_prompt_id(hook, monkeypatch):
    """Major: capture + main-handler error carry promptId for multi-turn grouping."""
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    sid = "sess-pid"
    pid = "prompt-capture-1"
    monkeypatch.setattr(hook, "current_turn_messages", lambda e: [])
    hook.handle_capture(
        {"sessionId": sid, "promptId": pid, "reason": "end_turn"},
        sid,
        "tok1",
    )
    events = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    cap = next(e for e in events if e["kind"] == "capture")
    assert cap.get("promptId") == pid

    # Handler exception path via main()
    monkeypatch.setattr(hook, "handle_recall", MagicMock(side_effect=ValueError("x")))
    stdin = io.StringIO(
        json.dumps(
            {
                "hookEventName": "user_prompt_submit",
                "sessionId": sid,
                "promptId": "prompt-main-err",
                "prompt": "x",
            }
        )
    )
    monkeypatch.setattr(sys, "stdin", stdin)
    assert hook.main() == 0
    events2 = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    errs = [
        e for e in events2 if e["kind"] == "error" and e.get("type") == "ValueError"
    ]
    assert errs
    assert errs[-1].get("promptId") == "prompt-main-err"


def test_status_rmw_under_lock_preserves_counts(hook):
    """Major: concurrent record_event must not lose status count increments."""
    sid = "sess-rmw"
    n = 40
    barrier = threading.Barrier(n)

    def worker(kind: str) -> None:
        barrier.wait()
        hook.record_event(sid, kind)

    threads = [
        threading.Thread(target=worker, args=(("recall" if i % 2 == 0 else "deliver"),))
        for i in range(n)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    status = hook.read_json_state(hook.status_path(sid))
    assert status is not None
    assert status["counts"]["recall"] + status["counts"]["deliver"] == n
    assert status["counts"]["recall"] == n // 2
    assert status["counts"]["deliver"] == n // 2
    lines = [
        ln
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert len(lines) == n
