"""U-D3: sha256 content-hash cross-turn dedupe."""

from __future__ import annotations

import time


def test_d3a_remembered_hash_suppresses_gate(hook, monkeypatch):
    sid = "sess-d3"
    context = "same facts again"
    digest = hook.content_hash(context)
    hook.remember_delivered_hash(sid, digest)

    # Mock post_json to return the same context.
    def fake_post(url, payload, timeout):
        return 200, {"prependContext": context}

    monkeypatch.setattr(hook, "post_json", fake_post)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "test-user")
    event = {
        "sessionId": sid,
        "promptId": "p-new",
        "prompt": "hello",
        "hookEventName": "UserPromptSubmit",
    }
    hook.handle_recall(event)
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state is not None
    assert state.get("delivered") is True
    assert state.get("contentHash") == digest
    assert state.get("context") == context
    # consume should yield nothing (already delivered)
    assert hook.consume_recall({"sessionId": sid, "promptId": "p-new"}) is None


def test_d3b_ttl_and_max_entries_prune(hook, monkeypatch):
    sid = "sess-d3b"
    path = hook.dedupe_path(sid)
    now = time.time()
    # 40 entries; oldest should drop past max=32; one expired by TTL.
    entries = []
    for i in range(40):
        entries.append({"hash": f"h{i:03d}", "at": now - i * 0.001})
    entries.append({"hash": "expired", "at": now - 10_000.0})
    hook.write_json_state(path, {"entries": entries})

    monkeypatch.setattr(hook, "RUNIR_RECALL_DEDUPE_MAX", 32)
    monkeypatch.setattr(hook, "RUNIR_RECALL_DEDUPE_TTL_S", 3600.0)

    assert hook.was_recently_delivered(sid, "expired") is False
    assert hook.was_recently_delivered(sid, "h000") is True
    state = hook.read_json_state(path)
    assert state is not None
    kept = state["entries"]
    assert len(kept) <= 32
    assert all(e["hash"] != "expired" for e in kept)
