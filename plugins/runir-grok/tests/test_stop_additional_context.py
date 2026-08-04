"""Rúnir-ghe.2: Stop delivers via hookSpecificOutput.additionalContext by default."""

from __future__ import annotations

import io
import json
import sys


def test_default_stop_additional_context(hook, monkeypatch):
    sid = "sess-stop-ac"
    ctx = "stop memory body"
    hook.write_recall_state(sid, "p1", ctx, content_hash_value=hook.content_hash(ctx))
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    # ensure default mode
    monkeypatch.delenv("RUNIR_GROK_STOP_MODE", raising=False)
    hook.handle_stop({"sessionId": sid, "reason": "end_turn", "promptId": "p1"})
    out = json.loads(buf.getvalue())
    assert "decision" not in out
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "Stop"
    assert hso["additionalContext"].startswith(hook.RECALL_FEEDBACK_PREFIX)
    assert ctx in hso["additionalContext"]
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    deliver = next(e for e in lines if e.get("kind") == "deliver")
    assert deliver.get("mode") == "additional_context"
    assert deliver.get("channel") == "stop"


def test_stop_mode_block_legacy(hook, monkeypatch):
    monkeypatch.setenv("RUNIR_GROK_STOP_MODE", "block")
    sid = "sess-stop-block"
    ctx = "legacy block body"
    hook.write_recall_state(sid, "p1", ctx, content_hash_value=hook.content_hash(ctx))
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    hook.handle_stop({"sessionId": sid, "reason": "end_turn", "promptId": "p1"})
    out = json.loads(buf.getvalue())
    assert out["decision"] == "block"
    assert ctx in out["reason"]
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    deliver = next(e for e in lines if e.get("kind") == "deliver")
    assert deliver.get("mode") == "block"


def test_stop_hook_active_still_detaches_capture(hook, monkeypatch):
    calls = []
    monkeypatch.setattr(hook, "detach_capture", lambda e: calls.append("cap"))
    sid = "sess-stop-active2"
    hook.write_recall_state(sid, "p1", "ctx", content_hash_value=hook.content_hash("ctx"))
    path = hook.recall_state_path(sid)
    state = hook.read_json_state(path)
    state["delivered"] = False
    hook.write_json_state(path, state)
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    hook.handle_stop(
        {
            "sessionId": sid,
            "reason": "end_turn",
            "promptId": "p1",
            "stopHookActive": True,
        }
    )
    assert buf.getvalue().strip() == ""
    assert calls == ["cap"]
