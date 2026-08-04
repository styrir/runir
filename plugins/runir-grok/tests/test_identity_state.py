"""Rúnir-ghe.1 / Rúnir-ysk: turn-state identity for capture (prompt-only UPS)."""

from __future__ import annotations


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


def test_write_recall_state_v2_prompt_fields(hook):
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
    assert state.get("delivered") is False  # non-empty context defaults undelivered

    # Empty context defaults delivered=True (nothing for retired TUI transports).
    hook.write_recall_state(sid, "p2", "", prompt="next")
    state2 = hook.read_json_state(hook.recall_state_path(sid))
    assert state2 is not None
    assert state2.get("delivered") is True
    assert state2.get("prompt") == "next"


def test_handle_recall_prompt_only_no_identity(hook, monkeypatch):
    """TUI UPS stores prompt only — no HTTP, no retrievalTraceId/memoryIds claim."""
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "u1")
    posts = []

    def fake_post(url, payload, timeout):
        posts.append(url)
        return 200, {
            "prependContext": "mem body",
            "retrievalTraceId": "trace-xyz",
            "memories": [{"id": "id-a"}, {"id": "id-b"}],
        }

    monkeypatch.setattr(hook, "post_json", fake_post)
    sid = "sess-recall-id"
    hook.handle_recall(
        {
            "sessionId": sid,
            "promptId": "p-id",
            "prompt": "what about dark mode?",
        }
    )
    assert posts == []
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state is not None
    assert state["prompt"] == "what about dark mode?"
    assert state.get("delivered") is True
    assert not state.get("retrievalTraceId")
    assert not state.get("memoryIds")
    assert state.get("context") in ("", None)


def test_capture_payload_includes_identity_when_present(hook, monkeypatch):
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
    assert payload["messages"][0]["content"] == "state prompt wins"
    assert payload.get("retrievalTraceId") == "rt-cap"
    assert payload.get("memoryIds") == ["m9"]
