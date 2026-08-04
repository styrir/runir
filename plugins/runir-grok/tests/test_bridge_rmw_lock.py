"""Rúnir-ghe.3: RMW lock + stat re-check under concurrent mutation."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = PLUGIN_ROOT / "scripts" / "memory_bridge.py"


def load_bridge():
    name = "runir_grok_memory_bridge_rmw"
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_retry_preserves_out_of_block_append(tmp_path, monkeypatch):
    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    memory_root.mkdir(parents=True)
    path = memory_root / "MEMORY.md"
    # Seed managed block + out-of-block peer content.
    seed = bridge.sync_once(
        memory_root=memory_root,
        facts=[{"id": "a", "text": "alpha"}],
        record_throttle=False,
    )
    assert seed["status"] == "ok"
    path.write_text(path.read_text(encoding="utf-8") + "\npeer note survives\n", encoding="utf-8")

    reads = {"n": 0}
    real_read = Path.read_text

    def flaky_read(self, *a, **k):
        text = real_read(self, *a, **k)
        if self == path:
            reads["n"] += 1
            if reads["n"] == 1:
                # Concurrent writer appends after our first pre-image read.
                Path.write_text(
                    self,
                    real_read(self, encoding="utf-8") + "extra peer line\n",
                    encoding="utf-8",
                )
        return text

    monkeypatch.setattr(Path, "read_text", flaky_read)
    result = bridge.write_memory_file(
        path, [{"id": "b", "text": "beta"}], canary=False, max_attempts=3
    )
    # Either ok after retry or preserved — never lose peer content without rewrite.
    final = real_read(path, encoding="utf-8")
    assert "peer note survives" in final
    if result.get("status") == "ok":
        assert "beta" in final


def test_three_losses_preserve(tmp_path, monkeypatch):
    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    memory_root.mkdir(parents=True)
    path = memory_root / "MEMORY.md"
    bridge.sync_once(
        memory_root=memory_root,
        facts=[{"id": "x", "text": "original"}],
        record_throttle=False,
    )
    original = path.read_bytes()

    def always_mutate_fingerprint(p):
        # Force pre/post mismatch every attempt by bumping mtime via rewrite.
        if p == path and path.exists():
            path.write_bytes(path.read_bytes() + b" ")
        try:
            st = path.stat()
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    # Replace fingerprint helper to report mismatch after read.
    calls = {"n": 0}
    real_fp = bridge._file_fingerprint

    def flaky_fp(p):
        calls["n"] += 1
        # odd calls = pre (stable), even = post (different)
        fp = real_fp(p)
        if calls["n"] % 2 == 0 and fp is not None:
            return (fp[0] + 1, fp[1] + 1)
        return fp

    monkeypatch.setattr(bridge, "_file_fingerprint", flaky_fp)
    result = bridge.write_memory_file(
        path, [{"id": "y", "text": "should not land"}], canary=False, max_attempts=3
    )
    assert result.get("status") == "preserved"
    assert result.get("reason") == "concurrent_writer"
    # File may have been mutated by our flaky helper only via odd paths — ensure
    # write_memory_file itself did not replace with the new managed section.
    text = path.read_text(encoding="utf-8")
    assert "should not land" not in text


def test_content_cas_preserves_append_between_read_and_fingerprint(tmp_path, monkeypatch):
    """security-r4 major: read-then-fingerprint TOCTOU must not clobber appends.

    Simulates external append after content is read but before any pre-image
    fingerprint / write — the stale-preimage window at the old L495–496.
    """
    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    memory_root.mkdir(parents=True)
    path = memory_root / "MEMORY.md"
    bridge.sync_once(
        memory_root=memory_root,
        facts=[{"id": "a", "text": "alpha"}],
        record_throttle=False,
    )
    path.write_text(
        path.read_text(encoding="utf-8") + "\npeer note survives\n", encoding="utf-8"
    )

    real_read = Path.read_text
    phase = {"n": 0}

    def flaky_read(self, *a, **k):
        text = real_read(self, *a, **k)
        if self != path:
            return text
        phase["n"] += 1
        # After the first content read (pre-image), append before caller fingerprints.
        if phase["n"] == 1:
            Path.write_text(
                self,
                text + "stale-preimage-append\n",
                encoding="utf-8",
            )
        return text

    monkeypatch.setattr(Path, "read_text", flaky_read)
    result = bridge.write_memory_file(
        path, [{"id": "b", "text": "beta"}], canary=False, max_attempts=3
    )
    final = real_read(path, encoding="utf-8")
    assert "peer note survives" in final
    assert "stale-preimage-append" in final, (
        f"external append lost under RMW; status={result!r}"
    )
    # Successful rewrite may include beta; preserved path must not wipe peers.
    if result.get("status") == "ok" and result.get("changed"):
        assert "beta" in final


def test_content_cas_retries_when_re_read_differs(tmp_path, monkeypatch):
    """CAS re-read mismatch forces retry; eventual write uses fresh bytes."""
    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    memory_root.mkdir(parents=True)
    path = memory_root / "MEMORY.md"
    bridge.sync_once(
        memory_root=memory_root,
        facts=[{"id": "a", "text": "alpha"}],
        record_throttle=False,
    )

    real_read = Path.read_text
    reads = {"n": 0}

    def flaky_read(self, *a, **k):
        text = real_read(self, *a, **k)
        if self != path:
            return text
        reads["n"] += 1
        # First attempt: poison only the pre-image return; file already has peer.
        if reads["n"] == 1:
            Path.write_text(self, text + "\nlate peer\n", encoding="utf-8")
            return text
        return real_read(self, *a, **k)

    monkeypatch.setattr(Path, "read_text", flaky_read)
    result = bridge.write_memory_file(
        path, [{"id": "z", "text": "zeta"}], canary=False, max_attempts=3
    )
    final = real_read(path, encoding="utf-8")
    assert "late peer" in final
    assert result.get("status") in ("ok", "preserved")
