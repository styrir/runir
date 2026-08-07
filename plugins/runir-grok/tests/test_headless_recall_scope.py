"""Rúnir-pzt.2: headless preferredClient + one workspace path footprint.

Codex blockers addressed:
1. pathless recall + pathful receipt capture → 409 identity mismatch.
2. Independent mocks do not prove old hard-client MISS / new preferred HIT
   against one selection model.

This suite uses a single deterministic selection stand-in for the frozen
null-client canary shape, then asserts run_inject shares path across recall,
Grok --cwd, and capture. No live secrets or canary plaintext.
"""

from __future__ import annotations

import json

import pytest

# Frozen headless canary memory id from restart validation (public id only).
FROZEN_CANARY_MEMORY_ID = "d954cd50-dd34-43ec-90cc-aaa65db0b261"
FROZEN_ADAPTER_CWD = "/tmp/ws-headless-footprint"


@pytest.fixture
def inject(load_inject):
    return load_inject()


def _rr(core, context="", retrieval_trace_id="", memory_ids=None):
    return core.RecallResult(
        context=context,
        retrieval_trace_id=retrieval_trace_id,
        memory_ids=list(memory_ids or []),
    )


def _canary_hit_body():
    return {
        "prependContext": "canary-context",
        "retrievalTraceId": "trace-headless-prefer",
        "memories": [{"id": FROZEN_CANARY_MEMORY_ID}],
    }


def _empty_body():
    return {
        "prependContext": "",
        "retrievalTraceId": "",
        "memories": [],
    }


def select_frozen_null_client_canary(payload: dict) -> dict:
    """One selection model for the frozen null-client canary shape.

    Service semantics (adapter-level stand-in):
    - hard ``client`` → strict mode → MISS (null-client row excluded)
    - ``preferredClient`` → prefer mode → HIT (null-client row ranks)
    - ``path`` is identity footprint only; both MISS and HIT use the same path
    """
    if payload.get("client"):
        return _empty_body()
    if payload.get("preferredClient"):
        return _canary_hit_body()
    return _empty_body()


def test_one_selection_model_old_hard_miss_new_prefer_hit_same_path(core, monkeypatch):
    """Same path + same model: hard client MISS, preferredClient HIT."""
    seen: list[dict] = []

    def fake_post(url, payload, timeout, **kwargs):
        body = dict(payload)
        seen.append(body)
        return (200, select_frozen_null_client_canary(body))

    monkeypatch.setattr(core, "post_json", fake_post)

    old = core.recall_result(
        "frozen semantic cue",
        user_id="brooks",
        session_id="sess-old",
        client=core.DEFAULT_CLIENT,
        preferred_client=None,
        path=FROZEN_ADAPTER_CWD,
    )
    new = core.recall_result(
        "frozen semantic cue",
        user_id="brooks",
        session_id="sess-new",
        client=None,
        preferred_client=core.DEFAULT_CLIENT,
        path=FROZEN_ADAPTER_CWD,
    )

    assert len(seen) == 2
    assert seen[0]["path"] == FROZEN_ADAPTER_CWD
    assert seen[0]["client"] == core.DEFAULT_CLIENT
    assert "preferredClient" not in seen[0]
    assert seen[1]["path"] == FROZEN_ADAPTER_CWD
    assert "client" not in seen[1]
    assert seen[1]["preferredClient"] == core.DEFAULT_CLIENT

    # Old hard-client payload → MISS against the same model
    assert old.context == ""
    assert old.retrieval_trace_id == ""
    assert old.memory_ids == []

    # New preferred-client payload → HIT (same path, same model)
    assert old.context != new.context or new.context  # HIT non-empty
    assert new.context == "canary-context"
    assert new.retrieval_trace_id == "trace-headless-prefer"
    assert FROZEN_CANARY_MEMORY_ID in new.memory_ids


def test_headless_recall_payload_preferred_client_with_workspace_path(
    inject, monkeypatch
):
    """Headless recall POST: preferredClient + path; never hard client."""
    seen: dict = {}

    def fake_post(url, payload, timeout, **kwargs):
        seen["payload"] = dict(payload)
        return (200, select_frozen_null_client_canary(payload))

    monkeypatch.setattr(inject.core, "post_json", fake_post)

    out = inject.recall_with_retry(
        "frozen semantic cue",
        user_id="brooks",
        session_id="sess-headless-1",
        path=FROZEN_ADAPTER_CWD,
        api_key=None,
        client=None,
        preferred_client=inject.core.DEFAULT_CLIENT,
        attempts=1,
    )
    assert out.context == "canary-context"
    assert out.retrieval_trace_id == "trace-headless-prefer"
    assert FROZEN_CANARY_MEMORY_ID in out.memory_ids

    body = seen["payload"]
    assert body["prompt"] == "frozen semantic cue"
    assert body["userId"] == "brooks"
    assert body["sessionId"] == "sess-headless-1"
    assert "client" not in body
    assert body.get("preferredClient") == inject.core.DEFAULT_CLIENT
    assert body.get("path") == FROZEN_ADAPTER_CWD


def test_legacy_recall_result_still_hard_scopes_when_requested(core, monkeypatch):
    """Non-headless callers that pass hard client+path keep strict scope payload."""
    seen: dict = {}

    def fake_post(url, payload, timeout, **kwargs):
        seen["payload"] = dict(payload)
        return (200, select_frozen_null_client_canary(payload))

    monkeypatch.setattr(core, "post_json", fake_post)
    r = core.recall_result(
        "hello",
        user_id="u1",
        session_id="s1",
        client=core.DEFAULT_CLIENT,
        path=FROZEN_ADAPTER_CWD,
    )
    # Hard client against the canary model → MISS
    assert r.context == ""
    body = seen["payload"]
    assert body["client"] == core.DEFAULT_CLIENT
    assert "preferredClient" not in body
    assert body["path"] == FROZEN_ADAPTER_CWD


def test_run_inject_one_path_prefer_recall_hard_client_capture(
    inject, monkeypatch, capsys
):
    """run_inject: one path on recall + --cwd + capture; soft prefer on recall only."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.setenv("RUNIR_GROK_CLIENT", "grok")
    monkeypatch.delenv("RUNIR_HEADLESS_RECALL_PATH", raising=False)
    recalled: dict = {}
    captured: dict = {}

    def fake_recall(prompt, **kwargs):
        recalled["kwargs"] = dict(kwargs)
        # Mirror selection model: hard client would miss; preferred hits.
        if kwargs.get("client"):
            return _rr(inject.core, "")
        if kwargs.get("preferred_client"):
            return _rr(
                inject.core,
                "prepended-canary",
                retrieval_trace_id="trace-canary",
                memory_ids=[FROZEN_CANARY_MEMORY_ID],
            )
        return _rr(inject.core, "")

    def fake_capture(messages, **kwargs):
        captured["kwargs"] = dict(kwargs)
        # Receipt succeeds only when capture path matches recall path footprint.
        if kwargs.get("path") != recalled["kwargs"].get("path"):
            return False
        if kwargs.get("capture_receipt") and not kwargs.get("retrieval_trace_id"):
            return False
        return True

    monkeypatch.setattr(inject.core, "recall_result", fake_recall)
    monkeypatch.setattr(inject.core, "capture_turn", fake_capture)

    def ok(argv, env, timeout=None):
        assert "--cwd" in argv
        assert argv[argv.index("--cwd") + 1] == FROZEN_ADAPTER_CWD
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "answer-with-memory",
                    "sessionId": fresh_sid,
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "cue about headless canary",
        path=FROZEN_ADAPTER_CWD,
        grok_runner=ok,
        as_json=True,
    )
    assert code == 0
    rk = recalled["kwargs"]
    assert rk.get("client") is None
    assert rk.get("preferred_client") == "grok"
    assert rk.get("path") == FROZEN_ADAPTER_CWD
    ck = captured["kwargs"]
    assert ck.get("client") == "grok"  # write provenance
    assert ck.get("path") == FROZEN_ADAPTER_CWD  # same footprint
    assert ck.get("retrieval_trace_id") == "trace-canary"
    assert ck.get("memory_ids") == [FROZEN_CANARY_MEMORY_ID]
    assert ck.get("capture_receipt") is True

    captured_io = capsys.readouterr()
    out = json.loads(captured_io.out)
    assert out["memoryInjected"] is True
    assert out["promptBlockOrder"] == ["memory", "user"]
    assert out["retrievalTraceId"] == "trace-canary"
    assert FROZEN_CANARY_MEMORY_ID in out["memoryIds"]
    assert out["modelCalls"] == 1
    # Receipt success: no non-fatal capture warning
    assert "warn: capture failed" not in captured_io.err


def test_receipt_success_matching_path_footprint(inject, monkeypatch, capsys):
    """Receipt-enabled capture succeeds when path matches recall footprint."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    footprint = "/tmp/receipt-match-ws"
    posts: list[tuple[str, dict]] = []

    def fake_post(url, payload, timeout, **kwargs):
        posts.append((url, dict(payload)))
        if "recall" in url:
            body = select_frozen_null_client_canary(payload)
            return (200, body)
        # capture path
        recall_payloads = [p for u, p in posts if "recall" in u]
        assert recall_payloads, "capture before recall"
        recall_path = recall_payloads[-1].get("path")
        cap_path = payload.get("path")
        if payload.get("captureReceipt") and cap_path != recall_path:
            return (409, {"error": "capture receipt context identity mismatch"})
        return (200, {"ok": True, "skipped": False})

    monkeypatch.setattr(inject.core, "post_json", fake_post)

    def ok(argv, env, timeout=None):
        assert argv[argv.index("--cwd") + 1] == footprint
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "answer",
                    "sessionId": fresh_sid,
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "cue", path=footprint, grok_runner=ok, as_json=True
    )
    assert code == 0
    captured_io = capsys.readouterr()
    out = json.loads(captured_io.out)
    assert out["memoryInjected"] is True
    assert FROZEN_CANARY_MEMORY_ID in out["memoryIds"]
    assert "warn: capture failed" not in captured_io.err

    recall_bodies = [p for u, p in posts if "recall" in u]
    capture_bodies = [p for u, p in posts if "capture" in u]
    assert recall_bodies and capture_bodies
    assert recall_bodies[0]["path"] == footprint
    assert capture_bodies[0]["path"] == footprint
    assert capture_bodies[0].get("captureReceipt") is True
    assert "preferredClient" in recall_bodies[0]
    assert "client" not in recall_bodies[0]
    assert capture_bodies[0].get("client") == inject.core.DEFAULT_CLIENT


def test_deliberate_path_mismatch_fails_receipt(inject, monkeypatch, capsys):
    """If capture path diverges from recall footprint, receipt fails (409 shape)."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    recall_path = "/tmp/recall-footprint"
    capture_path = "/tmp/other-footprint"
    assert recall_path != capture_path

    def fake_recall(prompt, **kwargs):
        # Force a successful prefer hit on recall_path
        assert kwargs.get("path") == recall_path or kwargs.get("path") is not None
        return _rr(
            inject.core,
            "prepended-canary",
            retrieval_trace_id="trace-mismatch",
            memory_ids=[FROZEN_CANARY_MEMORY_ID],
        )

    def fake_capture(messages, **kwargs):
        # Simulate service identityMatchedFootprint:false → non-success
        if kwargs.get("path") != recall_path:
            return False
        return True

    monkeypatch.setattr(inject.core, "recall_result", fake_recall)
    monkeypatch.setattr(inject.core, "capture_turn", fake_capture)

    # Force run_inject to use divergent paths by patching capture after normal
    # wiring would share cwd — deliberate regression of the pathless-recall bug:
    # recall records path A, capture sends path B.
    original_capture = inject.core.capture_turn

    def diverge_capture(messages, **kwargs):
        kwargs = dict(kwargs)
        kwargs["path"] = capture_path  # deliberate mismatch
        return original_capture(messages, **kwargs)

    monkeypatch.setattr(inject.core, "capture_turn", diverge_capture)

    def ok(argv, env, timeout=None):
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "answer-still-ok",
                    "sessionId": fresh_sid,
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "cue", path=recall_path, grok_runner=ok, as_json=True
    )
    assert code == 0  # answer non-fatal
    captured_err = capsys.readouterr()
    assert "warn: capture failed" in captured_err.err
    out = json.loads(captured_err.out)
    assert out["text"] == "answer-still-ok"
    assert out["memoryInjected"] is True


def test_empty_recall_fail_open_user_only_blocks(inject, monkeypatch, capsys):
    """Empty selection → fail-open user-only prompt blocks (observed headless miss)."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(inject.core, "", retrieval_trace_id="", memory_ids=[]),
    )

    def ok(argv, env, timeout=None):
        pj = argv[argv.index("--prompt-json") + 1]
        blocks = json.loads(pj)
        assert len(blocks) == 1
        assert blocks[0]["text"] == "cue-with-no-hits"
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "no-memory-answer",
                    "sessionId": fresh_sid,
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "cue-with-no-hits", grok_runner=ok, no_capture=True, as_json=True
    )
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["memoryInjected"] is False
    assert out["promptBlockOrder"] == ["user"]
    assert out["retrievalTraceId"] == ""
    assert out["memoryIds"] == []


def test_canary_success_receipt_fields(inject, monkeypatch, capsys):
    """Success path pins frozen memory id + non-empty trace + [memory,user]."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(
            inject.core,
            "frozen-canary-context",
            retrieval_trace_id="trace-frozen-1",
            memory_ids=[FROZEN_CANARY_MEMORY_ID],
        ),
    )

    def ok(argv, env, timeout=None):
        pj = argv[argv.index("--prompt-json") + 1]
        blocks = json.loads(pj)
        assert len(blocks) == 2
        assert blocks[0]["text"].startswith(inject.core.RECALL_FEEDBACK_PREFIX)
        assert "frozen-canary-context" in blocks[0]["text"]
        assert blocks[1]["text"] == "frozen cue"
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "hash-gated-answer",
                    "sessionId": fresh_sid,
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "frozen cue", grok_runner=ok, no_capture=True, as_json=True
    )
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["memoryInjected"] is True
    assert out["promptBlockOrder"] == ["memory", "user"]
    assert out["retrievalTraceId"] == "trace-frozen-1"
    assert FROZEN_CANARY_MEMORY_ID in out["memoryIds"]
    assert out["modelCalls"] == 1
    assert out["sessionId"]


def test_unrelated_selection_reported_as_is(inject, monkeypatch, capsys):
    """Plugin does not invent filters — receipt reports service-selected ids only."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    unrelated = ["noema-unrelated-aaa", "noema-unrelated-bbb"]
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(
            inject.core,
            "unrelated-context",
            retrieval_trace_id="trace-unrelated",
            memory_ids=unrelated,
        ),
    )

    def ok(argv, env, timeout=None):
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "answer",
                    "sessionId": fresh_sid,
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject("cue", grok_runner=ok, no_capture=True, as_json=True)
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["memoryInjected"] is True
    assert out["memoryIds"] == unrelated
    assert FROZEN_CANARY_MEMORY_ID not in out["memoryIds"]


def test_build_prompt_blocks_order_unchanged(core):
    blocks = core.build_prompt_blocks("user-q", "mem-ctx")
    assert [b["type"] for b in blocks] == ["text", "text"]
    assert blocks[0]["text"].startswith(core.RECALL_FEEDBACK_PREFIX)
    assert "mem-ctx" in blocks[0]["text"]
    assert blocks[1]["text"] == "user-q"
    user_only = core.build_prompt_blocks("user-q", "")
    assert len(user_only) == 1
    assert user_only[0]["text"] == "user-q"


def test_runir_headless_recall_path_env_removed(inject, monkeypatch, capsys):
    """RUNIR_HEADLESS_RECALL_PATH is gone; path always equals workspace cwd."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    # Even if an old env is set, it must not descope or re-scope path.
    monkeypatch.setenv("RUNIR_HEADLESS_RECALL_PATH", "1")
    recalled: dict = {}

    def fake_recall(prompt, **kwargs):
        recalled["kwargs"] = dict(kwargs)
        return _rr(inject.core, "")

    monkeypatch.setattr(inject.core, "recall_result", fake_recall)

    def ok(argv, env, timeout=None):
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "x",
                    "sessionId": fresh_sid,
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "q", path="/tmp/always-cwd", grok_runner=ok, no_capture=True, as_json=True
    )
    assert code == 0
    assert recalled["kwargs"].get("path") == "/tmp/always-cwd"
    assert recalled["kwargs"].get("preferred_client") == inject.core.DEFAULT_CLIENT
    assert recalled["kwargs"].get("client") is None
