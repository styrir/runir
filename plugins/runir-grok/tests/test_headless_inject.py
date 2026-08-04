"""Unit tests for scripts/headless_inject.py (no network, no real grok)."""

from __future__ import annotations

import json

import pytest


@pytest.fixture
def inject(load_inject):
    return load_inject()


def _rr(core, context="", retrieval_trace_id="", memory_ids=None):
    """Build a core.RecallResult for monkeypatches."""
    return core.RecallResult(
        context=context,
        retrieval_trace_id=retrieval_trace_id,
        memory_ids=list(memory_ids or []),
    )


def test_build_child_env_sets_disable_gate(inject):
    env = inject.build_child_env({"PATH": "/bin", "HOME": "/tmp"})
    assert env["RUNIR_GROK_DISABLE_GATE"] == "1"
    assert env["PATH"] == "/bin"


def test_build_child_env_strips_runir_credentials(inject):
    """Grok child must not inherit parent Rúnir bearer material (security r1 F1)."""
    base = {
        "PATH": "/bin",
        "HOME": "/tmp",
        "RUNIR_API_KEY": "super-secret-key",
        "RUNIR_ENV_FILE": "/tmp/secrets.env",
        "RUNIR_USER_ID": "owner",
        "RUNIR_BASE": "http://127.0.0.1:7700",
    }
    env = inject.build_child_env(base)
    assert "RUNIR_API_KEY" not in env
    assert "RUNIR_ENV_FILE" not in env
    assert env["RUNIR_GROK_DISABLE_GATE"] == "1"
    # Non-secret parent ids may remain; credentials must not.
    assert env.get("RUNIR_USER_ID") == "owner"


def test_build_grok_argv_fresh_session_flags(inject):
    argv = inject.build_grok_argv(
        '[{"type":"text","text":"hi"}]',
        session_id="98ee712c-45b3-4d3d-a7f9-c5ccf2e48b39",
        path="/tmp/ws",
        yolo=True,
        max_turns=1,
        no_memory=True,
        disable_web_search=True,
    )
    assert argv[0] == "grok"
    assert "--prompt-json" in argv
    assert "--output-format" in argv
    assert argv[argv.index("--output-format") + 1] == "json"
    assert "--session-id" in argv
    assert argv[argv.index("--session-id") + 1] == (
        "98ee712c-45b3-4d3d-a7f9-c5ccf2e48b39"
    )
    assert "--resume" not in argv
    assert "--cwd" in argv
    assert "--always-approve" in argv
    assert "--max-turns" in argv
    assert argv[argv.index("--max-turns") + 1] == "1"
    assert "--no-memory" in argv
    assert "--disable-web-search" in argv
    # Never wire systemPromptOverride
    assert not any("systemPromptOverride" in a for a in argv)


def test_build_grok_argv_resume_does_not_pass_session_id(inject):
    argv = inject.build_grok_argv(
        '[{"type":"text","text":"hi"}]', resume="grok-resume-abc"
    )
    assert argv[argv.index("--resume") + 1] == "grok-resume-abc"
    assert "--session-id" not in argv


def test_build_grok_argv_rejects_resume_plus_session_id(inject):
    with pytest.raises(ValueError, match="cannot be combined"):
        inject.build_grok_argv(
            '[{"type":"text","text":"hi"}]',
            resume="grok-resume-abc",
            session_id="98ee712c-45b3-4d3d-a7f9-c5ccf2e48b39",
        )


def test_resolve_session_id_fresh_generates_valid_uuid(inject):
    sid = inject.resolve_session_id()
    from uuid import UUID

    assert str(UUID(sid)) == sid
    assert inject.resolve_session_id() != sid


def test_resolve_session_id_resume_uses_real_grok_session(inject):
    sid = "98ee712c-45b3-4d3d-a7f9-c5ccf2e48b39"
    assert inject.resolve_session_id(resume=sid) == sid


def test_recall_with_retry_second_attempt(inject, monkeypatch):
    calls = {"n": 0}

    def fake_recall(*_a, **_k):
        calls["n"] += 1
        if calls["n"] == 1:
            return _rr(inject.core, "")
        return _rr(
            inject.core,
            "prepended-memory",
            retrieval_trace_id="t1",
            memory_ids=["m1"],
        )

    monkeypatch.setattr(inject.core, "recall_result", fake_recall)
    import time as time_mod

    monkeypatch.setattr(time_mod, "sleep", lambda _s: None)
    out = inject.recall_with_retry(
        "q", user_id="u", session_id="", path="/tmp", api_key=None, attempts=2
    )
    assert out.context == "prepended-memory"
    assert out.retrieval_trace_id == "t1"
    assert out.memory_ids == ["m1"]
    assert calls["n"] == 2


def test_write_prompt_json_file_mode_0600(inject, tmp_path):
    blocks = [{"type": "text", "text": "secret-memory"}]
    path = inject.write_prompt_json_file(blocks)
    try:
        mode = path.stat().st_mode & 0o777
        assert mode == 0o600
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data == blocks
    finally:
        path.unlink(missing_ok=True)


def test_parse_grok_json_object(inject):
    raw = json.dumps(
        {
            "text": "hello",
            "sessionId": "abc",
            "modelUsage": {"grok-4": {"modelCalls": 1}},
        }
    )
    obj = inject.parse_grok_json(raw)
    assert obj["sessionId"] == "abc"
    assert inject.extract_model_calls(obj) == 1


def test_extract_model_calls_prefers_summed_model_usage(inject):
    result = {
        "modelCalls": 99,
        "num_turns": 88,
        "modelUsage": {
            "grok-a": {"modelCalls": 1, "inputTokens": 12},
            "grok-b": {"modelCalls": 2},
            "ignored": {"inputTokens": 4},
        },
    }
    assert inject.extract_model_calls_with_source(result) == (3, "modelUsage")
    assert inject.extract_model_calls(result) == 3


@pytest.mark.parametrize(
    "value",
    [True, -1, "1"],
)
def test_extract_model_calls_rejects_invalid_model_usage_value(inject, value):
    result = {
        "modelCalls": 99,
        "modelUsage": {"grok": {"modelCalls": value}},
    }
    assert inject.sum_model_usage_calls(result["modelUsage"]) == (None, True)
    assert inject.extract_model_calls_with_source(result) == (
        None,
        "modelUsageInvalid",
    )


def test_extract_model_calls_rejects_mixed_valid_and_invalid_usage(inject):
    result = {
        "modelCalls": 99,
        "modelUsage": {
            "grok-a": {"modelCalls": 1},
            "grok-b": {"modelCalls": False},
        },
    }
    assert inject.sum_model_usage_calls(result["modelUsage"]) == (None, True)
    assert inject.extract_model_calls_with_source(result) == (
        None,
        "modelUsageInvalid",
    )


def test_extract_model_calls_falls_back_when_usage_rows_have_no_field(inject):
    result = {
        "modelCalls": 4,
        "modelUsage": {
            "grok-a": {"inputTokens": 12},
            "grok-b": {},
            "metadata": "ignored",
        },
    }
    assert inject.sum_model_usage_calls(result["modelUsage"]) == (None, False)
    assert inject.extract_model_calls_with_source(result) == (4, "modelCalls")


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        ({"modelCalls": 4, "num_turns": 5}, (4, "modelCalls")),
        ({"num_turns": 5}, (5, "num_turns")),
        ({"modelUsage": {"grok": {}}, "modelCalls": 4}, (4, "modelCalls")),
        ({}, (None, "unavailable")),
    ],
)
def test_extract_model_calls_fallback_sources(inject, result, expected):
    assert inject.extract_model_calls_with_source(result) == expected


def test_parse_grok_jsonl_takes_last(inject):
    lines = [
        json.dumps({"type": "text", "data": "partial"}),
        json.dumps(
            {
                "text": "final",
                "sessionId": "z",
                "modelUsage": {"m": {"modelCalls": 2}},
            }
        ),
    ]
    obj = inject.parse_grok_json("\n".join(lines))
    assert obj["sessionId"] == "z"
    assert inject.extract_model_calls(obj) == 2


def test_parse_grok_json_garbage(inject):
    assert inject.parse_grok_json("not json {{{") is None
    assert inject.parse_grok_json("") is None


def test_run_inject_exit_3_on_nonzero_spawn(inject, monkeypatch):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(inject.core, "mem"),
    )

    def boom(argv, env, timeout=None):
        return inject._ProcResult(1, stdout="", stderr="fail")

    code = inject.run_inject("hi", grok_runner=boom, no_capture=True)
    assert code == 3


def test_run_inject_exit_4_on_unparseable(inject, monkeypatch):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    monkeypatch.setattr(
        inject.core, "recall_result", lambda *a, **k: _rr(inject.core, "")
    )

    def bad(argv, env, timeout=None):
        return inject._ProcResult(0, stdout="<<<not-json>>>", stderr="")

    code = inject.run_inject("hi", grok_runner=bad, no_capture=True)
    assert code == 4


def test_run_inject_exit_2_missing_user(inject, monkeypatch):
    monkeypatch.delenv("RUNIR_USER_ID", raising=False)
    monkeypatch.setenv("RUNIR_ENV_FILE", "")
    # Force resolve to None even if process has RUNIR_USER_ID from ambient.
    monkeypatch.setattr(inject.core, "resolve_credential", lambda *a, **k: None)
    code = inject.run_inject("hi", no_capture=True)
    assert code == 2


def test_run_inject_recall_fail_open_still_zero(inject, monkeypatch, capsys):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")

    def raise_recall(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr(inject.core, "recall_result", raise_recall)

    def ok(argv, env, timeout=None):
        assert env.get("RUNIR_GROK_DISABLE_GATE") == "1"
        # prompt-json should be user-only when memory empty
        pj = argv[argv.index("--prompt-json") + 1]
        blocks = json.loads(pj)
        assert len(blocks) == 1
        assert blocks[0]["text"] == "user-q"
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

    code = inject.run_inject("user-q", grok_runner=ok, no_capture=True, as_json=True)
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    from uuid import UUID

    assert str(UUID(out["sessionId"])) == out["sessionId"]
    assert out["modelCalls"] == 1
    assert out["modelCallsSource"] == "modelUsage"
    assert out["modelUsage"] == {"m": {"modelCalls": 1}}
    assert out["memoryInjected"] is False
    assert out["promptBlockOrder"] == ["user"]
    assert "runirSessionId" not in out
    assert out["retrievalTraceId"] == ""
    assert out["memoryIds"] == []


def test_run_inject_memory_first_and_capture(inject, monkeypatch, capsys):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    captured = {}
    recalled = {}

    def fake_recall(prompt, **kwargs):
        recalled["session_id"] = kwargs.get("session_id")
        return _rr(
            inject.core,
            "the-secret-token",
            retrieval_trace_id="trace-abc",
            memory_ids=["mem-1", "mem-2"],
        )

    monkeypatch.setattr(inject.core, "recall_result", fake_recall)

    def fake_capture(messages, **kwargs):
        captured["messages"] = messages
        captured["kwargs"] = kwargs
        return True

    monkeypatch.setattr(inject.core, "capture_turn", fake_capture)

    def ok(argv, env, timeout=None):
        assert env["RUNIR_GROK_DISABLE_GATE"] == "1"
        assert "RUNIR_API_KEY" not in env
        assert "--resume" not in argv
        fresh_sid = argv[argv.index("--session-id") + 1]
        pj = argv[argv.index("--prompt-json") + 1]
        blocks = json.loads(pj)
        assert len(blocks) == 2
        assert blocks[0]["text"].startswith(inject.core.RECALL_FEEDBACK_PREFIX)
        assert "the-secret-token" in blocks[0]["text"]
        assert blocks[1]["text"] == "what is the token?"
        assert "systemPromptOverride" not in pj
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "the token is the-secret-token",
                    "sessionId": fresh_sid,
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "what is the token?",
        grok_runner=ok,
        as_json=True,
        yolo=True,
    )
    assert code == 0
    assert captured["messages"][0] == {
        "role": "user",
        "content": "what is the token?",
    }
    assert "the-secret-token" in captured["messages"][1]["content"]
    # T1: one real Grok session UUID threads recall, child argv, and capture.
    out = json.loads(capsys.readouterr().out)
    assert captured["kwargs"]["session_id"] == out["sessionId"]
    assert captured["kwargs"]["retrieval_trace_id"] == "trace-abc"
    assert captured["kwargs"]["memory_ids"] == ["mem-1", "mem-2"]
    assert recalled["session_id"] == out["sessionId"]
    assert "runirSessionId" not in out
    assert out["retrievalTraceId"] == "trace-abc"
    assert out["memoryIds"] == ["mem-1", "mem-2"]
    assert out["memoryInjected"] is True
    assert out["promptBlockOrder"] == ["memory", "user"]
    assert out["modelCalls"] == 1
    assert out["modelCallsSource"] == "modelUsage"
    assert out["modelUsage"] == {"m": {"modelCalls": 1}}


def test_run_inject_prompt_order_is_positional_on_text_collision(
    inject, monkeypatch, capsys
):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    memory = "collision-memory"
    prompt = inject.core.RECALL_FEEDBACK_PREFIX + memory
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(inject.core, memory),
    )

    def ok(argv, env, timeout=None):
        fresh_sid = argv[argv.index("--session-id") + 1]
        blocks = json.loads(argv[argv.index("--prompt-json") + 1])
        assert blocks[0]["text"] == blocks[1]["text"] == prompt
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
        prompt,
        grok_runner=ok,
        no_capture=True,
        as_json=True,
    )
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["promptBlockOrder"] == ["memory", "user"]


def test_run_inject_json_prefers_raw_model_usage_over_top_level(
    inject, monkeypatch, capsys
):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(inject.core, ""),
    )

    def ok(argv, env, timeout=None):
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "answer",
                    "sessionId": fresh_sid,
                    "modelCalls": 19,
                    "num_turns": 23,
                    "modelUsage": {
                        "grok-a": {"modelCalls": 1, "inputTokens": 7},
                        "grok-b": {"modelCalls": 2, "outputTokens": 3},
                    },
                }
            ),
        )

    code = inject.run_inject(
        "source precedence",
        grok_runner=ok,
        no_capture=True,
        as_json=True,
    )
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["modelCalls"] == 3
    assert out["modelCallsSource"] == "modelUsage"
    assert out["modelUsage"] == {
        "grok-a": {"modelCalls": 1, "inputTokens": 7},
        "grok-b": {"modelCalls": 2, "outputTokens": 3},
    }
    assert out["promptBlockOrder"] == ["user"]


def test_run_inject_json_preserves_model_calls_fallback(inject, monkeypatch, capsys):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(inject.core, ""),
    )

    def ok(argv, env, timeout=None):
        fresh_sid = argv[argv.index("--session-id") + 1]
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "answer",
                    "sessionId": fresh_sid,
                    "modelCalls": 2,
                }
            ),
        )

    code = inject.run_inject(
        "fallback",
        grok_runner=ok,
        no_capture=True,
        as_json=True,
    )
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["modelCalls"] == 2
    assert out["modelCallsSource"] == "modelCalls"
    assert out["modelUsage"] is None
    assert out["promptBlockOrder"] == ["user"]


def test_run_inject_resume_reuses_real_grok_session(inject, monkeypatch, capsys):
    """Resume turns use --resume for recall/capture and never also pass -s."""
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    seen = {}

    def fake_recall(prompt, **kwargs):
        seen["recall_sid"] = kwargs.get("session_id")
        return _rr(inject.core, "mem-ctx", retrieval_trace_id="t-r", memory_ids=["m-r"])

    monkeypatch.setattr(inject.core, "recall_result", fake_recall)

    def fake_capture(messages, **kwargs):
        seen["capture_sid"] = kwargs.get("session_id")
        return True

    monkeypatch.setattr(inject.core, "capture_turn", fake_capture)

    def ok(argv, env, timeout=None):
        assert "--resume" in argv
        assert argv[argv.index("--resume") + 1] == "grok-resume-99"
        assert "--session-id" not in argv
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "again",
                    "sessionId": "grok-resume-99",
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "follow-up",
        resume="grok-resume-99",
        grok_runner=ok,
        as_json=True,
    )
    assert code == 0
    assert seen["recall_sid"] == "grok-resume-99"
    assert seen["capture_sid"] == "grok-resume-99"
    out = json.loads(capsys.readouterr().out)
    assert "runirSessionId" not in out
    assert out["sessionId"] == "grok-resume-99"


def test_run_inject_fails_closed_before_capture_on_session_mismatch(
    inject, monkeypatch, capsys
):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    seen = {"capture": False}
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(inject.core, "memory"),
    )

    def fake_capture(*args, **kwargs):
        seen["capture"] = True
        return True

    monkeypatch.setattr(inject.core, "capture_turn", fake_capture)

    def mismatch(argv, env, timeout=None):
        expected = argv[argv.index("--session-id") + 1]
        assert expected != "00000000-0000-4000-8000-000000000000"
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "answer that must not be captured",
                    "sessionId": "00000000-0000-4000-8000-000000000000",
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject("fresh", grok_runner=mismatch, as_json=True)
    assert code == 4
    assert seen["capture"] is False
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "sessionId mismatch" in captured.err


def test_run_inject_resume_fails_closed_when_returned_session_missing(
    inject, monkeypatch, capsys
):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    monkeypatch.setattr(
        inject.core,
        "recall_result",
        lambda *a, **k: _rr(inject.core, ""),
    )

    def missing(argv, env, timeout=None):
        assert argv[argv.index("--resume") + 1] == "resume-real-id"
        assert "--session-id" not in argv
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {"text": "answer", "modelUsage": {"m": {"modelCalls": 1}}}
            ),
        )

    code = inject.run_inject(
        "follow-up",
        resume="resume-real-id",
        grok_runner=missing,
        no_capture=True,
        as_json=True,
    )
    assert code == 4
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "expected 'resume-real-id', got ''" in captured.err
