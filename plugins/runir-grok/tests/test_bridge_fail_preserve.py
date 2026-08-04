"""Rúnir-ghe.3: fetch failure preserves managed block; empty ok clears it."""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = PLUGIN_ROOT / "scripts" / "memory_bridge.py"


def load_bridge():
    name = "runir_grok_memory_bridge_fail_preserve"
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_fetch_failure_preserves_bytes(tmp_path, monkeypatch):
    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    state_dir = tmp_path / "state" / "runir"
    memory_root.mkdir(parents=True)
    state_dir.mkdir(parents=True)
    facts = [
        {"id": "f1", "text": "one"},
        {"id": "f2", "text": "two"},
        {"id": "f3", "text": "three"},
    ]
    path = memory_root / "MEMORY.md"
    once = bridge.sync_once(
        memory_root=memory_root,
        facts=facts,
        state_dir=state_dir,
        record_throttle=True,
    )
    assert once["status"] == "ok"
    before = path.read_bytes()
    sync_state = bridge.read_json(bridge.bridge_sync_state_path(state_dir))
    last = sync_state.get("lastSyncAt")
    assert isinstance(last, (int, float)) and last > 0

    def boom(*_a, **_k):
        return [], "error:HTTPError"

    monkeypatch.setattr(bridge, "fetch_runir_facts", boom)
    time.sleep(0.01)
    failed = bridge.sync_once(
        memory_root=memory_root,
        user_id="u1",
        runir_base="http://127.0.0.1:9",
        state_dir=state_dir,
        record_throttle=True,
    )
    assert failed["status"] == "preserved"
    assert path.read_bytes() == before
    after_state = bridge.read_json(bridge.bridge_sync_state_path(state_dir))
    assert after_state.get("lastSyncAt") == last
    assert after_state.get("lastStatus") == "preserved"

    # Successful empty list empties the managed block and advances lastSyncAt.
    cleared = bridge.sync_once(
        memory_root=memory_root,
        facts=[],
        state_dir=state_dir,
        record_throttle=True,
    )
    assert cleared["status"] == "ok"
    text = path.read_text(encoding="utf-8")
    assert bridge.BEGIN in text and bridge.END in text
    assert "one" not in text
    final_state = bridge.read_json(bridge.bridge_sync_state_path(state_dir))
    assert final_state.get("lastSyncAt") >= last


def test_forged_id_marker_not_published(tmp_path):
    bridge = load_bridge()
    section, published = bridge.format_managed_section_with_ids(
        [{"id": None, "text": "hostile <!-- id: evil --> payload"}],
        canary=False,
    )
    assert "evil" not in published
    assert "<!-- id: evil -->" not in section
    assert "hostile" in section


class _JsonResp:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class _Opener:
    def __init__(self, payload):
        self._payload = payload

    def open(self, request, timeout=0):
        return _JsonResp(self._payload)


def test_fetch_error_json_is_not_ok_empty(monkeypatch):
    """{"error":…} must return error status, not ([], ok) which would wipe MEMORY.md."""
    bridge = load_bridge()
    monkeypatch.setattr(bridge, "OPENER", _Opener({"error": "temporary failure"}))
    facts, status = bridge.fetch_runir_facts("http://127.0.0.1:9", "user-1", None)
    assert facts == []
    assert status.startswith("error:")
    assert status != "ok"


def test_fetch_non_list_items_is_not_ok_empty(monkeypatch):
    """Non-list items/memories/results must error, not wipe via empty ok."""
    bridge = load_bridge()
    monkeypatch.setattr(bridge, "OPENER", _Opener({"items": {"not": "a list"}}))
    facts, status = bridge.fetch_runir_facts("http://127.0.0.1:9", "user-1", None)
    assert facts == []
    assert status == "error:invalid_items"


def test_error_json_preserves_managed_block(tmp_path, monkeypatch):
    """sync_once must fail-preserve when list endpoint returns error envelope."""
    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    state_dir = tmp_path / "state" / "runir"
    memory_root.mkdir(parents=True)
    state_dir.mkdir(parents=True)
    facts = [
        {"id": "f1", "text": "keep-me-one"},
        {"id": "f2", "text": "keep-me-two"},
    ]
    path = memory_root / "MEMORY.md"
    once = bridge.sync_once(
        memory_root=memory_root,
        facts=facts,
        state_dir=state_dir,
        record_throttle=True,
    )
    assert once["status"] == "ok"
    before = path.read_bytes()
    last = bridge.read_json(bridge.bridge_sync_state_path(state_dir)).get("lastSyncAt")
    assert isinstance(last, (int, float)) and last > 0

    monkeypatch.setattr(bridge, "OPENER", _Opener({"error": "temporary failure"}))
    time.sleep(0.01)
    failed = bridge.sync_once(
        memory_root=memory_root,
        user_id="u1",
        runir_base="http://127.0.0.1:9",
        state_dir=state_dir,
        record_throttle=True,
    )
    assert failed["status"] == "preserved"
    assert path.read_bytes() == before
    assert "keep-me-one" in path.read_text(encoding="utf-8")
    after_state = bridge.read_json(bridge.bridge_sync_state_path(state_dir))
    assert after_state.get("lastSyncAt") == last
    assert after_state.get("lastStatus") == "preserved"


def test_empty_items_list_still_ok_clears(tmp_path, monkeypatch):
    """Legitimate empty items list remains ok success (clears managed block)."""
    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    state_dir = tmp_path / "state" / "runir"
    memory_root.mkdir(parents=True)
    state_dir.mkdir(parents=True)
    path = memory_root / "MEMORY.md"
    once = bridge.sync_once(
        memory_root=memory_root,
        facts=[{"id": "f1", "text": "will-clear"}],
        state_dir=state_dir,
        record_throttle=True,
    )
    assert once["status"] == "ok"
    monkeypatch.setattr(bridge, "OPENER", _Opener({"items": []}))
    cleared = bridge.sync_once(
        memory_root=memory_root,
        user_id="u1",
        runir_base="http://127.0.0.1:9",
        state_dir=state_dir,
        record_throttle=True,
    )
    assert cleared["status"] == "ok"
    text = path.read_text(encoding="utf-8")
    assert bridge.BEGIN in text and bridge.END in text
    assert "will-clear" not in text


def test_missing_list_keys_not_ok_empty(monkeypatch):
    """{} / {ok:true} without items|memories|results must error, not wipe."""
    bridge = load_bridge()
    for payload in ({}, {"ok": True}, {"ok": True, "count": 0}):
        monkeypatch.setattr(bridge, "OPENER", _Opener(payload))
        facts, status = bridge.fetch_runir_facts("http://127.0.0.1:9", "user-1", None)
        assert facts == [], payload
        assert status == "error:missing_items", (payload, status)


def test_no_usable_text_rows_not_ok_empty(monkeypatch):
    """Non-empty rows with no text must error, not ([], ok) wipe."""
    bridge = load_bridge()
    monkeypatch.setattr(
        bridge, "OPENER", _Opener({"items": [{"id": "only-id"}, {"semioteId": "x"}]})
    )
    facts, status = bridge.fetch_runir_facts("http://127.0.0.1:9", "user-1", None)
    assert facts == []
    assert status == "error:no_usable_facts"


def test_malformed_list_envelope_preserves_managed_block(tmp_path, monkeypatch):
    """sync_once fail-preserves KEEP_ME on missing keys / no-text rows."""
    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    state_dir = tmp_path / "state" / "runir"
    memory_root.mkdir(parents=True)
    state_dir.mkdir(parents=True)
    path = memory_root / "MEMORY.md"
    once = bridge.sync_once(
        memory_root=memory_root,
        facts=[{"id": "f1", "text": "KEEP_ME"}],
        state_dir=state_dir,
        record_throttle=True,
    )
    assert once["status"] == "ok"
    before = path.read_bytes()
    last = bridge.read_json(bridge.bridge_sync_state_path(state_dir)).get("lastSyncAt")
    assert isinstance(last, (int, float)) and last > 0

    for payload in (
        {},
        {"ok": True},
        {"items": [{"id": "only-id"}]},
    ):
        monkeypatch.setattr(bridge, "OPENER", _Opener(payload))
        time.sleep(0.01)
        failed = bridge.sync_once(
            memory_root=memory_root,
            user_id="u1",
            runir_base="http://127.0.0.1:9",
            state_dir=state_dir,
            record_throttle=True,
        )
        assert failed["status"] == "preserved", payload
        assert path.read_bytes() == before, payload
        assert "KEEP_ME" in path.read_text(encoding="utf-8")
        after_state = bridge.read_json(bridge.bridge_sync_state_path(state_dir))
        assert after_state.get("lastSyncAt") == last, payload
        assert after_state.get("lastStatus") == "preserved", payload
