"""U-REG: fail-open when RUNIR_USER_ID unset; prompt-only UPS when Runir down."""

from __future__ import annotations

import io
import json


def test_reg_user_id_unset_exits_zero(hook, monkeypatch):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", None)
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(json.dumps({"hookEventName": "UserPromptSubmit", "prompt": "x"})),
    )
    assert hook.main() == 0


def test_reg_ups_prompt_only_no_http_no_deny(hook, monkeypatch, capsys):
    """TUI UPS does not call Runir; stores prompt; never emits deny JSON."""
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")

    def fail_post(url, payload, timeout):
        raise AssertionError("TUI UPS must not call post_json")

    monkeypatch.setattr(hook, "post_json", fail_post)
    event = {
        "sessionId": "s-down",
        "promptId": "p1",
        "prompt": "what do you know?",
    }
    hook.handle_recall(event)
    state = hook.read_json_state(hook.recall_state_path("s-down"))
    assert state is not None
    assert state.get("context") in ("", None)
    assert state.get("delivered") is True
    assert state.get("prompt") == "what do you know?"
    # No transport stdout from handlers.
    assert capsys.readouterr().out.strip() == ""
