"""Observability: install_skill.py + verify_hooks.py --skill."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import PLUGIN_ROOT, load_script_module  # noqa: E402


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


def test_install_skill_and_verify(tmp_path):
    install = load_script_module("install_skill.py")
    dest_root = tmp_path / "skills"
    code, out = _run_main(
        install,
        [
            "install_skill.py",
            "--dest",
            str(dest_root),
            "--skill",
            "runir",
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 0, out
    summary = json.loads(out)
    assert [s["skill"] for s in summary["skills"]] == ["runir"]
    assert summary["skills"][0]["changed"] is True
    skill = dest_root / "runir" / "SKILL.md"
    assert skill.is_file()
    text = skill.read_text(encoding="utf-8")
    assert "user-invocable: true" in text
    assert "disable-model-invocation: true" in text
    assert "runir_inspect.py" in text

    verify = load_script_module("verify_hooks.py")
    code, out = _run_main(
        verify,
        [
            "verify_hooks.py",
            "--skill",
            "--skills-root",
            str(tmp_path / "skills"),
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 0, out
    data = json.loads(out)
    assert data["ok"] is True
    assert data["skill"]["userInvocable"] is True
    assert data["skill"]["disableModelInvocation"] is True
    assert data["skill"]["inspectPresent"] is True

    # Missing skill fails
    empty = tmp_path / "empty-skills"
    empty.mkdir()
    code, out = _run_main(
        verify,
        [
            "verify_hooks.py",
            "--skill",
            "--skills-root",
            str(empty),
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code != 0
    data = json.loads(out)
    assert data["ok"] is False
