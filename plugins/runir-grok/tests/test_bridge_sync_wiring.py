"""Rúnir-e3a: UserPromptSubmit wires memory_bridge --sync (throttled, fail-open)."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = PLUGIN_ROOT / "scripts" / "memory_bridge.py"


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _secret_meta(value: object) -> dict[str, Any]:
    """Hash-only view of a secret-bearing string (no plaintext body)."""
    text = value if isinstance(value, str) else ""
    return {
        "sha256": _sha256_text(text),
        "length": len(text),
        "nonEmpty": bool(text),
    }


def _assert_secret_equal(actual: object, expected: object, *, label: str) -> None:
    """Equality without pytest assertion-rewrite dumping secret operands.

    Compares string values via plain ``if``; on mismatch fails with sha256/length
    metadata only. Drops raw secret locals before ``pytest.fail`` so failure
    frames do not retain plaintext operands where practical.
    """
    a_ok = isinstance(actual, str)
    e_ok = isinstance(expected, str)
    a_text = actual if a_ok else ""
    e_text = expected if e_ok else ""
    match = a_ok and e_ok and a_text == e_text
    a_meta = _secret_meta(a_text)
    e_meta = _secret_meta(e_text)
    del a_text, e_text, actual, expected
    if not match:
        pytest.fail(
            f"{label}: secret mismatch; actual={a_meta}; expected={e_meta}; "
            f"actual_type_ok={a_ok}; expected_type_ok={e_ok}"
        )


def load_bridge():
    name = "runir_grok_memory_bridge_under_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BRIDGE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_secret_equal_helper_failure_diagnostics_are_hash_only():
    """Regression (pzt.5 secrecy): equality helper never echoes plaintext keys.

    Fail-before-fix class: deliberate mismatch must raise via pytest.fail with
    only digest/length metadata — never the synthetic API key operands.
    """
    secret = "sk-bridge-from-env-file-probe"
    wrong = "sk-process-wins-probe"
    with pytest.raises(pytest.fail.Exception, match="secret mismatch") as excinfo:
        _assert_secret_equal(wrong, secret, label="bridge-eq-probe")
    fail_msg = str(excinfo.value)
    if secret in fail_msg or wrong in fail_msg:
        pytest.fail(
            "bridge-eq-probe: failure message leaked plaintext; "
            f"fail_msg={_secret_meta(fail_msg)}"
        )
    assert "sha256" in fail_msg
    assert "length" in fail_msg
    assert "bridge-eq-probe" in fail_msg
    # Happy path + type-mismatch stay non-vacuous without rewriteable asserts.
    _assert_secret_equal(secret, secret, label="bridge-eq-happy")
    with pytest.raises(pytest.fail.Exception, match="secret mismatch"):
        _assert_secret_equal(None, secret, label="bridge-eq-none")


def _event(sid: str = "sess-sync", prompt: str = "hello world question") -> dict:
    return {
        "sessionId": sid,
        "promptId": "p-1",
        "prompt": prompt,
        "hookEventName": "user_prompt_submit",
    }


def test_first_prompt_of_session_forces_sync(hook, monkeypatch):
    """First UPS uses synchronous sync_once (not spawn)."""
    syncs = []
    bridge = type(
        "B",
        (),
        {
            "sync_once": staticmethod(
                lambda **k: (
                    syncs.append(1)
                    or {
                        "status": "ok",
                        "publishedIds": [],
                        "changed": False,
                        "factCount": 0,
                    }
                )
            ),
            "read_managed_ids": staticmethod(lambda p: []),
        },
    )
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)
    # Simulate a very recent prior sync from another session.
    hook.write_json_state(
        hook.bridge_sync_state_path(),
        {"schema": 2, "lastSyncAt": time.time(), "sessions": [], "inFlightUntil": 0.0},
    )
    hook.ensure_session_baseline(_event("fresh-session"))
    hook.maybe_sync_bridge(_event("fresh-session"))
    assert syncs == [1], "first prompt of a new session must sync_once"


def test_throttle_skips_recent_sync_same_session(hook, monkeypatch):
    syncs = []
    spawned = []
    bridge = type(
        "B",
        (),
        {
            "sync_once": staticmethod(
                lambda **k: (
                    syncs.append(1)
                    or {
                        "status": "ok",
                        "publishedIds": [],
                        "changed": False,
                        "factCount": 0,
                    }
                )
            ),
            "read_managed_ids": staticmethod(lambda p: []),
        },
    )
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)
    monkeypatch.setattr(hook, "spawn_bridge_sync", lambda: spawned.append(1))
    monkeypatch.setattr(hook, "RUNIR_SYNC_LEASE_S", 60.0)
    monkeypatch.setattr(hook, "RUNIR_SYNC_MIN_S", 300.0)
    # Seed successful lastSyncAt so later should_sync throttles.
    hook.write_json_state(
        hook.bridge_sync_state_path(),
        {
            "schema": 2,
            "lastSyncAt": time.time(),
            "sessions": [],
            "inFlightUntil": 0.0,
        },
    )
    hook.ensure_session_baseline(_event("sess-a"))
    hook.maybe_sync_bridge(_event("sess-a"))  # first turn sync_once
    # Mark lastSyncAt recent again (sync_once may not have run real bridge)
    st = hook.read_json_state(hook.bridge_sync_state_path()) or {}
    st["lastSyncAt"] = time.time()
    st["inFlightUntil"] = time.time() + 60
    hook.write_json_state(hook.bridge_sync_state_path(), st)
    hook.maybe_sync_bridge(_event("sess-a"))  # second turn throttled
    assert syncs == [1]
    assert spawned == [], "second prompt within lease/throttle must not spawn"


def test_throttle_expires(hook, monkeypatch):
    syncs = []
    spawned = []
    bridge = type(
        "B",
        (),
        {
            "sync_once": staticmethod(
                lambda **k: (
                    syncs.append(1)
                    or {
                        "status": "ok",
                        "publishedIds": [],
                        "changed": False,
                        "factCount": 0,
                    }
                )
            ),
            "read_managed_ids": staticmethod(lambda p: []),
        },
    )
    monkeypatch.setattr(hook, "_load_memory_bridge", lambda: bridge)
    monkeypatch.setattr(hook, "spawn_bridge_sync", lambda: spawned.append(1))
    monkeypatch.setattr(hook, "RUNIR_SYNC_MIN_S", 0.05)
    monkeypatch.setattr(hook, "RUNIR_SYNC_LEASE_S", 0.05)
    hook.ensure_session_baseline(_event("sess-b"))
    hook.maybe_sync_bridge(_event("sess-b"))
    # Clear lastSyncAt so only lease matters; expire lease
    hook.write_json_state(
        hook.bridge_sync_state_path(),
        {
            "schema": 2,
            "lastSyncAt": 0.0,
            "sessions": [__import__("hashlib").sha256(b"sess-b").hexdigest()],
            "inFlightUntil": 0.0,
        },
    )
    # Mark first publish done
    npath = hook.native_state_path("sess-b")
    native = hook.read_json_state(npath) or {"schema": 1, "baselineIds": []}
    native["publishedAt"] = time.time()
    native["publishStatus"] = "ok"
    hook.write_json_state(npath, native)
    time.sleep(0.06)
    hook.maybe_sync_bridge(_event("sess-b"))
    assert syncs == [1]
    assert spawned == [1]


def test_spawn_failure_fails_open(hook, monkeypatch):
    # Force later-turn path
    npath = hook.native_state_path("sess-c")
    hook.write_json_state(
        npath,
        {
            "schema": 1,
            "baselineIds": [],
            "publishedAt": time.time(),
            "publishStatus": "ok",
            "updatedAt": time.time(),
        },
    )
    hook.write_json_state(
        hook.bridge_sync_state_path(),
        {"schema": 2, "lastSyncAt": 0.0, "sessions": [], "inFlightUntil": 0.0},
    )

    def boom():
        raise OSError("no fork for you")

    monkeypatch.setattr(hook, "spawn_bridge_sync", boom)
    hook.maybe_sync_bridge(_event("sess-c"))


def test_user_prompt_submit_triggers_sync_after_recall(hook, monkeypatch):
    calls = []
    monkeypatch.setattr(hook, "handle_recall", lambda e: calls.append("recall"))
    monkeypatch.setattr(hook, "maybe_sync_bridge", lambda e: calls.append("sync"))
    monkeypatch.setattr(hook, "RUNIR_USER_ID", "test-user")

    import io
    import sys as _sys

    monkeypatch.setattr(_sys, "stdin", io.StringIO(json.dumps(_event())))
    assert hook.main() == 0
    assert calls == ["recall", "sync"], "sync must run after recall prefetch"


def test_standalone_sync_resolves_api_key_from_env_file(tmp_path, monkeypatch):
    """Rúnir-pzt.5 major 4: memory_bridge --sync uses resolve_credential for key.

    Process-first, then RUNIR_ENV_FILE — not process-only.
    """
    bridge = load_bridge()
    env_path = tmp_path / "runir.env"
    secret = "sk-bridge-from-env-file"
    env_path.write_text(
        "RUNIR_API_KEY=" + secret + "\nRUNIR_USER_ID=owner\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("RUNIR_API_KEY", raising=False)
    monkeypatch.setenv("RUNIR_ENV_FILE", str(env_path))
    monkeypatch.delenv("RUNIR_USER_ID", raising=False)

    seen: dict = {}

    def fake_fetch(base, user_id, api_key, *, timeout=10.0):
        seen["api_key"] = api_key
        seen["user_id"] = user_id
        return [{"id": "f1", "text": "from-env-file-key"}], "ok"

    monkeypatch.setattr(bridge, "fetch_runir_facts", fake_fetch)
    memory_root = tmp_path / "memory"
    state_dir = tmp_path / "state"
    once = bridge.sync_once(
        memory_root=memory_root,
        state_dir=state_dir,
        record_throttle=False,
    )
    assert once["status"] == "ok"
    # Rewrite-safe: do not put secret operands in assert expressions (pytest rewrite).
    _assert_secret_equal(seen.get("api_key"), secret, label="bridge-env-file-api-key")
    assert seen.get("user_id") == "owner"
    # Process key still wins when both set
    process_key = "sk-process-wins"
    monkeypatch.setenv("RUNIR_API_KEY", process_key)
    seen.clear()
    once2 = bridge.sync_once(
        memory_root=memory_root,
        state_dir=state_dir,
        record_throttle=False,
    )
    assert once2["status"] == "ok"
    _assert_secret_equal(
        seen.get("api_key"), process_key, label="bridge-process-api-key"
    )


def test_state_file_records_claim(hook, monkeypatch):
    """should_sync sets inFlight lease + sessions; does not advance lastSyncAt."""
    npath = hook.native_state_path("sess-d")
    hook.write_json_state(
        npath,
        {
            "schema": 1,
            "baselineIds": [],
            "publishedAt": time.time(),
            "publishStatus": "ok",
            "updatedAt": time.time(),
        },
    )
    monkeypatch.setattr(hook, "spawn_bridge_sync", lambda: None)
    assert hook.should_sync("sess-d") is True
    state = hook.read_json_state(hook.bridge_sync_state_path())
    assert state is not None
    assert isinstance(state.get("inFlightUntil"), float)
    assert state.get("inFlightUntil") > time.time()
    assert len(state.get("sessions", [])) == 1
    assert "sess-d" not in json.dumps(state)
    # Within lease → False
    assert hook.should_sync("sess-d") is False


def test_upsert_managed_reasserts_on_corrupted_block():
    bridge = load_bridge()
    managed = bridge.format_managed_section(["fact one"], canary=False)
    # Corrupted: begin marker present, end marker missing.
    corrupted = f"# Memory\n\n{bridge.BEGIN}\n- stale garbage, no end marker\n"
    updated = bridge.upsert_managed(corrupted, managed)
    # Repair must leave exactly one block: no duplicate markers, no stale garbage.
    assert updated.count(bridge.BEGIN) == 1
    assert updated.count(bridge.END) == 1
    assert "stale garbage" not in updated
    assert "fact one" in updated
    # Preamble before the corrupted block survives.
    assert updated.startswith("# Memory")


def test_sync_memory_writes_global_only(tmp_path):
    """Scope guard: sync must never create or write workspace MEMORY.md files,
    even when a workspace-style dir exists (dream rewrites workspace files)."""
    import argparse

    bridge = load_bridge()
    memory_root = tmp_path / "memory"
    workspace = memory_root / "someproj-0a1b2c3d"
    workspace.mkdir(parents=True)
    (workspace / "MEMORY.md").write_text("# Project Memory\n", encoding="utf-8")
    args = argparse.Namespace(
        facts='["fact one"]',
        canary=False,
        memory_root=memory_root,
        state_dir=tmp_path / "state",
        runir_base="http://127.0.0.1:1",
        user_id=None,
        api_key=None,
    )
    result = bridge.sync_memory(args)
    assert "project" not in result
    assert bridge.BEGIN in (memory_root / "MEMORY.md").read_text(encoding="utf-8")
    # Workspace file untouched — no managed block, content unchanged.
    ws_text = (workspace / "MEMORY.md").read_text(encoding="utf-8")
    assert ws_text == "# Project Memory\n"
    # No pin file created.
    assert not (tmp_path / "state" / "bridge-paths.json").exists()
