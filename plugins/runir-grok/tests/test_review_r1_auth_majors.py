"""Review r1 majors: shell-safe env wiring + no invented userId (ops-3kp)."""

from __future__ import annotations

import importlib.util
import shlex
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SCRIPT = PLUGIN_ROOT / "scripts" / "install_hooks.py"
VERIFY_SCRIPT = PLUGIN_ROOT / "scripts" / "verify_hooks.py"


def _load(path: Path, name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def install_mod():
    return _load(INSTALL_SCRIPT, "runir_grok_install_hooks_r1fix")


@pytest.fixture
def verify_mod():
    return _load(VERIFY_SCRIPT, "runir_grok_verify_hooks_r1fix")


def test_env_wiring_uses_shlex_single_quotes(tmp_path, install_mod):
    env_file = tmp_path / "runir.env"
    env_file.write_text("RUNIR_API_KEY=x\n", encoding="utf-8")
    resolved = env_file.resolve()
    frag = install_mod.env_wiring_fragment(resolved)
    # JSON-escaped form may have \\ but after loads path is single-quoted.
    assignment = f"RUNIR_ENV_FILE={shlex.quote(str(resolved))} "
    # Unescape JSON for comparison of intent.
    unescaped = frag.replace("\\\\", "\\").replace('\\"', '"')
    assert unescaped == assignment
    assert unescaped.startswith("RUNIR_ENV_FILE='") or unescaped.startswith(
        "RUNIR_ENV_FILE="
    )
    assert f'RUNIR_ENV_FILE="{resolved}"' not in unescaped


def test_parse_env_file_accepts_single_double_and_bare(verify_mod):
    path = "/Users/me/Code/runir/.env"
    # Bare / shlex.quote of safe path (no metachar → no quotes).
    assert (
        verify_mod.parse_env_file_from_command(
            f'/usr/bin/env RUNIR_ENV_FILE={shlex.quote(path)} python3 "x.py"'
        )
        == path
    )
    # Single-quoted (metachar path form).
    assert (
        verify_mod.parse_env_file_from_command(
            f"/usr/bin/env RUNIR_ENV_FILE='{path}' python3 \"x.py\""
        )
        == path
    )
    # Double-quoted legacy.
    assert (
        verify_mod.parse_env_file_from_command(
            f'/usr/bin/env RUNIR_ENV_FILE="{path}" python3 "x.py"'
        )
        == path
    )
    assert verify_mod.parse_env_file_from_command("/usr/bin/env python3 x.py") is None


def test_live_recall_probe_missing_user_id_exits_3_no_owner(verify_mod, monkeypatch):
    """Must not invent userId=owner when RUNIR_USER_ID unresolved (review r1 major)."""

    # If probe wrongly builds payload with owner, request would be attempted.
    def _boom(*_a, **_k):
        raise AssertionError("HTTP must not run when user id missing")

    monkeypatch.setattr(verify_mod.urllib.request, "build_opener", _boom)
    code, live = verify_mod.live_recall_probe("fake-key", None, "process_env")
    assert code == 3
    assert live.get("reason") == "missing_user_id"
    assert live.get("authed") is False
    assert (
        "owner" not in (live.get("hint") or "").lower()
        or "invent" in (live.get("hint") or "").lower()
    )

    code2, live2 = verify_mod.live_recall_probe("fake-key", "   ", "env_file_arg")
    assert code2 == 3
    assert live2.get("reason") == "missing_user_id"


def test_resolve_live_credential_prefers_process_env_over_wiring(
    tmp_path, verify_mod, monkeypatch
):
    """Review r2 major: verify must match adapter process-env-first order.

    Stale inherited RUNIR_API_KEY must not be masked by installed wiring's
    fresher file key (otherwise verify --live can pass while hooks fail).
    """
    env_path = tmp_path / "wired.env"
    env_path.write_text(
        "RUNIR_API_KEY=from-wiring-file\nRUNIR_USER_ID=wired-user\n",
        encoding="utf-8",
    )
    cmd = f'RUNIR_ENV_FILE={shlex.quote(str(env_path))} python3 "x.py"'
    monkeypatch.setenv("RUNIR_API_KEY", "from-process-stale")
    monkeypatch.setenv("RUNIR_USER_ID", "process-user")
    api_key, user_id, source = verify_mod.resolve_live_credential(cmd, None)
    assert source == "process_env"
    assert api_key == "from-process-stale"
    assert user_id == "process-user"


def test_resolve_live_credential_falls_back_to_wiring_when_no_process_key(
    tmp_path, verify_mod, monkeypatch
):
    env_path = tmp_path / "wired.env"
    env_path.write_text(
        "RUNIR_API_KEY=from-wiring-file\nRUNIR_USER_ID=wired-user\n",
        encoding="utf-8",
    )
    cmd = f'RUNIR_ENV_FILE={shlex.quote(str(env_path))} python3 "x.py"'
    monkeypatch.delenv("RUNIR_API_KEY", raising=False)
    monkeypatch.delenv("RUNIR_USER_ID", raising=False)
    api_key, user_id, source = verify_mod.resolve_live_credential(cmd, None)
    assert source == "installed_wiring"
    assert api_key == "from-wiring-file"
    assert user_id == "wired-user"
