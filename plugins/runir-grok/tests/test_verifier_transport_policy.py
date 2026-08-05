"""Rúnir-git: verifier live_recall/ollama transport policy (allowlist + OPENER + cap)."""

from __future__ import annotations

import http.client
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import load_script_module  # noqa: E402

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
VERIFY_SCRIPT = PLUGIN_ROOT / "scripts" / "verify_hooks.py"


class _Headers:
    def __init__(self, mapping: dict[str, str] | None = None):
        self._m = dict(mapping or {})

    def get(self, key, default=None):
        return self._m.get(key, default)


class _FakeResponse:
    """HTTP-like response double; read(self, amt=-1) for read_capped_body."""

    def __init__(
        self,
        payload: bytes,
        *,
        status: int = 200,
        content_length: str | None = None,
        chunk_size: int | None = None,
    ):
        self.status = status
        self._payload = payload
        self._offset = 0
        self.read_calls: list[int | None] = []
        self.bytes_requested = 0
        if content_length is not None:
            self.headers = _Headers({"Content-Length": content_length})
        self._chunk_size = chunk_size

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, amt=-1):
        self.read_calls.append(amt)
        if amt is None or amt < 0:
            chunk = self._payload[self._offset :]
            self._offset = len(self._payload)
            self.bytes_requested += len(chunk)
            return chunk
        if self._chunk_size is not None:
            n = min(amt, self._chunk_size, len(self._payload) - self._offset)
        else:
            n = min(amt, len(self._payload) - self._offset)
        if n <= 0:
            return b""
        chunk = self._payload[self._offset : self._offset + n]
        self._offset += n
        self.bytes_requested += n
        return chunk


class _RecordingOpener:
    """Records open() Request and returns a fixed response context manager."""

    def __init__(self, response: _FakeResponse):
        self.response = response
        self.requests: list[urllib.request.Request] = []
        self.open_calls = 0

    def open(self, request, timeout=None):  # noqa: ARG002
        self.open_calls += 1
        self.requests.append(request)
        return self.response


@pytest.fixture
def verify():
    return load_script_module("verify_hooks.py", "runir_grok_verify_transport_ut")


def test_live_recall_disallowed_endpoint_exits_3_without_socket(verify, monkeypatch):
    monkeypatch.setenv("RUNIR_RECALL_URL", "http://evil.example.com/hooks/recall")
    monkeypatch.delenv("RUNIR_ALLOW_REMOTE_ENDPOINTS", raising=False)

    def _boom(*_a, **_k):
        raise AssertionError("socket must not open for disallowed endpoint")

    monkeypatch.setattr(verify.core.OPENER, "open", _boom)
    code, live = verify.live_recall_probe("secret-key", "user-1", "process_env")
    assert code == 3
    assert live["reason"] == "endpoint_not_allowed"
    assert live["authed"] is False
    assert "RUNIR_ALLOW_REMOTE_ENDPOINTS" in (live.get("hint") or "")


def test_live_recall_remote_https_allowed_when_opted_in(verify, monkeypatch):
    url = "https://remote.example.com/hooks/recall"
    monkeypatch.setenv("RUNIR_RECALL_URL", url)
    monkeypatch.setenv("RUNIR_ALLOW_REMOTE_ENDPOINTS", "1")
    body = json.dumps({"prependContext": ""}).encode("utf-8")
    opener = _RecordingOpener(_FakeResponse(body, status=200))
    monkeypatch.setattr(verify.core, "OPENER", opener)

    code, live = verify.live_recall_probe("secret-key", "user-1", "process_env")
    assert code == 0
    assert live["reason"] == "ok"
    assert live["authed"] is True
    assert opener.open_calls == 1
    assert opener.requests[0].full_url == url


def test_live_recall_uses_core_opener_and_bounded_reads(verify, monkeypatch):
    monkeypatch.setenv("RUNIR_RECALL_URL", "http://127.0.0.1:7700/hooks/recall")
    body = json.dumps({"prependContext": "mem"}).encode("utf-8")
    resp = _FakeResponse(body, status=200, chunk_size=8)
    opener = _RecordingOpener(resp)
    monkeypatch.setattr(verify.core, "OPENER", opener)

    code, live = verify.live_recall_probe("bearer-token", "alice", "process_env")
    assert code == 0
    assert live["reason"] == "ok"
    assert opener.open_calls == 1
    req = opener.requests[0]
    assert req.get_header("Authorization") == "Bearer bearer-token"
    assert all(c is not None and c >= 0 for c in resp.read_calls)
    assert resp.bytes_requested == len(body)


def test_live_recall_oversize_declared_length_exits_3(verify, monkeypatch):
    monkeypatch.setenv("RUNIR_RECALL_URL", "http://127.0.0.1:7700/hooks/recall")
    cap = verify.core.MAX_RESPONSE_BYTES
    resp = _FakeResponse(
        b"x" * (cap + 50),
        status=200,
        content_length=str(cap + 1),
    )
    opener = _RecordingOpener(resp)
    monkeypatch.setattr(verify.core, "OPENER", opener)

    code, live = verify.live_recall_probe("k", "u", "process_env")
    assert code == 3
    assert live["reason"] == "oversize_response"
    assert live["authed"] is False
    assert resp.read_calls == []
    assert "byte cap" in (live.get("hint") or "")


def test_live_recall_streamed_oversize_exits_3(verify, monkeypatch):
    monkeypatch.setenv("RUNIR_RECALL_URL", "http://127.0.0.1:7700/hooks/recall")
    cap = 2048
    monkeypatch.setattr(verify.core, "MAX_RESPONSE_BYTES", cap)
    resp = _FakeResponse(b"y" * (cap + 5000), status=200, chunk_size=100)
    opener = _RecordingOpener(resp)
    monkeypatch.setattr(verify.core, "OPENER", opener)

    code, live = verify.live_recall_probe("k", "u", "process_env")
    assert code == 3
    assert live["reason"] == "oversize_response"
    assert resp.bytes_requested <= cap + 1


def test_live_recall_cross_origin_redirect_blocked_no_auth_leak(verify, monkeypatch):
    monkeypatch.setenv("RUNIR_RECALL_URL", "http://127.0.0.1:7700/hooks/recall")

    def _raise_redirect(request, timeout=None):  # noqa: ARG001
        raise urllib.error.HTTPError(
            request.full_url,
            302,
            "cross-origin redirect blocked to http://evil.example/x",
            {},
            None,
        )

    monkeypatch.setattr(verify.core.OPENER, "open", _raise_redirect)
    code, live = verify.live_recall_probe("secret-token", "u", "process_env")
    assert code == 3
    assert live["reason"] == "cross_origin_redirect_blocked"
    assert live["authed"] is False
    assert "Authorization" in (live.get("hint") or "")

    # Direct handler: cross-origin refuses; same-origin keeps Authorization.
    handler = verify.core._SafeRedirectHandler()
    origin = "http://127.0.0.1:7700/hooks/recall"
    req = urllib.request.Request(
        origin,
        data=b"{}",
        headers={"Authorization": "Bearer secret-token"},
        method="POST",
    )

    # Minimal fp/headers for redirect_request signature.
    class _Fp:
        def read(self, *_a, **_k):
            return b""

        def close(self):
            return None

    with pytest.raises(urllib.error.HTTPError) as raised:
        handler.redirect_request(
            req,
            _Fp(),
            302,
            "Found",
            {},
            "http://evil.example/steal",
        )
    assert "cross-origin redirect blocked" in str(raised.value.reason)

    same = handler.redirect_request(
        req,
        _Fp(),
        302,
        "Found",
        {},
        "http://127.0.0.1:7700/hooks/other",
    )
    assert same is not None
    assert same.get_header("Authorization") == "Bearer secret-token"


@pytest.mark.parametrize(
    "status_or_exc,expect_code,expect_reason,need_hint",
    [
        (200, 0, "ok", False),
        (401, 3, "unauthorized", True),
        (403, 3, "unauthorized", True),
        (500, 3, "http_500", False),
        (urllib.error.URLError("refused"), 4, "service_down", True),
        (TimeoutError("slow"), 4, "service_down", False),
    ],
)
def test_live_recall_taxonomy_matrix(
    verify, monkeypatch, status_or_exc, expect_code, expect_reason, need_hint
):
    monkeypatch.setenv("RUNIR_RECALL_URL", "http://127.0.0.1:7700/hooks/recall")

    if isinstance(status_or_exc, int):
        body = json.dumps({}).encode("utf-8")
        if status_or_exc >= 400:
            # urllib may surface error status as HTTPError when using real openers;
            # our stub returns status inline like a successful open with non-2xx.
            resp = _FakeResponse(body, status=status_or_exc)
            monkeypatch.setattr(verify.core, "OPENER", _RecordingOpener(resp))
        else:
            resp = _FakeResponse(body, status=status_or_exc)
            monkeypatch.setattr(verify.core, "OPENER", _RecordingOpener(resp))
    else:
        exc = status_or_exc

        def _raise(*_a, **_k):
            raise exc

        monkeypatch.setattr(verify.core.OPENER, "open", _raise)

    code, live = verify.live_recall_probe("k", "u", "process_env")
    assert code == expect_code
    assert live["reason"] == expect_reason
    if need_hint:
        assert live.get("hint")


def test_live_recall_invalid_url_bad_port_exits_3_with_hint(verify, monkeypatch):
    """Allowlist accepts loopback; nonnumeric port must not crash — exit 3 + hint."""
    bad = "http://127.0.0.1:bad/hooks/recall"
    monkeypatch.setenv("RUNIR_RECALL_URL", bad)
    assert verify.core.is_allowed_runir_endpoint(bad) is True

    # Real OPENER: urllib raises http.client.InvalidURL (not URLError/OSError).
    code, live = verify.live_recall_probe("k", "u", "process_env")
    assert code == 3
    assert live["reason"] == "invalid_url"
    assert live.get("error") == "InvalidURL"
    assert live.get("authed") is False
    assert live.get("hint")
    assert "port" in live["hint"].lower() or "URL" in live["hint"] or "url" in live["hint"]


def test_live_recall_invalid_url_from_opener_mock(verify, monkeypatch):
    monkeypatch.setenv("RUNIR_RECALL_URL", "http://127.0.0.1:7700/hooks/recall")

    def _raise(*_a, **_k):
        raise http.client.InvalidURL("nonnumeric port: 'bad'")

    monkeypatch.setattr(verify.core.OPENER, "open", _raise)
    code, live = verify.live_recall_probe("k", "u", "process_env")
    assert code == 3
    assert live["reason"] == "invalid_url"
    assert live.get("hint")


def test_ollama_invalid_url_bad_port_exits_3(verify, monkeypatch):
    monkeypatch.setenv("RUNIR_OLLAMA_BASE", "http://127.0.0.1:bad")
    code, detail = verify.ollama_residency_probe()
    assert code == 3
    assert detail["reason"] == "invalid_url"
    assert detail.get("error") == "InvalidURL"
    assert detail.get("resident") is False


def test_ollama_probe_never_consults_runir_allowlist(verify, monkeypatch):
    def _no_allowlist(*_a, **_k):
        raise AssertionError("ollama must not call is_allowed_runir_endpoint")

    monkeypatch.setattr(verify.core, "is_allowed_runir_endpoint", _no_allowlist)
    payload = {
        "models": [
            {
                "name": "nomic-embed-text:latest",
                "expires_at": "2099-01-01T00:00:00Z",
            }
        ]
    }
    resp = _FakeResponse(json.dumps(payload).encode("utf-8"), status=200)
    monkeypatch.setattr(verify.core, "OPENER", _RecordingOpener(resp))

    code, detail = verify.ollama_residency_probe()
    assert code == 0
    assert detail["reason"] == "ok"
    assert detail["resident"] is True


def test_ollama_probe_reads_are_capped(verify, monkeypatch):
    payload = {
        "models": [
            {
                "name": "nomic-embed-text",
                "expires_at": "2099-06-01T00:00:00Z",
            }
        ]
    }
    raw = json.dumps(payload).encode("utf-8")
    resp = _FakeResponse(raw, status=200, chunk_size=5)
    opener = _RecordingOpener(resp)
    monkeypatch.setattr(verify.core, "OPENER", opener)

    code, detail = verify.ollama_residency_probe()
    assert code == 0
    assert all(c is not None and c >= 0 for c in resp.read_calls)

    cap = 64
    monkeypatch.setattr(verify.core, "MAX_RESPONSE_BYTES", cap)
    big = _FakeResponse(b"z" * (cap + 100), status=200, chunk_size=32)
    monkeypatch.setattr(verify.core, "OPENER", _RecordingOpener(big))
    code2, detail2 = verify.ollama_residency_probe()
    assert code2 == 3
    assert detail2["reason"] == "oversize_response"
    assert detail2.get("resident") is False
    assert big.bytes_requested <= cap + 1


def test_verifier_source_has_no_bare_opener_or_uncapped_read():
    src = VERIFY_SCRIPT.read_text(encoding="utf-8")
    # Match plan closeout rg: build_opener|response.read()|get_json|post_json
    assert re.search(r"build_opener|response\.read\(\)|get_json|post_json", src) is None
    bare = re.compile(r"\.read\(\s*\)")
    assert bare.search(src) is None
