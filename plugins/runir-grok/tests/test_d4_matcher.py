"""U-D4: templates/user-hooks.json matcher equals SoT and matches MCP names."""

from __future__ import annotations

import json
import re
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = PLUGIN_ROOT / "templates" / "user-hooks.json"

SAMPLE_NAMES = (
    "Bash",
    "Read",
    "Edit",
    "mcp__runir__search",
    "runir__search",
    "some_new_tool",
)


def test_d4_template_matcher_and_events():
    data = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    hooks = data["hooks"]
    assert set(hooks.keys()) >= {"UserPromptSubmit", "PreToolUse", "Stop"}
    assert len(hooks) == 3

    text = TEMPLATE.read_text(encoding="utf-8")
    assert "__PLUGIN_ROOT__" in text

    ptu = hooks["PreToolUse"][0]
    matcher = ptu["matcher"]
    assert matcher == ".*"
    compiled = re.compile(matcher)
    for name in SAMPLE_NAMES:
        assert compiled.fullmatch(name), name

    ups_timeout = hooks["UserPromptSubmit"][0]["hooks"][0]["timeout"]
    ptu_timeout = ptu["hooks"][0]["timeout"]
    stop_timeout = hooks["Stop"][0]["hooks"][0]["timeout"]
    assert ups_timeout == 45
    assert ptu_timeout == 5
    assert stop_timeout == 5
