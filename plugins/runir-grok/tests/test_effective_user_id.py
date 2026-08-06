"""Identity contract: resolve_effective_user_id + loud surfaces (Rúnir-pzt.1).

Reproduces the restart failure mode: process=brooks vs dotenv=owner must not
silently prefer process (skill clobber path used owner and 404'd).
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import PLUGIN_ROOT, load_script_module  # noqa: E402


def test_effective_process_only(core):
    env = {"RUNIR_USER_ID": "brooks"}
    got = core.resolve_effective_user_id(env)
    assert got.user_id == "brooks"
    assert got.source == "process_env"
    assert got.conflict is None


def test_effective_file_only(tmp_path, core):
    env_path = tmp_path / "runir.env"
    env_path.write_text("RUNIR_USER_ID=owner\n", encoding="utf-8")
    env = {"RUNIR_ENV_FILE": str(env_path)}
    got = core.resolve_effective_user_id(env)
    assert got.user_id == "owner"
    assert got.source == "env_file"
    assert got.conflict is None


def test_effective_conflict_process_brooks_file_owner(tmp_path, core):
    """Exact restart failure mode: process brooks vs file owner → no silent pick."""
    env_path = tmp_path / "runir.env"
    env_path.write_text("RUNIR_USER_ID=owner\n", encoding="utf-8")
    env = {
        "RUNIR_USER_ID": "brooks",
        "RUNIR_ENV_FILE": str(env_path),
    }
    got = core.resolve_effective_user_id(env)
    assert got.user_id is None
    assert got.source == "conflict"
    assert got.conflict is not None
    assert "brooks" in got.conflict
    assert "owner" in got.conflict


def test_effective_agreeing_ids(tmp_path, core):
    env_path = tmp_path / "runir.env"
    env_path.write_text("RUNIR_USER_ID=brooks\n", encoding="utf-8")
    env = {
        "RUNIR_USER_ID": "brooks",
        "RUNIR_ENV_FILE": str(env_path),
    }
    got = core.resolve_effective_user_id(env)
    assert got.user_id == "brooks"
    assert got.source == "process_env+env_file"
    assert got.conflict is None


def test_effective_never_invents_owner_or_default(core):
    got = core.resolve_effective_user_id({})
    assert got.user_id is None
    assert got.source == "none"
    assert got.conflict is None
    # require raises, never returns owner/default
    with pytest.raises(core.MissingIdentityError) as ei:
        core.require_effective_user_id({})
    msg = str(ei.value).lower()
    assert "owner" not in msg or "invent" in msg
    assert "default" not in msg or "invent" in msg
    # Empty whitespace process value is still missing
    got2 = core.resolve_effective_user_id({"RUNIR_USER_ID": "   "})
    assert got2.user_id is None
    assert got2.source == "none"


def test_require_raises_on_conflict(tmp_path, core):
    env_path = tmp_path / "runir.env"
    env_path.write_text("RUNIR_USER_ID=owner\n", encoding="utf-8")
    env = {"RUNIR_USER_ID": "brooks", "RUNIR_ENV_FILE": str(env_path)}
    with pytest.raises(core.IdentityConflictError):
        core.require_effective_user_id(env)


def test_resolve_credential_api_key_unchanged(tmp_path, core):
    """API keys still process-first without conflict (key freshness)."""
    env_path = tmp_path / "runir.env"
    env_path.write_text("RUNIR_API_KEY=from-file\n", encoding="utf-8")
    env = {
        "RUNIR_API_KEY": "from-process",
        "RUNIR_ENV_FILE": str(env_path),
    }
    assert core.resolve_credential("RUNIR_API_KEY", env) == "from-process"
    env2 = {"RUNIR_ENV_FILE": str(env_path)}
    assert core.resolve_credential("RUNIR_API_KEY", env2) == "from-file"


def test_effective_env_file_kwarg_overrides_process_path(tmp_path, core):
    other = tmp_path / "other.env"
    other.write_text("RUNIR_USER_ID=other-user\n", encoding="utf-8")
    wired = tmp_path / "wired.env"
    wired.write_text("RUNIR_USER_ID=wired-user\n", encoding="utf-8")
    env = {"RUNIR_ENV_FILE": str(other)}
    got = core.resolve_effective_user_id(env, env_file=str(wired))
    assert got.user_id == "wired-user"
    assert got.source == "env_file"


def test_headless_run_inject_conflict_exits_nonzero(
    load_inject, monkeypatch, tmp_path, capsys
):
    inject = load_inject()
    env_path = tmp_path / "runir.env"
    env_path.write_text("RUNIR_USER_ID=owner\n", encoding="utf-8")
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.setenv("RUNIR_ENV_FILE", str(env_path))
    code = inject.run_inject("hi", no_capture=True)
    assert code == 2
    err = capsys.readouterr().err
    assert "identity_conflict" in err
    assert "brooks" in err
    assert "owner" in err
    # Never leak API key material
    assert "RUNIR_API_KEY" not in err or "required" in err.lower()
    assert "sk-" not in err


def test_headless_run_inject_missing_still_exit_2(load_inject, monkeypatch, capsys):
    inject = load_inject()
    monkeypatch.delenv("RUNIR_USER_ID", raising=False)
    monkeypatch.delenv("RUNIR_ENV_FILE", raising=False)
    monkeypatch.setenv("RUNIR_ENV_FILE", "")
    code = inject.run_inject("hi", no_capture=True)
    assert code == 2
    err = capsys.readouterr().err
    assert "RUNIR_USER_ID is required" in err
    assert "owner" not in err.lower() or "invent" in err.lower()


def test_verify_installed_wiring_overrides_agreeing_process_env_file(
    tmp_path, monkeypatch
):
    """Installed child wiring must expose conflict hidden by ambient dotenv."""
    verify = load_script_module(
        "verify_hooks.py", "runir_grok_verify_wiring_authority_ut"
    )
    ambient = tmp_path / "ambient.env"
    ambient.write_text("RUNIR_USER_ID=brooks\n", encoding="utf-8")
    wired = tmp_path / "wired.env"
    wired.write_text(
        "RUNIR_API_KEY=from-wiring-file\nRUNIR_USER_ID=owner\n",
        encoding="utf-8",
    )
    cmd = f'RUNIR_ENV_FILE={shlex.quote(str(wired))} python3 "x.py"'
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.setenv("RUNIR_ENV_FILE", str(ambient))
    monkeypatch.delenv("RUNIR_API_KEY", raising=False)

    assert verify._identity_env_file(cmd, None) == str(wired)
    effective = verify.resolve_live_identity(cmd, None)
    assert effective.source == "conflict"
    assert effective.user_id is None
    assert effective.conflict is not None
    assert "brooks" in effective.conflict
    assert "owner" in effective.conflict

    api_key, user_id, source = verify.resolve_live_credential(cmd, None)
    assert source == "installed_wiring"
    assert api_key is not None
    assert user_id is None

    def _boom(*_a, **_k):
        raise AssertionError("HTTP must not run on installed-wiring conflict")

    monkeypatch.setattr(verify.core.OPENER, "open", _boom)
    code, live = verify.live_recall_probe(
        api_key, user_id, source, effective=effective
    )
    assert code == 3
    assert live.get("reason") == "identity_conflict"
    assert live.get("authed") is False
    assert live.get("effectiveUserId") is None
    assert "from-wiring-file" not in json.dumps(live)


def test_verify_live_main_reports_wired_conflict_before_http(
    tmp_path, monkeypatch, capsys
):
    """The full --live preflight follows the installed hook child's dotenv."""
    verify = load_script_module(
        "verify_hooks.py", "runir_grok_verify_wiring_preflight_ut"
    )
    ambient = tmp_path / "ambient.env"
    ambient.write_text("RUNIR_USER_ID=brooks\n", encoding="utf-8")
    wired = tmp_path / "wired.env"
    wired.write_text(
        "RUNIR_API_KEY=from-wiring-file\nRUNIR_USER_ID=owner\n",
        encoding="utf-8",
    )
    script = PLUGIN_ROOT / "hooks" / "runir-grok.py"
    command = (
        f"/usr/bin/env RUNIR_ENV_FILE={shlex.quote(str(wired))} "
        f'python3 "{script}"'
    )
    hooks_file = tmp_path / "runir-grok.json"
    hooks_file.write_text(
        json.dumps(
            {
                "hooks": {
                    "UserPromptSubmit": [
                        {"hooks": [{"command": command, "timeout": 45}]}
                    ],
                    "Stop": [
                        {"hooks": [{"command": command, "timeout": 5}]}
                    ],
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.setenv("RUNIR_ENV_FILE", str(ambient))
    monkeypatch.delenv("RUNIR_API_KEY", raising=False)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_hooks.py",
            "--hooks-file",
            str(hooks_file),
            "--plugin-root",
            str(PLUGIN_ROOT),
            "--live",
        ],
    )

    def _boom(*_a, **_k):
        raise AssertionError("HTTP must not run during identity preflight conflict")

    monkeypatch.setattr(verify.core.OPENER, "open", _boom)
    assert verify.main() == 3
    summary = json.loads(capsys.readouterr().out)
    assert summary["ok"] is False
    assert summary["live"]["reason"] == "identity_conflict"
    assert summary["live"]["identitySource"] == "conflict"
    assert summary["live"]["effectiveUserId"] is None
    assert summary["live"]["authed"] is False
    assert "from-wiring-file" not in json.dumps(summary)


def test_verify_live_identity_conflict_exit_3(tmp_path, monkeypatch):
    verify = load_script_module("verify_hooks.py", "runir_grok_verify_identity_ut")
    env_path = tmp_path / "wired.env"
    env_path.write_text(
        "RUNIR_API_KEY=from-wiring-file\nRUNIR_USER_ID=owner\n",
        encoding="utf-8",
    )
    cmd = f'RUNIR_ENV_FILE={shlex.quote(str(env_path))} python3 "x.py"'
    monkeypatch.setenv("RUNIR_API_KEY", "from-process")
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.delenv("RUNIR_ENV_FILE", raising=False)

    effective = verify.resolve_live_identity(cmd, None)
    assert effective.source == "conflict"
    assert effective.user_id is None

    api_key, user_id, source = verify.resolve_live_credential(cmd, None)
    assert source == "process_env"
    assert api_key == "from-process"
    assert user_id is None  # conflict must not silently return process id

    def _boom(*_a, **_k):
        raise AssertionError("HTTP must not run on identity conflict")

    monkeypatch.setattr(verify.urllib.request, "build_opener", _boom)
    code, live = verify.live_recall_probe(
        api_key or "", user_id, source, effective=effective
    )
    assert code == 3
    assert live.get("reason") == "identity_conflict"
    assert live.get("identityConflict")
    assert live.get("effectiveUserId") is None
    assert live.get("authed") is False
    blob = json.dumps(live)
    assert "from-process" not in blob  # no credential in JSON
    assert "owner" not in (live.get("effectiveUserId") or "")


def test_verify_missing_user_id_still_exit_3(monkeypatch):
    verify = load_script_module("verify_hooks.py", "runir_grok_verify_identity_miss_ut")

    def _boom(*_a, **_k):
        raise AssertionError("HTTP must not run when user id missing")

    monkeypatch.setattr(verify.urllib.request, "build_opener", _boom)
    code, live = verify.live_recall_probe("fake-key", None, "process_env")
    assert code == 3
    assert live.get("reason") == "missing_user_id"
    assert live.get("authed") is False
    hint = (live.get("hint") or "").lower()
    assert "invent" in hint or "owner" not in hint


def test_skill_sot_requires_user_id_flag(tmp_path):
    skill = (PLUGIN_ROOT / "skills" / "runir-recall" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    assert "--user-id" in skill
    assert '"$RUNIR_USER_ID"' in skill or "'$RUNIR_USER_ID'" in skill
    assert "identity_conflict" in skill
    assert "refusing to invent" in skill.lower() or "never invent" in skill.lower()
    # Must not document bare get without --user-id as the primary pattern
    assert "get --id" not in skill or "get --user-id" in skill
    # Non-clobber: snapshot process before source, stripping surrounding whitespace
    # with the same POSIX character class used for dotenv identity.
    assert "_PROC_UID" in skill or "BEFORE" in skill or "before" in skill.lower()
    assert '${RUNIR_USER_ID-}' in skill
    assert skill.count("gsub(/^[[:space:]]+|[[:space:]]+$/") >= 2
    # Execute the documented setup in an isolated shell: process identity with
    # surrounding whitespace must agree with the normalized dotenv identity.
    setup = skill.split("```bash", 1)[1].split("```", 1)[0]
    env = os.environ.copy()
    env.update(
        {
            "RUNIR_REPO": str(PLUGIN_ROOT.parents[1]),
            "RUNIR_ENV_FILE": str(tmp_path / "identity.env"),
            "RUNIR_USER_ID": "  brooks  ",
        }
    )
    (tmp_path / "identity.env").write_text(
        "RUNIR_USER_ID=brooks\n", encoding="utf-8"
    )
    proc = subprocess.run(
        ["bash", "-c", setup + '\nprintf "effective=<%s>\\n" "$RUNIR_USER_ID"'],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert "effective=<brooks>" in proc.stdout
    # All five flows mention --user-id
    for verb in ("search", "get", "lineage", "store", "traces"):
        assert f"{verb}" in skill
    assert skill.count("--user-id") >= 5


def test_bridge_default_reads_env_file(tmp_path, monkeypatch):
    bridge = load_script_module("memory_bridge.py", "runir_grok_bridge_identity_ut")
    env_path = tmp_path / "runir.env"
    env_path.write_text("RUNIR_USER_ID=file-user\n", encoding="utf-8")
    monkeypatch.delenv("RUNIR_USER_ID", raising=False)
    monkeypatch.setenv("RUNIR_ENV_FILE", str(env_path))

    seen: dict[str, str | None] = {}

    def fake_fetch(base, user_id, api_key, *, timeout=10.0):
        seen["user_id"] = user_id
        return [], "error:service_down"

    monkeypatch.setattr(bridge, "fetch_runir_facts", fake_fetch)
    result = bridge.sync_once(
        memory_root=tmp_path / "memory",
        state_dir=tmp_path / "state",
        facts=None,
        record_throttle=False,
    )
    assert seen.get("user_id") == "file-user"
    assert result.get("status") == "preserved"


def test_bridge_conflict_errors_loud(tmp_path, monkeypatch):
    bridge = load_script_module("memory_bridge.py", "runir_grok_bridge_conflict_ut")
    env_path = tmp_path / "runir.env"
    env_path.write_text("RUNIR_USER_ID=owner\n", encoding="utf-8")
    monkeypatch.setenv("RUNIR_USER_ID", "brooks")
    monkeypatch.setenv("RUNIR_ENV_FILE", str(env_path))

    def _should_not_fetch(*_a, **_k):
        raise AssertionError("fetch must not run on identity conflict")

    monkeypatch.setattr(bridge, "fetch_runir_facts", _should_not_fetch)
    result = bridge.sync_once(
        memory_root=tmp_path / "memory",
        state_dir=tmp_path / "state",
        facts=None,
        record_throttle=False,
    )
    assert result.get("status") == "error"
    assert "identity_conflict" in str(result.get("reason") or "")
