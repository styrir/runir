"""Rúnir-ghe.4: isolated GROK_HOME canaries (no real ~/.grok writes)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
HOOK = PLUGIN_ROOT / "hooks" / "runir-grok.py"
BRIDGE = PLUGIN_ROOT / "scripts" / "memory_bridge.py"
REAL_GROK = Path.home() / ".grok"


def _snapshot(paths: list[Path]) -> dict[str, tuple[int, int] | None]:
    out: dict[str, tuple[int, int] | None] = {}
    for root in paths:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file():
                try:
                    st = p.stat()
                    out[str(p)] = (st.st_mtime_ns, st.st_size)
                except OSError:
                    out[str(p)] = None
    return out


def test_canary_bridge(tmp_path):
    env = os.environ.copy()
    env["GROK_HOME"] = str(tmp_path)
    env.pop("RUNIR_USER_ID", None)
    facts = json.dumps(
        [
            {"id": "c1", "text": "canary fact one"},
            {"id": "c2", "text": "canary fact two"},
        ]
    )
    proc = subprocess.run(
        [
            sys.executable,
            str(BRIDGE),
            "--sync",
            "--facts",
            facts,
            "--memory-root",
            str(tmp_path / "memory"),
            "--state-dir",
            str(tmp_path / "state" / "runir"),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert data["sync"]["status"] == "ok"
    text = (tmp_path / "memory" / "MEMORY.md").read_text(encoding="utf-8")
    assert "<!-- runir-bridge:begin -->" in text
    assert "canary fact one" in text


def test_canary_hook(tmp_path, monkeypatch):
    """Synthetic UPS with stubbed post_json via in-process hook (no network)."""
    # Use conftest loader
    sys.path.insert(0, str(PLUGIN_ROOT / "tests"))
    from conftest import load_hook_module

    hook = load_hook_module()
    state_dir = tmp_path / "state" / "runir"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setattr(hook, "STATE_DIR", state_dir)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "canary-user")

    def fake_post(url, payload, timeout):
        return 200, {
            "prependContext": "CANARY_RECALL_SENTINEL",
            "retrievalTraceId": "canary-trace",
            "memories": [{"id": "cm1", "memory": "CANARY_RECALL_SENTINEL"}],
        }

    monkeypatch.setattr(hook, "post_json", fake_post)

    class _Bridge:
        @staticmethod
        def read_managed_ids(path):
            return []

        @staticmethod
        def sync_once(**kwargs):
            mem = tmp_path / "memory"
            mem.mkdir(parents=True, exist_ok=True)
            (mem / "MEMORY.md").write_text(
                "<!-- runir-bridge:begin -->\n- published\n<!-- runir-bridge:end -->\n",
                encoding="utf-8",
            )
            return {
                "status": "ok",
                "changed": True,
                "publishedIds": ["cm1"],
                "factCount": 1,
            }

    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: _Bridge)
    event = {
        "sessionId": "canary-sess",
        "promptId": "canary-p",
        "prompt": "canary prompt",
        "hookEventName": "user_prompt_submit",
    }
    hook.ensure_session_baseline(event)
    hook.handle_recall(event)
    hook.native_publish_or_spawn(event)
    state = hook.read_json_state(hook.recall_state_path("canary-sess"))
    assert state is not None
    # TUI UPS is prompt-only (Rúnir-ysk): no HTTP recall context/trace binding.
    assert state.get("prompt") == "canary prompt"
    assert state.get("context") in ("", None)
    assert state.get("delivered") is True
    assert not state.get("retrievalTraceId")
    assert (tmp_path / "memory" / "MEMORY.md").is_file()
    assert any(state_dir.glob("trace-*.jsonl"))


def test_canary_isolation(tmp_path):
    targets = [REAL_GROK / "state" / "runir", REAL_GROK / "memory"]
    if not any(t.exists() for t in targets):
        pytest.skip("real ~/.grok state/memory dirs absent")
    before = _snapshot(targets)
    # Run bridge canary under isolated home
    env = os.environ.copy()
    env["GROK_HOME"] = str(tmp_path)
    subprocess.run(
        [
            sys.executable,
            str(BRIDGE),
            "--sync",
            "--facts",
            '["iso"]',
            "--memory-root",
            str(tmp_path / "memory"),
            "--state-dir",
            str(tmp_path / "state" / "runir"),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    after = _snapshot(targets)
    assert before == after


def test_canary_gate_off(tmp_path, monkeypatch):
    sys.path.insert(0, str(PLUGIN_ROOT / "tests"))
    from conftest import load_hook_module

    hook = load_hook_module()
    state_dir = tmp_path / "state" / "runir"
    state_dir.mkdir(parents=True)
    monkeypatch.setattr(hook, "STATE_DIR", state_dir)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    monkeypatch.setenv("RUNIR_GROK_DISABLE_GATE", "1")
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    before = set(state_dir.rglob("*"))
    monkeypatch.setattr(
        sys,
        "stdin",
        __import__("io").StringIO(
            json.dumps(
                {
                    "hookEventName": "user_prompt_submit",
                    "sessionId": "off",
                    "promptId": "p",
                    "prompt": "x",
                }
            )
        ),
    )
    assert hook.main() == 0
    after = set(state_dir.rglob("*"))
    assert before == after
