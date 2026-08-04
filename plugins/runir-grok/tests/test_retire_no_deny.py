"""Rúnir-ysk: TUI never denies tools / never Stop-transports memory.

Proves the retired PreToolUse deny gate and Stop additionalContext/block
transports are gone; UPS is prompt-only (no /hooks/recall HTTP); user MEMORY.md
content outside bridge markers is preserved across bridge ops.
"""

from __future__ import annotations

import io
import json
import sys
from unittest.mock import MagicMock


def test_pre_tool_use_emits_no_deny(hook, monkeypatch, capsys):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-retire")
    monkeypatch.delenv("RUNIR_GROK_DISABLE_GATE", raising=False)
    sid = "s-retire-ptu"
    # Even with leftover pending context in state, PTU must not deny.
    hook.write_recall_state(
        sid,
        "p1",
        "should-not-be-delivered",
        delivered=False,
        prompt="hello",
    )
    event = {
        "hookEventName": "pre_tool_use",
        "sessionId": sid,
        "promptId": "p1",
        "toolName": "Bash",
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(event)))
    code = hook.main()
    out = capsys.readouterr().out
    assert code == 0
    assert out.strip() == ""
    assert "deny" not in out
    assert "decision" not in out


def test_stop_emits_no_memory_transport(hook, monkeypatch, capsys):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-retire")
    monkeypatch.delenv("RUNIR_GROK_DISABLE_GATE", raising=False)
    sid = "s-retire-stop"
    hook.write_recall_state(
        sid,
        "p1",
        "pending memory should not reach Stop stdout",
        delivered=False,
        prompt="q",
    )
    # Avoid real fork; capture path is out of this unit's concern.
    monkeypatch.setattr(hook, "detach_capture", lambda _e: None)
    event = {
        "hookEventName": "stop",
        "sessionId": sid,
        "promptId": "p1",
        "reason": "end_turn",
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(event)))
    code = hook.main()
    out = capsys.readouterr().out
    assert code == 0
    assert out.strip() == ""
    assert "additionalContext" not in out
    assert "block" not in out
    assert "deny" not in out


def test_handle_stop_capture_only_no_stdout(hook, monkeypatch, capsys):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-retire")
    called = {"n": 0}

    def fake_detach(event):
        called["n"] += 1

    monkeypatch.setattr(hook, "detach_capture", fake_detach)
    hook.handle_stop(
        {
            "sessionId": "s-stop-only",
            "reason": "end_turn",
            "promptId": "p1",
        }
    )
    assert called["n"] == 1
    assert capsys.readouterr().out == ""


def test_ups_prompt_only_no_recall_http(hook, monkeypatch):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-retire")
    post = MagicMock(side_effect=AssertionError("TUI UPS must not call post_json"))
    monkeypatch.setattr(hook, "post_json", post)
    monkeypatch.setattr(hook, "wait_for_prior_capture", lambda _sid: None)
    # Avoid native bridge network.
    monkeypatch.setattr(hook, "maybe_sync_bridge", lambda _e: None)
    monkeypatch.setattr(hook, "ensure_session_baseline", lambda _e: [])

    sid = "s-retire-ups"
    hook.handle_recall(
        {
            "sessionId": sid,
            "promptId": "p-ups",
            "prompt": "what did we decide?",
        }
    )
    post.assert_not_called()
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state is not None
    assert state["prompt"] == "what did we decide?"
    assert state.get("context") in ("", None)
    assert state.get("delivered") is True
    assert "retrievalTraceId" not in state or not state.get("retrievalTraceId")
    assert not state.get("memoryIds")


def test_ups_still_waits_for_prior_capture(hook, monkeypatch):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u-retire")
    waits: list[str] = []
    monkeypatch.setattr(hook, "wait_for_prior_capture", lambda sid: waits.append(sid))
    hook.handle_recall({"sessionId": "s-d1", "promptId": "p1", "prompt": "continue"})
    assert waits == ["s-d1"]


def test_memory_md_outside_markers_preserved(hook, monkeypatch, tmp_path):
    """User-authored MEMORY.md content outside runir-bridge markers stays intact."""
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setattr(hook, "STATE_DIR", tmp_path / "state" / "runir")
    (tmp_path / "state" / "runir").mkdir(parents=True, exist_ok=True)
    mem_root = tmp_path / "memory"
    mem_root.mkdir(parents=True)
    mem_path = mem_root / "MEMORY.md"
    user_body = (
        "# Memory\n\n"
        "## User notes\n"
        "keep this forever — outside bridge markers.\n\n"
        "<!-- runir-bridge:begin -->\n"
        "- old managed fact\n"
        "<!-- runir-bridge:end -->\n"
    )
    mem_path.write_text(user_body, encoding="utf-8")

    bridge = hook._load_memory_bridge()
    facts = [{"id": "f1", "text": "new managed fact from Rúnir"}]
    section, _ = bridge.format_managed_section_with_ids(facts, canary=False)
    updated = bridge.upsert_managed(mem_path.read_text(encoding="utf-8"), section)
    mem_path.write_text(updated, encoding="utf-8")

    after = mem_path.read_text(encoding="utf-8")
    assert "keep this forever — outside bridge markers." in after
    assert "## User notes" in after
    assert "new managed fact from Rúnir" in after
