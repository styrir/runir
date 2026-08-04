"""Observability: hook call sites write trace kinds; decision JSON unchanged."""

from __future__ import annotations

import io
import json


def test_recall_deliver_sequence_and_capsys_parity(hook, monkeypatch, capsys):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    context = "memory fact alpha"
    digest = hook.content_hash(context)

    def fake_post(url, payload, timeout):
        return 200, {"prependContext": context}

    monkeypatch.setattr(hook, "post_json", fake_post)

    event = {
        "sessionId": "s-obs-1",
        "promptId": "p1",
        "prompt": "what do you know?",
    }
    hook.handle_recall(event)

    # Capture stdout decision bytes from pre_tool_use
    hook.handle_pre_tool_use({"sessionId": "s-obs-1", "promptId": "p1"})
    out1 = capsys.readouterr().out
    assert out1
    decision = json.loads(out1)
    assert decision["decision"] == "deny"
    assert context in decision["reason"]

    # Second deliver path: re-seed undelivered recall for stop
    hook.write_recall_state("s-obs-1", "p2", context, content_hash_value=digest)
    # Clear delivered so consume works — write_recall_state with context sets delivered=False
    hook.handle_stop(
        {
            "sessionId": "s-obs-1",
            "promptId": "p2",
            "reason": "end_turn",
        }
    )
    out2 = capsys.readouterr().out
    stop_decision = json.loads(out2)
    assert (
        "hookSpecificOutput" in stop_decision
        or stop_decision.get("decision") == "block"
    )

    # Trace kinds
    lines = [
        ln
        for ln in hook.trace_path("s-obs-1").read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    kinds = [json.loads(ln)["kind"] for ln in lines]
    assert "recall" in kinds
    assert kinds.count("deliver") >= 2
    channels = [
        json.loads(ln).get("channel")
        for ln in lines
        if json.loads(ln).get("kind") == "deliver"
    ]
    assert "pre_tool_use" in channels
    assert "stop" in channels

    status = hook.read_json_state(hook.status_path("s-obs-1"))
    assert status is not None
    assert status["lastKind"] == "deliver"
    assert status["phase"] == "delivered"
    assert status["counts"]["recall"] >= 1
    assert status["counts"]["deliver"] >= 2

    # Decision payloads must remain valid JSON objects (instrumentation after dump)
    assert json.loads(out1) == decision
    assert "schema" not in out1  # no trace leak on stdout


def test_skip_dedupe_and_no_context(hook, monkeypatch):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    context = "same memory"

    def fake_post(url, payload, timeout):
        return 200, {"prependContext": context}

    monkeypatch.setattr(hook, "post_json", fake_post)
    sid = "s-obs-dedupe"
    hook.remember_delivered_hash(sid, hook.content_hash(context))
    hook.handle_recall({"sessionId": sid, "promptId": "p1", "prompt": "again please"})
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    kinds = [e["kind"] for e in lines]
    assert "recall" in kinds
    assert "skip" in kinds
    skip = next(e for e in lines if e["kind"] == "skip")
    assert skip["reason"] == "dedupe"

    # empty context path
    def empty_post(url, payload, timeout):
        return 200, {"prependContext": ""}

    monkeypatch.setattr(hook, "post_json", empty_post)
    sid2 = "s-obs-empty"
    hook.handle_recall({"sessionId": sid2, "promptId": "p2", "prompt": "nothing here"})
    lines2 = [
        json.loads(ln)
        for ln in hook.trace_path(sid2).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    skips = [e for e in lines2 if e["kind"] == "skip"]
    assert any(e.get("reason") == "no_context" for e in skips)


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
                    # Runtime event name matches main()'s snake_case branch.
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
