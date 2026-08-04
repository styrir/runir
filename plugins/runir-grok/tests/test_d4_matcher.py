"""Template events: UPS + Stop only (PreToolUse deny transport retired)."""

from __future__ import annotations

import json
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = PLUGIN_ROOT / "templates" / "user-hooks.json"


def test_template_events_no_pre_tool_use():
    data = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    hooks = data["hooks"]
    assert set(hooks.keys()) == {"UserPromptSubmit", "Stop"}
    assert "PreToolUse" not in hooks

    text = TEMPLATE.read_text(encoding="utf-8")
    assert "__PLUGIN_ROOT__" in text
    assert "PreToolUse" not in text

    ups_timeout = hooks["UserPromptSubmit"][0]["hooks"][0]["timeout"]
    stop_timeout = hooks["Stop"][0]["hooks"][0]["timeout"]
    assert ups_timeout == 45
    assert stop_timeout == 5
