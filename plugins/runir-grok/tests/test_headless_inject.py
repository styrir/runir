"""Unit tests for scripts/headless_inject.py (no network, no real grok)."""

from __future__ import annotations

import json

import pytest


@pytest.fixture
def inject(load_inject):
    return load_inject()


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


def test_build_grok_argv_flags(inject):
    argv = inject.build_grok_argv(
        '[{"type":"text","text":"hi"}]',
        resume="sess-1",
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
    assert "--resume" in argv
    assert argv[argv.index("--resume") + 1] == "sess-1"
    assert "--cwd" in argv
    assert "--always-approve" in argv
    assert "--max-turns" in argv
    assert argv[argv.index("--max-turns") + 1] == "1"
    assert "--no-memory" in argv
    assert "--disable-web-search" in argv
    # Never wire systemPromptOverride
    assert not any("systemPromptOverride" in a for a in argv)


def test_recall_with_retry_second_attempt(inject, monkeypatch):
    calls = {"n": 0}

    def fake_recall(*_a, **_k):
        calls["n"] += 1
        return "" if calls["n"] == 1 else "prepended-memory"

    monkeypatch.setattr(inject.core, "recall_context", fake_recall)
    import time as time_mod

    monkeypatch.setattr(time_mod, "sleep", lambda _s: None)
    out = inject.recall_with_retry(
        "q", user_id="u", session_id="", path="/tmp", api_key=None, attempts=2
    )
    assert out == "prepended-memory"
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
        "recall_context",
        lambda *a, **k: "mem",
    )

    def boom(argv, env, timeout=None):
        return inject._ProcResult(1, stdout="", stderr="fail")

    code = inject.run_inject("hi", grok_runner=boom, no_capture=True)
    assert code == 3


def test_run_inject_exit_4_on_unparseable(inject, monkeypatch):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    monkeypatch.setattr(inject.core, "recall_context", lambda *a, **k: "")

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

    monkeypatch.setattr(inject.core, "recall_context", raise_recall)

    def ok(argv, env, timeout=None):
        assert env.get("RUNIR_GROK_DISABLE_GATE") == "1"
        # prompt-json should be user-only when memory empty
        pj = argv[argv.index("--prompt-json") + 1]
        blocks = json.loads(pj)
        assert len(blocks) == 1
        assert blocks[0]["text"] == "user-q"
        return inject._ProcResult(
            0,
            stdout=json.dumps(
                {
                    "text": "answer",
                    "sessionId": "s9",
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject("user-q", grok_runner=ok, no_capture=True, as_json=True)
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["sessionId"] == "s9"
    assert out["modelCalls"] == 1
    assert out["memoryInjected"] is False


def test_run_inject_memory_first_and_capture(inject, monkeypatch, capsys):
    monkeypatch.setenv("RUNIR_USER_ID", "u1")
    monkeypatch.setattr(
        inject.core, "recall_context", lambda *a, **k: "the-secret-token"
    )
    captured = {}

    def fake_capture(messages, **kwargs):
        captured["messages"] = messages
        captured["kwargs"] = kwargs
        return True

    monkeypatch.setattr(inject.core, "capture_turn", fake_capture)

    def ok(argv, env, timeout=None):
        assert env["RUNIR_GROK_DISABLE_GATE"] == "1"
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
                    "sessionId": "s-mem",
                    "modelUsage": {"m": {"modelCalls": 1}},
                }
            ),
        )

    code = inject.run_inject(
        "what is the token?", grok_runner=ok, as_json=True, yolo=True
    )
    assert code == 0
    assert captured["messages"][0] == {
        "role": "user",
        "content": "what is the token?",
    }
    assert "the-secret-token" in captured["messages"][1]["content"]
