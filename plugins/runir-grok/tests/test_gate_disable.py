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


def test_gate_unset_pre_tool_use_never_denies(hook, monkeypatch, capsys):
    """Control (Rúnir-ysk): with gate env unset, PreToolUse still emits no deny."""
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-gate")
    monkeypatch.delenv("RUNIR_GROK_DISABLE_GATE", raising=False)
    sid = "s-gate-on"
    hook.write_recall_state(
        sid,
        "p1",
        "seeded-memory-for-deny",
        content_hash_value=hook.content_hash("seeded-memory-for-deny"),
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
    assert out.strip() == ""
    assert "deny" not in out


def test_gate_disable_requires_exact_one(hook, monkeypatch, capsys):
    """Truthiness is exactly '1' (RUNIR_DEBUG idiom), not other truthy strings.

    With 'true' the gate is not disabled, but PreToolUse still must not deny
    (transport retired). UPS may write state — only assert no deny stdout.
    """
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-gate")
    monkeypatch.setenv("RUNIR_GROK_DISABLE_GATE", "true")
    sid = "s-gate-truthy"
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
    assert "deny" not in out
