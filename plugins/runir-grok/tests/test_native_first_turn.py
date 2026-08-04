"""Rúnir-ghe.2 / Rúnir-ysk: first-turn native publish (gate suppress retired)."""

from __future__ import annotations

import json


def _seed_managed(hook, bridge, ids_text):
    mem_root = hook.grok_home() / "memory"
    mem_root.mkdir(parents=True, exist_ok=True)
    path = mem_root / "MEMORY.md"
    facts = [{"id": i, "text": f"fact {i}"} for i in ids_text]
    section, _ = bridge.format_managed_section_with_ids(facts, canary=False)
    path.write_text("# Memory\n\n" + section, encoding="utf-8")
    return path


def test_native_baseline_and_prompt_only_ups(hook, monkeypatch, tmp_path):
    monkeypatch.setenv("GROK_HOME", str(tmp_path))
    monkeypatch.setattr(hook, "STATE_DIR", tmp_path / "state" / "runir")
    (tmp_path / "state" / "runir").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")

    bridge = hook._load_memory_bridge()
    _seed_managed(hook, bridge, ["A", "B"])

    posts = []

    def fake_post(url, payload, timeout):
        posts.append(url)
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
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)

    sid = "sess-native-a"
    event = {
        "sessionId": sid,
        "promptId": "p1",
        "prompt": "hello",
        "hookEventName": "user_prompt_submit",
    }
    baseline = hook.ensure_session_baseline(event)
    assert set(baseline) >= {"A", "B"}
    hook.handle_recall(event)
    assert posts == []  # no TUI recall HTTP
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state is not None
    assert state.get("delivered") is True
    assert state.get("prompt") == "hello"
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    skips = [e for e in lines if e.get("kind") == "skip"]
    assert any(e.get("reason") == "prompt_only" for e in skips)


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

    sid = "sess-sync-err"
    event = {"sessionId": sid, "promptId": "p1", "prompt": "q"}
    hook.ensure_session_baseline(event)
    hook.handle_recall(event)
    assert hook.read_json_state(hook.recall_state_path(sid)).get("delivered") is True
    hook.native_publish_or_spawn(event)
    lines = [
        json.loads(ln)
        for ln in hook.trace_path(sid).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert any(e.get("kind") == "error" for e in lines)
