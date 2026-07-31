"""RUNIR_GROK_DISABLE_GATE=1 full no-op of hook main() for all events."""

from __future__ import annotations

import io
import json
import pytest

EVENTS = (
    "user_prompt_submit",
    "pre_tool_use",
    "stop",
)


@pytest.mark.parametrize("event_name", EVENTS)
def test_gate_disable_inert_for_event(hook, monkeypatch, capsys, event_name):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-gate")
    monkeypatch.setenv("RUNIR_GROK_DISABLE_GATE", "1")
    # Would write state / emit deny if handlers ran.
    event = {
        "hookEventName": event_name,
        "sessionId": "s-gate-off",
        "promptId": "p1",
        "prompt": "remember this",
        "reason": "end_turn",
        "toolName": "Bash",
    }
    import sys as real_sys

    monkeypatch.setattr(
        real_sys,
        "stdin",
        io.StringIO(json.dumps(event)),
    )
    before = set(hook.STATE_DIR.iterdir()) if hook.STATE_DIR.exists() else set()
    code = hook.main()
    captured = capsys.readouterr()
    assert code == 0
    assert captured.out == ""
    after = set(hook.STATE_DIR.iterdir()) if hook.STATE_DIR.exists() else set()
    assert after == before


def test_gate_unset_pre_tool_use_still_denies(hook, monkeypatch, capsys):
    """Control: with env unset, deny path still emits JSON (not over-suppressed)."""
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-gate")
    monkeypatch.delenv("RUNIR_GROK_DISABLE_GATE", raising=False)
    # Seed pending recall so pre_tool_use has something to deliver.
    sid = "s-gate-on"
    context = "seeded-memory-for-deny"
    hook.write_recall_state(
        sid,
        "p1",
        context,
        content_hash_value=hook.content_hash(context),
    )
    event = {
        "hookEventName": "pre_tool_use",
        "sessionId": sid,
        "promptId": "p1",
        "toolName": "Bash",
    }
    import sys as real_sys

    monkeypatch.setattr(real_sys, "stdin", io.StringIO(json.dumps(event)))
    code = hook.main()
    out = capsys.readouterr().out
    assert code == 0
    body = json.loads(out)
    assert body["decision"] == "deny"
    assert context in body["reason"]
    assert hook.RECALL_FEEDBACK_PREFIX in body["reason"]


def test_gate_disable_requires_exact_one(hook, monkeypatch, capsys):
    """Truthiness is exactly '1' (RUNIR_DEBUG idiom), not other truthy strings."""
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-gate")
    monkeypatch.setenv("RUNIR_GROK_DISABLE_GATE", "true")
    sid = "s-gate-truthy"
    context = "still-delivered"
    hook.write_recall_state(
        sid,
        "p2",
        context,
        content_hash_value=hook.content_hash(context),
    )
    import sys as real_sys

    monkeypatch.setattr(
        real_sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "hookEventName": "pre_tool_use",
                    "sessionId": sid,
                    "promptId": "p2",
                    "toolName": "Bash",
                }
            )
        ),
    )
    code = hook.main()
    out = capsys.readouterr().out
    assert code == 0
    assert "deny" in out
