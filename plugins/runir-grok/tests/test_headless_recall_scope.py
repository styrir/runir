"""Rúnir-pzt.2: headless recall descope — no hard client/path on selection.

Reproduces the frozen failure shape where adapter-shaped hard client=grok +
dense path=cwd selected nothing while unscoped / preferredClient recall hit
the null-client null-path canary. Units mock the transport; no live secrets.
"""

from __future__ import annotations

import json

import pytest

# Frozen headless canary memory id from restart validation (public id only).
FROZEN_CANARY_MEMORY_ID = "d954cd50-dd34-43ec-90cc-aaa65db0b261"
FROZEN_ADAPTER_CWD = "/Users/brooks/Code/runir"


@pytest.fixture
def inject(load_inject):
    return load_inject()


def _rr(core, context="", retrieval_trace_id="", memory_ids=None):
    return core.RecallResult(
        context=context,
        retrieval_trace_id=retrieval_trace_id,
        memory_ids=list(memory_ids or []),
    )


def test_headless_recall_payload_omits_hard_client_and_path(inject, monkeypatch):
    """Headless path must POST preferredClient (or none), never hard client+cwd."""
    seen: dict = {}

    def fake_post(url, payload, timeout, **kwargs):
        seen["url"] = url
        seen["payload"] = dict(payload)
        return (
            200,
            {
                "prependContext": "canary-context",
                "retrievalTraceId": "trace-headless-descope",
                "memories": [{"id": FROZEN_CANARY_MEMORY_ID}],
            },
        )

    monkeypatch.setattr(inject.core, "post_json", fake_post)
    monkeypatch.delenv("RUNIR_HEADLESS_RECALL_PATH", raising=False)

    out = inject.recall_with_retry(
        "frozen semantic cue",
        user_id="brooks",
        session_id="sess-headless-1",
        path=None,
        api_key=None,
        client=None,
        preferred_client=inject.core.DEFAULT_CLIENT,
        attempts=1,
    )
    assert out.context == "canary-context"
    assert out.retrieval_trace_id == "trace-headless-descope"
    assert FROZEN_CANARY_MEMORY_ID in out.memory_ids

    body = seen["payload"]
    assert body["prompt"] == "frozen semantic cue"
    assert body["userId"] == "brooks"
    assert body["sessionId"] == "sess-headless-1"
    assert "client" not in body
    assert body.get("preferredClient") == inject.core.DEFAULT_CLIENT
    assert "path" not in body
    assert body.get("path") != FROZEN_ADAPTER_CWD


def test_legacy_recall_result_still_hard_scopes_when_requested(core, monkeypatch):
    """Non-headless callers that pass hard client+path keep strict scope payload."""
    seen: dict = {}

    def fake_post(url, payload, timeout, **kwargs):
        seen["payload"] = dict(payload)
        return (200, {"prependContext": "scoped"})

    monkeypatch.setattr(core, "post_json", fake_post)
    r = core.recall_result(
        "hello",
        user_id="u1",
        session_id="s1",
        client=core.DEFAULT_CLIENT,
        path=FROZEN_ADAPTER_CWD,
    )
    assert r.context == "scoped"
    body = seen["payload"]
    assert body["client"] == core.DEFAULT_CLIENT
    assert "preferredClient" not in body
    assert body["path"] == FROZEN_ADAPTER_CWD


def test_run_inject_descopes_recall_but_keeps_cwd_for_spawn_and_capture(
    inject, monkeypatch, capsys
):
    """run_inject: recall soft-scope; capture hard client + cwd; grok --cwd set."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.setenv("RUNIR_GROK_CLIENT", "grok")
    monkeypatch.delenv("RUNIR_HEADLESS_RECALL_PATH", raising=False)
    recalled: dict = {}
    captured: dict = {}

    def fake_recall(prompt, **kwargs):
        recalled["kwargs"] = dict(kwargs)
        return _rr(
            inject.core,
            "prepended-canary",
            retrieval_trace_id="trace-canary",
            memory_ids=[FROZEN_CANARY_MEMORY_ID],
        )

    def fake_capture(messages, **kwargs):
        captured["kwargs"] = dict(kwargs)
        return True

    monkeypatch.setattr(inject.core, "recall_result", fake_recall)
    monkeypatch.setattr(inject.core, "capture_turn", fake_capture)

    def ok(argv, env, timeout=None):
        assert "--cwd" in argv
        assert argv[argv.index("--cwd") + 1] == "/tmp/ws-headless"
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
        path="/tmp/ws-headless",
        grok_runner=ok,
        as_json=True,
    )
    assert code == 0
    # recall descope
    rk = recalled["kwargs"]
    assert rk.get("client") is None
    assert rk.get("preferred_client") == "grok"
    assert rk.get("path") is None
    # capture attribution unchanged
    ck = captured["kwargs"]
    assert ck.get("client") == "grok"
    assert ck.get("path") == "/tmp/ws-headless"
    assert ck.get("retrieval_trace_id") == "trace-canary"
    assert ck.get("memory_ids") == [FROZEN_CANARY_MEMORY_ID]

    out = json.loads(capsys.readouterr().out)
    assert out["memoryInjected"] is True
    assert out["promptBlockOrder"] == ["memory", "user"]
    assert out["retrievalTraceId"] == "trace-canary"
    assert FROZEN_CANARY_MEMORY_ID in out["memoryIds"]
    assert out["modelCalls"] == 1


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
    """Plugin does not invent filters — receipt reports service-selected ids only.

    Owner+client+path A/B that returns unrelated noemas is a service/identity
    concern (sibling beads); the adapter surfaces whatever memoryIds arrive.
    """
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


def test_headless_recall_path_env_reenable(inject, monkeypatch, capsys):
    """RUNIR_HEADLESS_RECALL_PATH=1 re-enables path=cwd on recall for debug only."""
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
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
        "q", path="/tmp/debug-ws", grok_runner=ok, no_capture=True, as_json=True
    )
    assert code == 0
    assert recalled["kwargs"].get("path") == "/tmp/debug-ws"
    assert recalled["kwargs"].get("preferred_client") == inject.core.DEFAULT_CLIENT
    assert recalled["kwargs"].get("client") is None
