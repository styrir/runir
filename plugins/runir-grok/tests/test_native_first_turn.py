"""Rúnir-ghe.2: first-turn native publish + baseline suppress."""

from __future__ import annotations

import io
import json
import sys


def _seed_managed(hook, bridge, ids_text):
    mem_root = hook.grok_home() / "memory"
    mem_root.mkdir(parents=True, exist_ok=True)
    path = mem_root / "MEMORY.md"
    facts = [{"id": i, "text": f"fact {i}"} for i in ids_text]
    section, _ = bridge.format_managed_section_with_ids(facts, canary=False)
    path.write_text("# Memory\n\n" + section, encoding="utf-8")
    return path


def test_native_baseline_suppresses_gate(hook, monkeypatch, tmp_path):
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setattr(hook, "STATE_DIR", tmp_path / "state" / "runir")
    (tmp_path / "state" / "runir").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")

    bridge = hook._load_memory_bridge()
    _seed_managed(hook, bridge, ["A", "B"])

    def fake_post(url, payload, timeout):
        return 200, {
            "prependContext": "rendered A only",
            "memories": [{"id": "A"}],
            "retrievalTraceId": "t1",
        }

    monkeypatch.setattr(hook, "post_json", fake_post)
    sync_calls = []

    def fake_sync(**kwargs):
        sync_calls.append(kwargs)
        return {
            "status": "ok",
            "changed": True,
            "publishedIds": ["A", "B"],
            "factCount": 2,
        }

    monkeypatch.setattr(bridge, "sync_once", fake_sync)
    # ensure baseline path uses our bridge module
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)

    sid = "sess-native-a"
    event = {
        "sessionId": sid,
        "promptId": "p1",
        "prompt": "hello",
        "hookEventName": "user_prompt_submit",
    }
    hook.ensure_session_baseline(event)
    hook.handle_recall(event)
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state is not None
    assert state.get("delivered") is True
    # Gate must not fire.
    buf = io.StringIO()
    with monkeypatch.context() as m:
        m.setattr(sys, "stdout", buf)
        hook.handle_pre_tool_use({"sessionId": sid, "promptId": "p1"})
    assert buf.getvalue().strip() == ""
    # skip reason
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    skips = [e for e in lines if e.get("kind") == "skip"]
    assert any(e.get("reason") == "native_baseline" for e in skips)


def test_selection_outside_baseline_arms_gate(hook, monkeypatch, tmp_path):
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setattr(hook, "STATE_DIR", tmp_path / "state" / "runir")
    (tmp_path / "state" / "runir").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    bridge = hook._load_memory_bridge()
    _seed_managed(hook, bridge, ["A", "B"])
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)

    def fake_post(url, payload, timeout):
        return 200, {
            "prependContext": "new fact C",
            "memories": [{"id": "C"}],
        }

    monkeypatch.setattr(hook, "post_json", fake_post)
    sid = "sess-native-c"
    event = {"sessionId": sid, "promptId": "p1", "prompt": "q"}
    hook.ensure_session_baseline(event)
    hook.handle_recall(event)
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state.get("delivered") is False
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    hook.handle_pre_tool_use({"sessionId": sid, "promptId": "p1"})
    decision = json.loads(buf.getvalue())
    assert decision["decision"] == "deny"
    assert "new fact C" in decision["reason"]


def test_empty_memory_ids_never_suppressed(hook, monkeypatch, tmp_path):
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setattr(hook, "STATE_DIR", tmp_path / "state" / "runir")
    (tmp_path / "state" / "runir").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    bridge = hook._load_memory_bridge()
    _seed_managed(hook, bridge, ["A"])
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)

    def fake_post(url, payload, timeout):
        return 200, {"prependContext": "no ids body"}

    monkeypatch.setattr(hook, "post_json", fake_post)
    sid = "sess-empty-ids"
    event = {"sessionId": sid, "promptId": "p1", "prompt": "q"}
    hook.ensure_session_baseline(event)
    hook.handle_recall(event)
    assert hook.read_json_state(hook.recall_state_path(sid)).get("delivered") is False


def test_native_suppress_env_off(hook, monkeypatch, tmp_path):
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setenv("RUNIR_GROK_NATIVE_SUPPRESS", "0")
    monkeypatch.setattr(hook, "STATE_DIR", tmp_path / "state" / "runir")
    (tmp_path / "state" / "runir").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    bridge = hook._load_memory_bridge()
    _seed_managed(hook, bridge, ["A"])
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)

    def fake_post(url, payload, timeout):
        return 200, {"prependContext": "x", "memories": [{"id": "A"}]}

    monkeypatch.setattr(hook, "post_json", fake_post)
    sid = "sess-suppress-off"
    event = {"sessionId": sid, "promptId": "p1", "prompt": "q"}
    hook.ensure_session_baseline(event)
    hook.handle_recall(event)
    assert hook.read_json_state(hook.recall_state_path(sid)).get("delivered") is False


def test_second_ups_not_sync_once(hook, monkeypatch, tmp_path):
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setattr(hook, "STATE_DIR", tmp_path / "state" / "runir")
    (tmp_path / "state" / "runir").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    bridge = hook._load_memory_bridge()
    sync_calls = []

    def fake_sync(**kwargs):
        sync_calls.append(1)
        return {"status": "ok", "publishedIds": [], "changed": False, "factCount": 0}

    monkeypatch.setattr(bridge, "sync_once", fake_sync)
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)
    spawned = []
    monkeypatch.setattr(hook, "spawn_bridge_sync", lambda: spawned.append(1))
    monkeypatch.setattr(hook, "RUNIR_SYNC_MIN_S", 9999.0)
    monkeypatch.setattr(hook, "RUNIR_SYNC_LEASE_S", 0.001)

    sid = "sess-twice"
    event = {"sessionId": sid, "promptId": "p1", "prompt": "q"}
    hook.ensure_session_baseline(event)
    hook.native_publish_or_spawn(event)
    assert len(sync_calls) == 1
    hook.native_publish_or_spawn(event)
    # second turn must not call sync_once again
    assert len(sync_calls) == 1


def test_sync_once_raise_fail_open(hook, monkeypatch, tmp_path):
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setattr(hook, "STATE_DIR", tmp_path / "state" / "runir")
    (tmp_path / "state" / "runir").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    bridge = hook._load_memory_bridge()

    def boom(**kwargs):
        raise RuntimeError("sync exploded")

    monkeypatch.setattr(bridge, "sync_once", boom)
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)

    def fake_post(url, payload, timeout):
        return 200, {"prependContext": "ctx", "memories": [{"id": "Z"}]}

    monkeypatch.setattr(hook, "post_json", fake_post)
    sid = "sess-sync-err"
    event = {"sessionId": sid, "promptId": "p1", "prompt": "q"}
    hook.ensure_session_baseline(event)
    hook.handle_recall(event)
    # gate still armed
    assert hook.read_json_state(hook.recall_state_path(sid)).get("delivered") is False
    hook.native_publish_or_spawn(event)
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert any(e.get("kind") == "error" for e in lines)
