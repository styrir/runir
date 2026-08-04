"""U-D3: selection-id (or content-hash fallback) cross-turn dedupe."""

from __future__ import annotations

import time


def test_d3a_remembered_hash_suppresses_gate(hook, monkeypatch):
    sid = "sess-d3"
    context = "same facts again"
    digest = hook.content_hash(context)
    # empty memory_ids → selection_id == content_hash
    hook.remember_delivered_hash(sid, digest)

    def fake_post(url, payload, timeout):
        return 200, {"prependContext": context}

    monkeypatch.setattr(hook, "post_json", fake_post)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "test-user")
    monkeypatch.setattr(hook, "read_baseline_ids", lambda _s: [])
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
    assert hook.consume_recall({"sessionId": sid, "promptId": "p-new"}) is None


def test_d3_same_selection_different_render_dedupes(hook, monkeypatch):
    sid = "sess-d3-sel"
    ids = ["m1", "m2"]
    sel = hook.selection_id(ids, "render-a")
    hook.remember_delivered_hash(sid, sel)

    def fake_post(url, payload, timeout):
        return 200, {
            "prependContext": "render-b totally different markdown",
            "memories": [{"id": "m1"}, {"id": "m2"}],
        }

    monkeypatch.setattr(hook, "post_json", fake_post)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "test-user")
    monkeypatch.setattr(hook, "read_baseline_ids", lambda _s: [])
    hook.handle_recall(
        {"sessionId": sid, "promptId": "p2", "prompt": "again"}
    )
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state.get("delivered") is True
    assert state.get("selectionId") == sel


def test_d3_different_selection_same_render_delivers(hook, monkeypatch):
    sid = "sess-d3-diff"
    # Remember selection for m1 only
    hook.remember_delivered_hash(sid, hook.selection_id(["m1"], "same render"))

    def fake_post(url, payload, timeout):
        return 200, {
            "prependContext": "same render",
            "memories": [{"id": "m2"}],
        }

    monkeypatch.setattr(hook, "post_json", fake_post)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "test-user")
    monkeypatch.setattr(hook, "read_baseline_ids", lambda _s: [])
    hook.handle_recall(
        {"sessionId": sid, "promptId": "p3", "prompt": "q"}
    )
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state.get("delivered") is False


def test_d3b_ttl_and_max_entries_prune(hook, monkeypatch):
    sid = "sess-d3b"
    path = hook.dedupe_path(sid)
    now = time.time()
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
