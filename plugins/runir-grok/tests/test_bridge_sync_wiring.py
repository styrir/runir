"""Rúnir-e3a: UserPromptSubmit wires memory_bridge --sync (throttled, fail-open)."""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

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


def _event(sid: str = "sess-sync", prompt: str = "hello world question") -> dict:
    return {
        "sessionId": sid,
        "promptId": "p-1",
        "prompt": prompt,
        "hookEventName": "user_prompt_submit",
    }


def test_first_prompt_of_session_forces_sync(hook, monkeypatch):
    spawned = []
    monkeypatch.setattr(hook, "spawn_bridge_sync", lambda: spawned.append(1))
    # Simulate a very recent prior sync from another session.
    hook.write_json_state(
        hook.bridge_sync_state_path(),
        {"lastSyncAt": time.time(), "sessions": []},
    )
    hook.maybe_sync_bridge(_event("fresh-session"))
    assert spawned == [1], "first prompt of a new session must bypass the throttle"


def test_throttle_skips_recent_sync_same_session(hook, monkeypatch):
    spawned = []
    monkeypatch.setattr(hook, "spawn_bridge_sync", lambda: spawned.append(1))
    hook.maybe_sync_bridge(_event("sess-a"))
    hook.maybe_sync_bridge(_event("sess-a"))
    assert spawned == [1], "second prompt within RUNIR_SYNC_MIN_S must be throttled"


def test_throttle_expires(hook, monkeypatch):
    spawned = []
    monkeypatch.setattr(hook, "spawn_bridge_sync", lambda: spawned.append(1))
    monkeypatch.setattr(hook, "RUNIR_SYNC_MIN_S", 0.05)
    hook.maybe_sync_bridge(_event("sess-b"))
    time.sleep(0.06)
    hook.maybe_sync_bridge(_event("sess-b"))
    assert spawned == [1, 1]


def test_spawn_failure_fails_open(hook, monkeypatch):
    def boom():
        raise OSError("no fork for you")

    monkeypatch.setattr(hook, "spawn_bridge_sync", boom)
    # Must not raise.
    hook.maybe_sync_bridge(_event("sess-c"))


def test_user_prompt_submit_triggers_sync_after_recall(hook, monkeypatch):
    calls = []
    monkeypatch.setattr(hook, "handle_recall", lambda e: calls.append("recall"))
    monkeypatch.setattr(hook, "maybe_sync_bridge", lambda e: calls.append("sync"))
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "test-user")

    import io
    import sys as _sys

    monkeypatch.setattr(
        _sys, "stdin", io.StringIO(json.dumps(_event()))
    )
    assert hook.main() == 0
    assert calls == ["recall", "sync"], "sync must run after recall prefetch"


def test_state_file_records_claim(hook, monkeypatch):
    monkeypatch.setattr(hook, "spawn_bridge_sync", lambda: None)
    hook.maybe_sync_bridge(_event("sess-d"))
    state = hook.read_json_state(hook.bridge_sync_state_path())
    assert state is not None
    assert isinstance(state.get("lastSyncAt"), float)
    assert len(state.get("sessions", [])) == 1
    # Session ids stored as sha256 digests only (no plaintext ids on disk).
    assert "sess-d" not in json.dumps(state)


def test_upsert_managed_reasserts_on_corrupted_block():
    bridge = load_bridge()
    managed = bridge.format_managed_section(["fact one"], canary=False)
    # Corrupted: begin marker present, end marker missing.
    corrupted = f"# Memory\n\n{bridge.BEGIN}\n- stale garbage, no end marker\n"
    updated = bridge.upsert_managed(corrupted, managed)
    # Repair must leave exactly one block: no duplicate markers, no stale garbage.
    assert updated.count(bridge.BEGIN) == 1
    assert updated.count(bridge.END) == 1
    assert "stale garbage" not in updated
    assert "fact one" in updated
    # Preamble before the corrupted block survives.
    assert updated.startswith("# Memory")


def test_sync_memory_writes_global_only(tmp_path):
    """Scope guard: sync must never create or write workspace MEMORY.md files,
    even when a workspace-style dir exists (dream rewrites workspace files)."""
    import argparse

    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    workspace = memory_root / "someproj-0a1b2c3d"
    workspace.mkdir(parents=True)
    (workspace / "MEMORY.md").write_text("# Project Memory\n", encoding="utf-8")
    args = argparse.Namespace(
        facts='["fact one"]',
        canary=False,
        memory_root=memory_root,
        state_dir=tmp_path / "state",
        runir_base="http://127.0.0.1:1",
        user_id=None,
        api_key=None,
    )
    result = bridge.sync_memory(args)
    assert "project" not in result
    assert bridge.BEGIN in (memory_root / "MEMORY.md").read_text(encoding="utf-8")
    # Workspace file untouched — no managed block, content unchanged.
    ws_text = (workspace / "MEMORY.md").read_text(encoding="utf-8")
    assert ws_text == "# Project Memory\n"
    # No pin file created.
    assert not (tmp_path / "state" / "bridge-paths.json").exists()
