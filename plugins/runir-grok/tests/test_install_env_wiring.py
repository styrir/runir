"""Template + installer RUNIR_ENV_FILE wiring (ops-3kp)."""

from __future__ import annotations

import importlib.util
import json
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SCRIPT = PLUGIN_ROOT / "scripts" / "install_hooks.py"
TEMPLATE = PLUGIN_ROOT / "templates" / "user-hooks.json"


def load_install_module():
    name = "runir_grok_install_hooks_under_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, INSTALL_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def install_mod():
    return load_install_module()


def test_render_template_injects_env_file_into_all_three_commands(
    tmp_path, install_mod
):
    env_file = tmp_path / "runir.env"
    env_file.write_text("RUNIR_API_KEY=should-not-appear\n", encoding="utf-8")
    root = PLUGIN_ROOT
    doc = install_mod.render_template(TEMPLATE, root, env_file=env_file.resolve())
    commands = install_mod.extract_commands(doc)
    assert len(commands) == 3
    # Shell-safe: shlex.quote → single-quoted path (no $() expansion).
    expected_frag = f"RUNIR_ENV_FILE={shlex.quote(str(env_file.resolve()))}"
    for cmd in commands:
        assert expected_frag in cmd
        assert f'python3 "{root}/hooks/runir-grok.py"' in cmd or str(root) in cmd
        assert cmd.startswith("/usr/bin/env ")
        assert "__ENV_WIRING__" not in cmd
        assert "__PLUGIN_ROOT__" not in cmd
        # Must not use bare double-quoted path (review r1 major).
        assert f'RUNIR_ENV_FILE="{env_file.resolve()}"' not in cmd


def test_render_template_without_env_file_leaves_plain_env_python(install_mod):
    doc = install_mod.render_template(TEMPLATE, PLUGIN_ROOT, env_file=None)
    commands = install_mod.extract_commands(doc)
    assert len(commands) == 3
    for cmd in commands:
        assert "RUNIR_ENV_FILE=" not in cmd
        assert cmd.startswith("/usr/bin/env python3 ")
        assert "__ENV_WIRING__" not in cmd


def test_render_template_collapses_double_space_when_wiring_empty(install_mod):
    doc = install_mod.render_template(TEMPLATE, PLUGIN_ROOT, env_file=None)
    for cmd in install_mod.extract_commands(doc):
        assert "/usr/bin/env  " not in cmd
        assert cmd.startswith("/usr/bin/env python3 ")


def test_render_template_output_contains_no_secret_value(tmp_path, install_mod):
    secret = "super-secret-api-key-value-xyz"
    env_file = tmp_path / ".env"
    env_file.write_text(f"RUNIR_API_KEY={secret}\n", encoding="utf-8")
    doc = install_mod.render_template(
        TEMPLATE, PLUGIN_ROOT, env_file=env_file.resolve()
    )
    rendered = json.dumps(doc)
    assert secret not in rendered
    assert str(env_file.resolve()) in rendered


def test_env_wiring_fragment_shell_safe_no_expansion(tmp_path, install_mod):
    """Paths with $() / backticks stay literal under single quotes (review r1 major)."""
    evil = tmp_path / "evil-$(printf INJECT).env"
    evil.write_text("RUNIR_API_KEY=x\n", encoding="utf-8")
    # After JSON-escape round-trip via render, command must keep path single-quoted.
    doc = install_mod.render_template(TEMPLATE, PLUGIN_ROOT, env_file=evil.resolve())
    cmd = install_mod.extract_commands(doc)[0]
    expected = f"RUNIR_ENV_FILE={shlex.quote(str(evil.resolve()))}"
    assert expected in cmd
    # Metachar path must be single-quoted by shlex.quote (not double-quoted).
    assert "RUNIR_ENV_FILE='" in cmd
    assert f'RUNIR_ENV_FILE="{evil.resolve()}"' not in cmd
    # Prove shell does not expand $() inside the single-quoted path.
    bash = subprocess.run(
        [
            "bash",
            "-c",
            f"eval {shlex.quote(expected)}; printf '%s' \"$RUNIR_ENV_FILE\"",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert bash.returncode == 0, bash.stderr
    assert bash.stdout == str(evil.resolve())
    # Literal $(printf INJECT) remains in the path string (not executed).
    assert "$(printf INJECT)" in bash.stdout


def test_install_idempotent_with_env_file(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("RUNIR_API_KEY=fake\n", encoding="utf-8")
    hooks_file = tmp_path / "runir-grok.json"
    cmd = [
        sys.executable,
        str(INSTALL_SCRIPT),
        "--hooks-file",
        str(hooks_file),
        "--plugin-root",
        str(PLUGIN_ROOT),
        "--env-file",
        str(env_file),
    ]
    first = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert first.returncode == 0, first.stderr
    summary1 = json.loads(first.stdout)
    assert summary1["changed"] is True
    assert summary1["envFile"] == str(env_file.resolve())
    assert all("RUNIR_ENV_FILE=" in c for c in summary1["commands"])
    assert "fake" not in first.stdout

    second = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert second.returncode == 0, second.stderr
    summary2 = json.loads(second.stdout)
    assert summary2["changed"] is False
