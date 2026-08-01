"""Observability: deliver events self-attribute promptId from recall state."""

from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import load_script_module  # noqa: E402


def test_prefers_event_prompt_id(hook):
    sid = "s-pref-event"
    digest = hook.content_hash("ctx")
    hook.write_recall_state(sid, "p-state", "ctx", content_hash_value=digest)
    got = hook.deliver_prompt_id({"sessionId": sid, "promptId": "p-event"}, sid, digest)
    assert got == "p-event"


def test_falls_back_to_recall_state(hook):
    sid = "s-fallback"
    ctx = "memory from recall"
    digest = hook.content_hash(ctx)
    hook.write_recall_state(sid, "p-1", ctx, content_hash_value=digest)
    claimed = hook.consume_recall({"sessionId": sid})
    assert claimed == ctx
    got = hook.deliver_prompt_id({"sessionId": sid, "promptId": ""}, sid, digest)
    assert got == "p-1"


def test_none_when_state_missing(hook):
    got = hook.deliver_prompt_id(
        {"sessionId": "unknown-sid", "promptId": ""}, "unknown-sid", "deadbeef"
    )
    assert got is None


def test_none_on_unreadable_state(hook):
    sid = "s-corrupt"
    path = hook.recall_state_path(sid)
    assert path is not None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not-json{{{")
    got = hook.deliver_prompt_id({"sessionId": sid, "promptId": ""}, sid, "abc")
    assert got is None


def test_rejects_content_hash_mismatch(hook):
    sid = "s-mismatch"
    digest = hook.content_hash("delivered-ctx")
    hook.write_recall_state(
        sid, "p-new", "newer-turn-ctx", content_hash_value="otherhash"
    )
    got = hook.deliver_prompt_id({"sessionId": sid, "promptId": ""}, sid, digest)
    assert got is None


def test_accepts_state_without_content_hash(hook):
    sid = "s-legacy"
    path = hook.recall_state_path(sid)
    assert path is not None
    hook.write_json_state(
        path,
        {
            "promptId": "p-legacy",
            "context": "legacy ctx",
            "delivered": True,
            "updatedAt": 1.0,
        },
    )
    got = hook.deliver_prompt_id({"sessionId": sid, "promptId": ""}, sid, "any-digest")
    assert got == "p-legacy"


def test_pre_tool_use_deliver_event_carries_prompt_id(hook):
    sid = "s-ptu-deliver"
    ctx = "ptu context payload"
    digest = hook.content_hash(ctx)
    hook.write_recall_state(sid, "p-1", ctx, content_hash_value=digest)
    buf = io.StringIO()
    with redirect_stdout(buf):
        hook.handle_pre_tool_use({"sessionId": sid, "promptId": ""})
    decision = json.loads(buf.getvalue())
    assert decision["decision"] == "deny"
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    deliver = next(e for e in lines if e.get("kind") == "deliver")
    assert deliver["promptId"] == "p-1"
    assert deliver["hash12"] == digest[:12]
    assert deliver["channel"] == "pre_tool_use"


def test_stop_deliver_event_carries_prompt_id(hook):
    sid = "s-stop-deliver"
    ctx = "stop context payload"
    digest = hook.content_hash(ctx)
    hook.write_recall_state(sid, "p-1", ctx, content_hash_value=digest)
    buf = io.StringIO()
    with redirect_stdout(buf):
        hook.handle_stop({"sessionId": sid, "reason": "end_turn", "promptId": ""})
    decision = json.loads(buf.getvalue())
    assert decision["decision"] == "block"
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    deliver = next(e for e in lines if e.get("kind") == "deliver")
    assert deliver["promptId"] == "p-1"
    assert deliver["hash12"] == digest[:12]
    assert deliver["channel"] == "stop"


def test_session_groups_deliver_under_prompt_id(hook):
    """Regression: recall+deliver with same promptId → one turn, no _none."""
    import hashlib
    import sys
    from contextlib import redirect_stderr

    sid = "s-group"
    ctx = "grouped memory"
    digest = hook.content_hash(ctx)
    hook.write_recall_state(sid, "p-group", ctx, content_hash_value=digest)
    hook.record_event(
        sid,
        "recall",
        promptId="p-group",
        hash12=digest[:12],
        contextChars=len(ctx),
    )
    buf = io.StringIO()
    with redirect_stdout(buf):
        hook.handle_pre_tool_use({"sessionId": sid, "promptId": ""})

    inspect = load_script_module("runir_inspect.py")
    d = hashlib.sha256(sid.encode("utf-8")).hexdigest()
    old = sys.argv
    try:
        sys.argv = [
            "runir_inspect.py",
            "session",
            "--state-dir",
            str(hook.STATE_DIR),
            "--digest",
            d,
            "--json",
        ]
        out = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = inspect.main()
        assert code == 0, out.getvalue() + err.getvalue()
        data = json.loads(out.getvalue())
    finally:
        sys.argv = old

    assert data["eventCount"] >= 2
    turns = data["turns"]
    assert len(turns) == 1
    assert turns[0]["promptId"] == "p-group"
    assert all(t["promptId"] != "_none" for t in turns)
    kinds = [e["kind"] for e in turns[0]["events"]]
    assert "recall" in kinds
    assert "deliver" in kinds


def test_deliver_trace_still_has_no_secrets(hook):
    sid = "s-no-secrets"
    ctx = "super secret recalled memory never in trace"
    digest = hook.content_hash(ctx)
    hook.write_recall_state(sid, "p-sec", ctx, content_hash_value=digest)
    buf = io.StringIO()
    with redirect_stdout(buf):
        hook.handle_pre_tool_use({"sessionId": sid, "promptId": ""})
    raw = hook.trace_path(sid).read_bytes()
    assert ctx.encode("utf-8") not in raw
    assert sid.encode("utf-8") not in raw
    # promptId is an opaque id (allowed), but context and raw session id must not leak
    assert b"p-sec" in raw
