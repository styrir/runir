"""Observability: hook call sites write trace kinds; no deny/deliver stdout."""

from __future__ import annotations

import io
import json


def test_ups_prompt_only_trace_and_empty_stdout(hook, monkeypatch, capsys):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    posts = []

    def fake_post(url, payload, timeout):
        posts.append(url)
        return 200, {"prependContext": "should not be fetched"}

    monkeypatch.setattr(hook, "post_json", fake_post)

    event = {
        "sessionId": "s-obs-1",
        "promptId": "p1",
        "prompt": "what do you know?",
    }
    hook.handle_recall(event)
    assert posts == []

    # PreToolUse retired — no deny JSON even if invoked directly via main.
    import sys

    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "hookEventName": "pre_tool_use",
                    "sessionId": "s-obs-1",
                    "promptId": "p1",
                    "toolName": "Bash",
                }
            )
        ),
    )
    assert hook.main() == 0
    assert capsys.readouterr().out.strip() == ""

    # Stop is capture-only.
    monkeypatch.setattr(hook, "detach_capture", lambda e: None)
    hook.handle_stop(
        {
            "sessionId": "s-obs-1",
            "promptId": "p2",
            "reason": "end_turn",
        }
    )
    assert capsys.readouterr().out.strip() == ""

    lines = [
        ln
        for ln in hook.trace_path("s-obs-1").read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    kinds = [json.loads(ln)["kind"] for ln in lines]
    assert "skip" in kinds
    assert "deliver" not in kinds
    assert "recall" not in kinds  # no HTTP recall event on TUI UPS
    skips = [json.loads(ln) for ln in lines if json.loads(ln).get("kind") == "skip"]
    assert any(s.get("reason") == "prompt_only" for s in skips)

    status = hook.read_json_state(hook.status_path("s-obs-1"))
    assert status is not None
    assert status["lastKind"] == "skip"


def test_empty_prompt_skip(hook, monkeypatch):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    sid = "s-obs-empty"
    hook.handle_recall({"sessionId": sid, "promptId": "p2", "prompt": "   "})
    lines2 = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    skips = [e for e in lines2 if e["kind"] == "skip"]
    assert any(e.get("reason") == "empty_prompt" for e in skips)


def test_error_event_on_handler_exception(hook, monkeypatch):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")

    def boom(event):
        raise RuntimeError("boom")

    monkeypatch.setattr(hook, "handle_recall", boom)
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(
            json.dumps(
                {
                    "hookEventName": "user_prompt_submit",
                    "sessionId": "s-err",
                    "prompt": "x",
                }
            )
        ),
    )
    assert hook.main() == 0
    path = hook.trace_path("s-err")
    assert path is not None and path.is_file()
    events = [
        json.loads(ln)
        for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert any(e["kind"] == "error" and e.get("type") == "RuntimeError" for e in events)
