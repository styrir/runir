"""Unit tests for lib/runir_core leaves (auth, envelope, payload, fail-open)."""

from __future__ import annotations

from email.message import Message
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from urllib.request import Request


def test_core_resolve_credential_prefers_process_env(tmp_path, core):
    env_path = tmp_path / ".env"
    env_path.write_text("RUNIR_API_KEY=from-file\n", encoding="utf-8")
    env = {"RUNIR_API_KEY": "from-process", "RUNIR_ENV_FILE": str(env_path)}
    assert core.resolve_credential("RUNIR_API_KEY", env) == "from-process"


def test_core_resolve_credential_falls_back_to_env_file(tmp_path, core):
    env_path = tmp_path / ".env"
    env_path.write_text("RUNIR_API_KEY=from-file\n", encoding="utf-8")
    assert core.resolve_credential(
        "RUNIR_API_KEY", {"RUNIR_ENV_FILE": str(env_path)}
    ) == ("from-file")


def test_core_read_dotenv_value_quoted(tmp_path, core):
    env_path = tmp_path / ".env"
    env_path.write_text('RUNIR_USER_ID="u-quoted"\n', encoding="utf-8")
    assert core.read_dotenv_value(str(env_path), "RUNIR_USER_ID") == "u-quoted"


def test_recall_context_returns_prepend_on_2xx(core, monkeypatch):
    monkeypatch.setattr(
        core,
        "post_json",
        lambda *a, **k: (200, {"prependContext": "fact-about-cats"}),
    )
    assert (
        core.recall_context("hello", user_id="u1", session_id="s1") == "fact-about-cats"
    )


def test_recall_context_fail_open_on_none(core, monkeypatch):
    monkeypatch.setattr(core, "post_json", lambda *a, **k: None)
    assert core.recall_context("hello", user_id="u1") == ""


def test_recall_context_fail_open_on_http_error(core, monkeypatch):
    monkeypatch.setattr(core, "post_json", lambda *a, **k: (500, {"error": "nope"}))
    assert core.recall_context("hello", user_id="u1") == ""


def test_recall_context_fail_open_missing_key(core, monkeypatch):
    monkeypatch.setattr(core, "post_json", lambda *a, **k: (200, {"other": "x"}))
    assert core.recall_context("hello", user_id="u1") == ""


def test_recall_context_empty_prompt_or_user(core):
    assert core.recall_context("", user_id="u1") == ""
    assert core.recall_context("hi", user_id="") == ""


def test_recall_result_threads_trace_and_memory_ids(core, monkeypatch):
    monkeypatch.setattr(
        core,
        "post_json",
        lambda *a, **k: (
            200,
            {
                "prependContext": "fact-about-dogs",
                "retrievalTraceId": "trace-99",
                "memories": [{"id": "m-a"}, {"id": "m-b"}],
            },
        ),
    )
    r = core.recall_result("hello", user_id="u1", session_id="s1")
    assert r.context == "fact-about-dogs"
    assert r.retrieval_trace_id == "trace-99"
    assert r.memory_ids == ["m-a", "m-b"]
    # Delegating seam preserves string-only contract.
    assert (
        core.recall_context("hello", user_id="u1", session_id="s1") == "fact-about-dogs"
    )


def test_recall_result_fail_open_empty(core, monkeypatch):
    monkeypatch.setattr(core, "post_json", lambda *a, **k: None)
    r = core.recall_result("hello", user_id="u1")
    assert r.context == ""
    assert r.retrieval_trace_id == ""
    assert r.memory_ids == []
    r2 = core.recall_result("", user_id="u1")
    assert r2.context == ""
    r3 = core.recall_result("hi", user_id="")
    assert r3.context == ""


def test_get_json_uses_auth_and_json_response(core, monkeypatch):
    seen = {}

    class Response:
        status = 200
        _raw = b'{"trace":{"id":"t1"}}'
        _offset = 0

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, amt=-1):
            if self._offset >= len(self._raw):
                return b""
            if amt is None or amt < 0:
                chunk = self._raw[self._offset :]
                self._offset = len(self._raw)
                return chunk
            chunk = self._raw[self._offset : self._offset + amt]
            self._offset += len(chunk)
            return chunk

    def fake_open(request, timeout):
        seen["url"] = request.full_url
        seen["auth"] = request.get_header("Authorization")
        seen["timeout"] = timeout
        return Response()

    monkeypatch.setattr(core.OPENER, "open", fake_open)
    assert core.get_json(
        "http://127.0.0.1:7700/hooks/traces/t1?userId=u1",
        3.0,
        api_key="secret",
    ) == (200, {"trace": {"id": "t1"}})
    assert seen == {
        "url": "http://127.0.0.1:7700/hooks/traces/t1?userId=u1",
        "auth": "Bearer secret",
        "timeout": 3.0,
    }


def test_capture_turn_true_on_2xx(core, monkeypatch):
    monkeypatch.setattr(core, "post_json", lambda *a, **k: (200, {"ok": True}))
    assert core.capture_turn(
        [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}],
        user_id="u1",
    )


def test_capture_turn_requests_persisted_receipt_with_full_metadata(core, monkeypatch):
    seen = {}

    def fake_post(url, payload, timeout, **kwargs):
        seen.update(payload)
        return 200, {"ok": True}

    monkeypatch.setattr(core, "post_json", fake_post)
    assert core.capture_turn(
        [
            {"role": "user", "content": "original prompt"},
            {"role": "assistant", "content": "final answer"},
        ],
        user_id="u1",
        session_id="sess-1",
        retrieval_trace_id="trace-1",
        memory_ids=["m1", "m2"],
        capture_receipt=True,
    )
    assert seen["sessionId"] == "sess-1"
    assert seen["retrievalTraceId"] == "trace-1"
    assert seen["memoryIds"] == ["m1", "m2"]
    assert seen["captureReceipt"] is True
    assert seen["messages"] == [
        {"role": "user", "content": "original prompt"},
        {"role": "assistant", "content": "final answer"},
    ]


def test_capture_turn_false_on_error_body(core, monkeypatch):
    monkeypatch.setattr(core, "post_json", lambda *a, **k: (200, {"error": "x"}))
    assert not core.capture_turn(
        [{"role": "user", "content": "q"}],
        user_id="u1",
    )


def test_capture_turn_preserves_legacy_success_on_skipped_body(core, monkeypatch):
    monkeypatch.setattr(
        core,
        "post_json",
        lambda *a, **k: (200, {"skipped": True, "reason": "no capture API key"}),
    )
    assert core.capture_turn(
        [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}],
        user_id="u1",
        session_id="s1",
        retrieval_trace_id="t1",
        memory_ids=["m1"],
    )


def test_capture_turn_receipt_mode_rejects_skipped_body(core, monkeypatch):
    monkeypatch.setattr(
        core,
        "post_json",
        lambda *a, **k: (200, {"skipped": True, "reason": "no capture API key"}),
    )
    assert not core.capture_turn(
        [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}],
        user_id="u1",
        session_id="s1",
        retrieval_trace_id="t1",
        memory_ids=["m1"],
        capture_receipt=True,
    )


def test_build_prompt_blocks_memory_first(core):
    blocks = core.build_prompt_blocks("user says hi", "memory-fact")
    assert len(blocks) == 2
    assert blocks[0]["type"] == "text"
    assert blocks[0]["text"].startswith(core.RECALL_FEEDBACK_PREFIX)
    assert "memory-fact" in blocks[0]["text"]
    assert blocks[1] == {"type": "text", "text": "user says hi"}


def test_build_prompt_blocks_empty_memory_single_block(core):
    blocks = core.build_prompt_blocks("only user", "")
    assert blocks == [{"type": "text", "text": "only user"}]


def test_build_prompt_blocks_never_system_override_key(core):
    blocks = core.build_prompt_blocks("p", "m")
    # Payload shape is content blocks only — no systemPromptOverride field.
    assert all("systemPromptOverride" not in b for b in blocks)
    blob = str(blocks)
    assert "systemPromptOverride" not in blob


def test_hook_reexports_leaves(hook, core):
    assert hook.read_dotenv_value is not None
    assert hook.resolve_credential is not None
    assert hook.RECALL_FEEDBACK_PREFIX == core.RECALL_FEEDBACK_PREFIX
    assert hook.content_hash("x") == core.content_hash("x")


def test_is_allowed_runir_endpoint_loopback(core):
    assert core.is_allowed_runir_endpoint("http://127.0.0.1:7700/hooks/recall")
    assert core.is_allowed_runir_endpoint("http://localhost:7700/hooks/capture")
    assert core.is_allowed_runir_endpoint("https://127.0.0.1/hooks/recall")


def test_is_allowed_runir_endpoint_remote_requires_opt_in(core, monkeypatch):
    monkeypatch.delenv("RUNIR_ALLOW_REMOTE_ENDPOINTS", raising=False)
    assert not core.is_allowed_runir_endpoint("https://api.example.com/hooks/recall")
    assert not core.is_allowed_runir_endpoint("http://evil.example/steal")
    assert not core.is_allowed_runir_endpoint(
        "https://api.example.com/hooks/recall", env={}
    )
    assert core.is_allowed_runir_endpoint(
        "https://api.example.com/hooks/recall",
        env={"RUNIR_ALLOW_REMOTE_ENDPOINTS": "1"},
    )
    # Opt-in still rejects cleartext remote.
    assert not core.is_allowed_runir_endpoint(
        "http://api.example.com/hooks/recall",
        env={"RUNIR_ALLOW_REMOTE_ENDPOINTS": "1"},
    )


def test_post_json_rejects_disallowed_url(core, monkeypatch):
    monkeypatch.delenv("RUNIR_ALLOW_REMOTE_ENDPOINTS", raising=False)
    assert (
        core.post_json(
            "http://evil.example/hooks/recall",
            {"x": 1},
            1.0,
            api_key="secret",
        )
        is None
    )


def test_safe_redirect_blocks_cross_origin(core):
    """Cross-origin 302 must not re-issue Authorization (security r1 F2)."""
    req = Request(
        "http://127.0.0.1:7700/hooks/recall",
        data=b"{}",
        method="POST",
        headers={"Authorization": "Bearer secret"},
    )
    headers = Message()
    headers["Location"] = "http://evil.example/steal"
    handler = core._SafeRedirectHandler()
    try:
        handler.redirect_request(
            req, None, 302, "Found", headers, "http://evil.example/steal"
        )
        raised = False
    except Exception as exc:
        raised = True
        assert "cross-origin" in str(exc).lower() or getattr(exc, "code", None) == 302
    assert raised


def test_post_json_cross_origin_redirect_fail_open(core):
    """Live: local 302 to off-origin fails open (no Bearer leak, returns None)."""

    class RedirectHandler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:9/nowhere")
            self.end_headers()

        def log_message(self, format, *args):  # noqa: A003
            return

    server = HTTPServer(("127.0.0.1", 0), RedirectHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        url = f"http://{host}:{port}/hooks/recall"
        # Different port ⇒ different origin; handler must block.
        result = core.post_json(url, {"prompt": "x"}, 2.0, api_key="secret-token")
        assert result is None
    finally:
        server.shutdown()
