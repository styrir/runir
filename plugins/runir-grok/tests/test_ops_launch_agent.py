"""Ops: install_launch_agent.py + verify_hooks --launch-agent (offline)."""

from __future__ import annotations

import json
import plistlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import PLUGIN_ROOT, load_script_module  # noqa: E402

LABEL = "com.runir.embed-warm"


def _run_main(mod, argv: list[str]) -> tuple[int, str]:
    old = sys.argv
    try:
        sys.argv = [argv[0], *argv[1:]]
        import io
        from contextlib import redirect_stdout, redirect_stderr

        buf = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(err):
            code = mod.main()
        return code, buf.getvalue() + err.getvalue()
    finally:
        sys.argv = old


def test_plist_sot_valid_and_portable():
    sot = PLUGIN_ROOT / "launchd" / f"{LABEL}.plist"
    assert sot.is_file()
    raw = sot.read_bytes()
    assert b"/Users/" not in raw
    data = plistlib.loads(raw)
    assert data["Label"] == LABEL
    assert data["RunAtLoad"] is True
    assert data["StartInterval"] == 240
    args = data["ProgramArguments"]
    assert any("/api/embed" in str(a) for a in args)
    payload_arg = next(a for a in args if isinstance(a, str) and a.startswith("{"))
    payload = json.loads(payload_arg)
    assert payload["keep_alive"] == -1
    assert payload["model"] == "nomic-embed-text:v1.5"


def test_install_writes_and_is_idempotent(tmp_path):
    install = load_script_module("install_launch_agent.py")
    agents = tmp_path / "LaunchAgents"
    argv_base = [
        "install_launch_agent.py",
        "--agents-dir",
        str(agents),
        "--no-load",
        "--plugin-root",
        str(PLUGIN_ROOT),
    ]
    code, out = _run_main(install, argv_base)
    assert code == 0, out
    summary = json.loads(out)
    assert summary["changed"] is True
    dest = agents / f"{LABEL}.plist"
    assert dest.is_file()
    sot = PLUGIN_ROOT / "launchd" / f"{LABEL}.plist"
    assert dest.read_bytes() == sot.read_bytes()

    code2, out2 = _run_main(install, argv_base)
    assert code2 == 0, out2
    summary2 = json.loads(out2)
    assert summary2["changed"] is False


def test_dry_run_writes_nothing(tmp_path):
    install = load_script_module("install_launch_agent.py")
    agents = tmp_path / "LaunchAgents"
    code, out = _run_main(
        install,
        [
            "install_launch_agent.py",
            "--agents-dir",
            str(agents),
            "--no-load",
            "--dry-run",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 0, out
    summary = json.loads(out)
    assert summary["dryRun"] is True
    assert summary["changed"] is True  # would change if written
    assert not (agents / f"{LABEL}.plist").exists()


def test_backs_up_existing_plist(tmp_path):
    install = load_script_module("install_launch_agent.py")
    agents = tmp_path / "LaunchAgents"
    agents.mkdir()
    dest = agents / f"{LABEL}.plist"
    old = b"<?xml version='1.0'?><plist><dict></dict></plist>\n"
    dest.write_bytes(old)
    code, out = _run_main(
        install,
        [
            "install_launch_agent.py",
            "--agents-dir",
            str(agents),
            "--no-load",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 0, out
    summary = json.loads(out)
    assert summary["changed"] is True
    bak = dest.with_suffix(dest.suffix + ".bak")
    assert bak.is_file()
    assert bak.read_bytes() == old


def test_uninstall_removes_and_is_idempotent(tmp_path):
    install = load_script_module("install_launch_agent.py")
    agents = tmp_path / "LaunchAgents"
    argv_install = [
        "install_launch_agent.py",
        "--agents-dir",
        str(agents),
        "--no-load",
        "--plugin-root",
        str(PLUGIN_ROOT),
    ]
    code, out = _run_main(install, argv_install)
    assert code == 0, out
    dest = agents / f"{LABEL}.plist"
    assert dest.is_file()

    argv_rm = [
        "install_launch_agent.py",
        "--agents-dir",
        str(agents),
        "--no-load",
        "--uninstall",
        "--plugin-root",
        str(PLUGIN_ROOT),
    ]
    code2, out2 = _run_main(install, argv_rm)
    assert code2 == 0, out2
    summary2 = json.loads(out2)
    assert summary2["removed"] is True
    assert not dest.exists()

    code3, out3 = _run_main(install, argv_rm)
    assert code3 == 0, out3
    summary3 = json.loads(out3)
    assert summary3["removed"] is False


def test_verify_launch_agent_ok_drift_and_missing(tmp_path):
    install = load_script_module("install_launch_agent.py")
    verify = load_script_module("verify_hooks.py")
    agents = tmp_path / "LaunchAgents"
    # Missing → fail
    code, out = _run_main(
        verify,
        [
            "verify_hooks.py",
            "--launch-agent",
            "--agents-dir",
            str(agents),
            "--no-launchctl",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code != 0
    data = json.loads(out)
    assert data["ok"] is False

    # Install → ok
    code_i, out_i = _run_main(
        install,
        [
            "install_launch_agent.py",
            "--agents-dir",
            str(agents),
            "--no-load",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code_i == 0, out_i
    code2, out2 = _run_main(
        verify,
        [
            "verify_hooks.py",
            "--launch-agent",
            "--agents-dir",
            str(agents),
            "--no-launchctl",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code2 == 0, out2
    data2 = json.loads(out2)
    assert data2["ok"] is True
    assert data2["launchAgent"]["matchesSot"] is True
    assert data2["launchAgent"]["present"] is True

    # Drift → fail
    dest = agents / f"{LABEL}.plist"
    dest.write_bytes(dest.read_bytes() + b"\n")
    code3, out3 = _run_main(
        verify,
        [
            "verify_hooks.py",
            "--launch-agent",
            "--agents-dir",
            str(agents),
            "--no-launchctl",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code3 != 0
    data3 = json.loads(out3)
    assert data3["ok"] is False
    assert any("drifted" in e for e in data3["errors"])


def test_expiry_is_resident_predicate():
    verify = load_script_module("verify_hooks.py")
    assert verify.expiry_is_resident("9999-12-31T00:00:00Z") is True
    assert verify.expiry_is_resident("292278994-08-17T07:12:55.35Z") is True
    assert verify.expiry_is_resident("2026-08-01T12:00:00Z") is False
    assert verify.expiry_is_resident("") is False
    assert verify.expiry_is_resident(None) is False
    assert verify.expiry_is_resident("not-a-date") is False


def test_install_exit_nonzero_when_not_loaded_after_bootstrap(tmp_path, monkeypatch):
    """MAJOR fix: bootstrap may report ok but print shows not loaded → exit 1."""
    install = load_script_module("install_launch_agent.py")
    agents = tmp_path / "LaunchAgents"
    monkeypatch.setattr(install, "launchctl_bootout", lambda _label: None)
    monkeypatch.setattr(install, "launchctl_bootstrap", lambda _dest: (True, ""))
    # First print (currently_loaded) → False; post-bootstrap print → False
    monkeypatch.setattr(install, "launchctl_print_loaded", lambda _label: False)
    code, out = _run_main(
        install,
        [
            "install_launch_agent.py",
            "--agents-dir",
            str(agents),
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 1, out
    summary = json.loads(out)
    assert summary["loaded"] is False
    assert summary["changed"] is True
    assert (agents / f"{LABEL}.plist").is_file()


def test_install_exit_zero_when_loaded_after_bootstrap(tmp_path, monkeypatch):
    install = load_script_module("install_launch_agent.py")
    agents = tmp_path / "LaunchAgents"
    monkeypatch.setattr(install, "launchctl_bootout", lambda _label: None)
    monkeypatch.setattr(install, "launchctl_bootstrap", lambda _dest: (True, ""))
    # not currently loaded → bootstrap path; then final print → loaded
    states = iter([False, True])
    monkeypatch.setattr(
        install, "launchctl_print_loaded", lambda _label: next(states)
    )
    code, out = _run_main(
        install,
        [
            "install_launch_agent.py",
            "--agents-dir",
            str(agents),
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 0, out
    summary = json.loads(out)
    assert summary["loaded"] is True
    assert summary["reloaded"] is True


def test_uninstall_exit_nonzero_when_still_loaded(tmp_path, monkeypatch):
    """MAJOR fix: bootout claimed done but print still loaded → exit 1."""
    install = load_script_module("install_launch_agent.py")
    agents = tmp_path / "LaunchAgents"
    agents.mkdir()
    dest = agents / f"{LABEL}.plist"
    dest.write_bytes(b"<plist/>")
    monkeypatch.setattr(install, "launchctl_bootout", lambda _label: None)
    monkeypatch.setattr(install, "launchctl_print_loaded", lambda _label: True)
    code, out = _run_main(
        install,
        [
            "install_launch_agent.py",
            "--agents-dir",
            str(agents),
            "--uninstall",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 1, out
    summary = json.loads(out)
    assert summary["loaded"] is True
    assert summary["removed"] is True
    assert not dest.exists()


def test_uninstall_exit_zero_when_not_loaded(tmp_path, monkeypatch):
    install = load_script_module("install_launch_agent.py")
    agents = tmp_path / "LaunchAgents"
    agents.mkdir()
    dest = agents / f"{LABEL}.plist"
    dest.write_bytes(b"<plist/>")
    monkeypatch.setattr(install, "launchctl_bootout", lambda _label: None)
    monkeypatch.setattr(install, "launchctl_print_loaded", lambda _label: False)
    code, out = _run_main(
        install,
        [
            "install_launch_agent.py",
            "--agents-dir",
            str(agents),
            "--uninstall",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 0, out
    summary = json.loads(out)
    assert summary["loaded"] is False
    assert summary["removed"] is True
