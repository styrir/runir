"""Rúnir-ghe.1: recall identity through state, dedupe key, and capture."""

from __future__ import annotations

import json


def test_parse_recall_body_shapes(core):
    r = core.parse_recall_body(
        {
            "prependContext": "ctx-a",
            "retrievalTraceId": "trace-1",
            "memories": [{"id": "m2"}, {"id": "m1"}, {"id": "m2"}],
        }
    )
    assert r.context == "ctx-a"
    assert r.retrieval_trace_id == "trace-1"
    assert r.memory_ids == ["m2", "m1"]

    r = core.parse_recall_body(
        {
            "prependContext": "ctx-b",
            "trace_id": "t2",
            "items": [{"semioteId": 42}, {"semioteId": "42"}, {"id": "x"}],
        }
    )
    assert r.retrieval_trace_id == "t2"
    assert r.memory_ids == ["42", "x"]

    r = core.parse_recall_body({"prependContext": "c", "selected": ["not-a-dict", 3]})
    assert r.context == "c"
    assert r.memory_ids == []

    r = core.parse_recall_body(None)  # type: ignore[arg-type]
    assert r.context == ""
    assert r.memory_ids == []
    assert r.retrieval_trace_id == ""

    r = core.parse_recall_body({"prependContext": 1, "results": [{"id": None}]})
    assert r.context == ""
    assert r.memory_ids == []


def test_selection_id_order_independent_and_fallback(core):
    a = core.selection_id(["b", "a", "b"], "render-1")
    b = core.selection_id(["a", "b"], "render-2")
    assert a == b
    assert a != core.content_hash("render-1")
    empty = core.selection_id([], "hello")
    assert empty == core.content_hash("hello")


def test_write_recall_state_v2_and_v1_consume(hook):
    sid = "sess-id-v2"
    prompt = "original human prompt"
    ctx = "rendered markdown v1"
    digest = hook.content_hash(ctx)
    sel = hook.selection_id(["m1"], ctx)
    hook.write_recall_state(
        sid,
        "p1",
        ctx,
        content_hash_value=digest,
        prompt=prompt,
        selection_id_value=sel,
        memory_ids=["m1"],
        retrieval_trace_id="rt-99",
    )
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state is not None
    assert state.get("schema") == 2
    assert state.get("prompt") == prompt
    assert state.get("selectionId") == sel
    assert state.get("memoryIds") == ["m1"]
    assert state.get("retrievalTraceId") == "rt-99"
    assert state.get("contentHash") == digest
    assert state.get("delivered") is False

    # v1-shaped state (no schema / new keys) still consumes cleanly.
    v1_path = hook.recall_state_path("sess-v1")
    hook.write_json_state(
        v1_path,
        {
            "promptId": "pv1",
            "context": "legacy ctx",
            "delivered": False,
            "updatedAt": 1.0,
        },
    )
    got = hook.consume_recall({"sessionId": "sess-v1", "promptId": "pv1"})
    assert got == "legacy ctx"
    after = hook.read_json_state(v1_path)
    assert after is not None
    assert after.get("delivered") is True
    assert after.get("context") == "legacy ctx"


def test_handle_recall_writes_identity(hook, monkeypatch):
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")

    def fake_post(url, payload, timeout):
        return 200, {
            "prependContext": "mem body",
            "retrievalTraceId": "trace-xyz",
            "memories": [{"id": "id-a"}, {"id": "id-b"}],
        }

    monkeypatch.setattr(hook, "post_json", fake_post)
    # Empty baseline so native suppress does not fire.
    monkeypatch.setattr(hook, "read_baseline_ids", lambda _sid: [])
    sid = "sess-recall-id"
    hook.handle_recall(
        {
            "sessionId": sid,
            "promptId": "p-id",
            "prompt": "what about dark mode?",
        }
    )
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state is not None
    assert state["prompt"] == "what about dark mode?"
    assert state["retrievalTraceId"] == "trace-xyz"
    assert state["memoryIds"] == ["id-a", "id-b"]
    assert state["selectionId"] == hook.selection_id(["id-a", "id-b"], "mem body")
    assert state["delivered"] is False


def test_capture_payload_includes_identity(hook, monkeypatch):
    sid = "sess-cap-id"
    ctx = "ctx for capture"
    digest = hook.content_hash(ctx)
    sel = hook.selection_id(["m9"], ctx)
    hook.write_recall_state(
        sid,
        "p-cap",
        ctx,
        content_hash_value=digest,
        prompt="state prompt wins",
        selection_id_value=sel,
        memory_ids=["m9"],
        retrieval_trace_id="rt-cap",
    )
    captured: list[dict] = []

    def fake_post(url, payload, timeout):
        captured.append(payload)
        return 200, {"ok": True}

    monkeypatch.setattr(hook, "post_json", fake_post)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    monkeypatch.setattr(
        hook,
        "current_turn_messages",
        lambda e: [
            {"role": "user", "content": "transcript wrapped"},
            {"role": "assistant", "content": "answer"},
        ],
    )
    hook.handle_capture({"sessionId": sid}, sid, "tok1")
    assert len(captured) == 1
    payload = captured[0]
    assert payload["retrievalTraceId"] == "rt-cap"
    assert payload["memoryIds"] == ["m9"]
    assert payload["messages"][0]["content"] == "state prompt wins"


def test_capture_omits_identity_when_absent(hook, monkeypatch):
    sid = "sess-cap-none"
    hook.write_recall_state(sid, "p0", "ctx", content_hash_value=hook.content_hash("ctx"))
    captured: list[dict] = []

    def fake_post(url, payload, timeout):
        captured.append(payload)
        return 200, {"ok": True}

    monkeypatch.setattr(hook, "post_json", fake_post)
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    monkeypatch.setattr(
        hook,
        "current_turn_messages",
        lambda e: [{"role": "user", "content": "u"}, {"role": "assistant", "content": "a"}],
    )
    hook.handle_capture({}, sid, "tok2")
    payload = captured[0]
    assert "retrievalTraceId" not in payload
    assert "memoryIds" not in payload
