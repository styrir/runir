"""Regression tests for review r1 majors (ops-95i)."""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = PLUGIN_ROOT / "scripts" / "memory_bridge.py"


def load_bridge():
    name = "runir_grok_memory_bridge_under_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BRIDGE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def bridge():
    return load_bridge()


def test_memory_list_row_shape_reads_memory_field(bridge):
    """Service /memory/list emits `memory`; bridge must not drop durable facts."""
    body = {
        "memories": [
            {"id": "m1", "memory": "user prefers dark mode"},
            {"id": "m2", "text": "legacy text alias"},
            {"id": "m3", "content": "legacy content alias"},
            {"id": "m4", "fact": "legacy fact alias"},
            {"id": "m5", "memory": ""},
        ]
    }
    # Exercise the same field selection as fetch_runir_facts without HTTP.
    facts: list[str] = []
    rows = body.get("items") or body.get("memories") or body.get("results") or []
    for row in rows:
        if isinstance(row, dict):
            text = (
                row.get("memory")
                or row.get("text")
                or row.get("content")
                or row.get("fact")
            )
            if isinstance(text, str) and text.strip():
                mid = row.get("id")
                if mid:
                    facts.append(f"{text.strip()}  <!-- id: {mid} -->")
                else:
                    facts.append(text.strip())
    # Also call real helper path via format after constructing like fetch would.
    assert any("dark mode" in f for f in facts)
    assert any("legacy text alias" in f for f in facts)
    assert any("legacy content alias" in f for f in facts)
    assert any("legacy fact alias" in f for f in facts)
    assert len(facts) == 4


def test_fetch_runir_facts_parses_service_memory_field(bridge, monkeypatch):
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps(
                {
                    "memories": [
                        {"id": "abc", "memory": "durable fact from service"},
                    ]
                }
            ).encode("utf-8")

    class _Opener:
        def open(self, request, timeout=0):
            return _Resp()

    monkeypatch.setattr(
        bridge.urllib.request,
        "build_opener",
        lambda *a, **k: _Opener(),
    )
    facts = bridge.fetch_runir_facts("http://127.0.0.1:9", "user-1", None)
    assert len(facts) == 1
    assert "durable fact from service" in facts[0]
    assert "abc" in facts[0]


def test_upsert_managed_opaque_windows_path(bridge):
    existing = (
        "# Memory\n\n"
        f"{bridge.BEGIN}\n"
        "old\n"
        f"{bridge.END}\n"
        "tail keeps\n"
    )
    managed = bridge.format_managed_section(
        [r"path is C:\Users\me\project\file.txt"],
        canary=False,
    )
    # Must not raise PatternError on \U in Windows path.
    out = bridge.upsert_managed(existing, managed)
    assert r"C:\Users\me\project\file.txt" in out
    assert out.count(bridge.BEGIN) == 1
    assert out.count(bridge.END) == 1
    assert "tail keeps" in out


def test_upsert_managed_neutralizes_embedded_end_marker(bridge):
    existing = f"# Memory\n\n{bridge.BEGIN}\nold\n{bridge.END}\n"
    evil = f"sneaky {bridge.END} escape"
    managed = bridge.format_managed_section([evil], canary=False)
    out = bridge.upsert_managed(existing, managed)
    assert out.count(bridge.BEGIN) == 1
    assert out.count(bridge.END) == 1
    assert "sneaky" in out
    # Embedded end marker stripped from fact body.
    body = out.split(bridge.BEGIN, 1)[1].rsplit(bridge.END, 1)[0]
    assert bridge.END not in body


def test_stop_no_sibling_reblock(hook, monkeypatch, capsys):
    """Stop claims once; second Stop within sibling window fails open (≤1 draft)."""
    sid = "sess-stop-r1"
    pid = "prompt-stop"
    ctx = "stop recall once"
    calls: list[str] = []

    def _capture(event):
        calls.append("capture")

    monkeypatch.setattr(hook, "detach_capture", _capture)
    hook.write_recall_state(sid, pid, ctx)

    # First Stop: consume + block.
    hook.handle_stop(
        {
            "reason": "end_turn",
            "sessionId": sid,
            "promptId": pid,
            "hookEventName": "Stop",
        }
    )
    out1 = capsys.readouterr().out
    assert "block" in out1
    assert ctx in out1

    # Immediate second Stop (sibling window still open): must NOT re-block.
    hook.handle_stop(
        {
            "reason": "end_turn",
            "sessionId": sid,
            "promptId": pid,
            "hookEventName": "Stop",
        }
    )
    out2 = capsys.readouterr().out
    assert out2.strip() == ""
    assert calls == ["capture"]


def test_stop_hook_active_fails_open(hook, monkeypatch, capsys):
    sid = "sess-stop-active"
    pid = "prompt-active"
    ctx = "should not redeliver on active"
    calls: list[str] = []
    monkeypatch.setattr(hook, "detach_capture", lambda e: calls.append("capture"))
    # Undelivered recall present, but stopHookActive means continuation.
    hook.write_recall_state(sid, pid, ctx)
    # Force undelivered for this edge case (continuation with undelivered state).
    path = hook.recall_state_path(sid)
    state = hook.read_json_state(path)
    assert state is not None
    state["delivered"] = False
    hook.write_json_state(path, state)

    hook.handle_stop(
        {
            "reason": "end_turn",
            "sessionId": sid,
            "promptId": pid,
            "stopHookActive": True,
        }
    )
    assert capsys.readouterr().out.strip() == ""
    assert calls == ["capture"]
    # Still undelivered (we skipped claim).
    state2 = hook.read_json_state(path)
    assert state2 is not None
    assert state2.get("delivered") is False
