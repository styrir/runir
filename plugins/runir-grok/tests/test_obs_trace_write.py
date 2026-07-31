"""Observability: trace/status primitives (ring, atomic status, fail-open, no secrets)."""

from __future__ import annotations

import json


def test_append_trace_one_object_per_line(hook):
    sid = "sess-trace-1"
    hook.record_event(
        sid, "recall", contextChars=12, hash12="abcdef012345", durationMs=5
    )
    path = hook.trace_path(sid)
    assert path is not None and path.is_file()
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 1
    obj = json.loads(lines[0])
    assert obj["schema"] == 1
    assert obj["kind"] == "recall"
    assert obj["contextChars"] == 12
    assert obj["hash12"] == "abcdef012345"
    assert "prompt" not in obj
    assert "context" not in obj


def test_status_atomic_and_counts(hook):
    sid = "sess-status-1"
    hook.record_event(sid, "recall", contextChars=3)
    hook.record_event(
        sid, "deliver", channel="stop", contextChars=3, hash12="aabbccddeeff"
    )
    status = hook.read_json_state(hook.status_path(sid))
    assert status is not None
    assert status["schema"] == 1
    assert status["lastKind"] == "deliver"
    assert status["phase"] == "delivered"
    assert status["counts"]["recall"] == 1
    assert status["counts"]["deliver"] == 1
    assert status["hash12"] == "aabbccddeeff"


def test_ring_trims_to_trace_limit(hook, monkeypatch):
    monkeypatch.setattr(hook, "TRACE_LIMIT", 5)
    sid = "sess-ring"
    for i in range(10):
        hook.record_event(sid, "recall", contextChars=i, durationMs=i)
    path = hook.trace_path(sid)
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    # Hard cap: never more than TRACE_LIMIT after any append.
    assert len(lines) == 5
    assert json.loads(lines[-1])["contextChars"] == 9
    assert [json.loads(ln)["contextChars"] for ln in lines] == [5, 6, 7, 8, 9]


def test_fail_open_unwritable_state_dir(hook, monkeypatch, tmp_path):
    bad = tmp_path / "nope"
    # Point STATE_DIR at a file so mkdir/open fails open.
    bad.write_text("not-a-dir", encoding="utf-8")
    monkeypatch.setattr(hook, "STATE_DIR", bad)
    assert hook.record_event("s1", "error", where="test", type="RuntimeError") is None


def test_no_secrets_in_trace_bytes(hook):
    sid = "sess-secret"
    secret_prompt = "SUPER_SECRET_PROMPT_XYZ"
    secret_ctx = "RECALLED_CONTEXT_SHOULD_NOT_APPEAR"
    # Instrumentation must never accept content fields — only metadata.
    hook.record_event(
        sid,
        "recall",
        contextChars=len(secret_ctx),
        hash12=hook.content_hash(secret_ctx)[:12],
        durationMs=1,
    )
    hook.record_event(
        sid,
        "deliver",
        channel="pre_tool_use",
        contextChars=len(secret_ctx),
        hash12=hook.content_hash(secret_ctx)[:12],
    )
    raw = b""
    for path in hook.STATE_DIR.iterdir():
        if path.is_file() and not path.name.endswith(".lock"):
            raw += path.read_bytes()
    assert secret_prompt.encode() not in raw
    assert secret_ctx.encode() not in raw
    assert (
        sid.encode() not in raw
    )  # digest-only filenames; body must not store plaintext sid
