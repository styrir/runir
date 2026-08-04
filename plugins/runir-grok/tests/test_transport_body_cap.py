"""Rúnir-eiw: strict bounded HTTP response-body reader (transport cap)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


class _Headers:
    def __init__(self, mapping: dict[str, str] | None = None):
        self._m = dict(mapping or {})

    def get(self, key, default=None):
        return self._m.get(key, default)


class _FakeResponse:
    """Minimal HTTP-like response for read_capped_body unit tests."""

    def __init__(
        self,
        payload: bytes,
        *,
        content_length: str | None = None,
        chunk_size: int | None = None,
    ):
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
            n = len(self._payload) - self._offset
            # Uncapped path — still honor for diagnostics, but tests assert we
            # never take it under the helper.
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


def test_declared_content_length_over_cap_rejected_before_read(core):
    cap = 1024
    resp = _FakeResponse(b"x" * (cap + 50), content_length=str(cap + 1))
    with pytest.raises(core.ResponseTooLarge):
        core.read_capped_body(resp, limit=cap)
    assert resp.read_calls == []
    assert resp.bytes_requested == 0


def test_unknown_length_oversize_bounded(core):
    cap = 2048
    # Stream more than cap; helper may request at most cap+1.
    resp = _FakeResponse(b"y" * (cap + 5000), chunk_size=100)
    with pytest.raises(core.ResponseTooLarge):
        core.read_capped_body(resp, limit=cap)
    assert all(c is not None and c >= 0 for c in resp.read_calls)
    assert resp.bytes_requested <= cap + 1
    assert len(resp.read_calls) >= 1


def test_dishonest_content_length_still_capped(core):
    cap = 512
    # Declares small length but streams past the cap.
    resp = _FakeResponse(b"z" * (cap + 1), content_length="10", chunk_size=64)
    with pytest.raises(core.ResponseTooLarge):
        core.read_capped_body(resp, limit=cap)
    assert resp.bytes_requested <= cap + 1


def test_exact_cap_accepted(core):
    cap = 1024
    payload = b"A" * cap
    resp = _FakeResponse(payload)
    body = core.read_capped_body(resp, limit=cap)
    assert body == payload
    assert len(body) == cap


def test_short_reads_are_reassembled(core):
    payload = b"short-chunk-body-ok"
    resp = _FakeResponse(payload, chunk_size=7)
    body = core.read_capped_body(resp, limit=256)
    assert body == payload
    assert len(resp.read_calls) >= 2


def test_get_json_oversize_fails_open_none(core, monkeypatch):
    cap = 64
    monkeypatch.setattr(core, "MAX_RESPONSE_BYTES", cap)

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, amt=-1):
            # Always offer more than the cap when asked.
            if amt is None or amt < 0:
                return b"{" + (b"x" * (cap + 10))
            return b"x" * amt

    monkeypatch.setattr(core.OPENER, "open", lambda *a, **k: Response())
    assert (
        core.get_json("http://127.0.0.1:7700/hooks/traces/t1", 1.0, api_key="k") is None
    )


def test_post_json_oversize_fails_open_none(core, monkeypatch):
    cap = 64
    monkeypatch.setattr(core, "MAX_RESPONSE_BYTES", cap)

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, amt=-1):
            if amt is None or amt < 0:
                return b"{" + (b"y" * (cap + 10))
            return b"y" * amt

    monkeypatch.setattr(core.OPENER, "open", lambda *a, **k: Response())
    assert (
        core.post_json(
            "http://127.0.0.1:7700/hooks/capture",
            {"ok": True},
            1.0,
            api_key="k",
        )
        is None
    )


def test_no_uncapped_read_in_transport_paths():
    """Three wired transport paths must not call bare response.read()."""
    bare = re.compile(r"\.read\(\s*\)")
    for rel in ("lib/runir_core.py", "scripts/memory_bridge.py"):
        src = (PLUGIN_ROOT / rel).read_text(encoding="utf-8")
        assert bare.search(src) is None, f"uncapped .read() remains in {rel}"
