"""Credential loading via RUNIR_ENV_FILE (ops-3kp).

Tests pure functions with injected env dicts — conftest caches the module, so
monkeypatch.setenv + reload is not reliable.
"""

from __future__ import annotations


def test_read_dotenv_value_plain(tmp_path, hook):
    env_path = tmp_path / ".env"
    env_path.write_text("RUNIR_API_KEY=plain-secret\n", encoding="utf-8")
    assert hook.read_dotenv_value(str(env_path), "RUNIR_API_KEY") == "plain-secret"


def test_read_dotenv_value_double_and_single_quoted(tmp_path, hook):
    env_path = tmp_path / ".env"
    env_path.write_text(
        "RUNIR_API_KEY=\"double-quoted\"\nRUNIR_USER_ID='single-quoted'\n",
        encoding="utf-8",
    )
    assert hook.read_dotenv_value(str(env_path), "RUNIR_API_KEY") == "double-quoted"
    assert hook.read_dotenv_value(str(env_path), "RUNIR_USER_ID") == "single-quoted"


def test_read_dotenv_value_skips_comments_blanks_and_prefix_collisions(tmp_path, hook):
    env_path = tmp_path / ".env"
    env_path.write_text(
        "\n"
        "# RUNIR_API_KEY=commented\n"
        "RUNIR_API_KEY_OLD=stale\n"
        "RUNIR_API_KEY=real-key\n"
        "RUNIR_API_KEY_EXTRA=other\n",
        encoding="utf-8",
    )
    assert hook.read_dotenv_value(str(env_path), "RUNIR_API_KEY") == "real-key"


def test_read_dotenv_value_missing_key_returns_none(tmp_path, hook):
    env_path = tmp_path / ".env"
    env_path.write_text("OTHER=1\n", encoding="utf-8")
    assert hook.read_dotenv_value(str(env_path), "RUNIR_API_KEY") is None


def test_read_dotenv_value_missing_file_is_silent(tmp_path, hook):
    missing = tmp_path / "no-such.env"
    assert hook.read_dotenv_value(str(missing), "RUNIR_API_KEY") is None


def test_read_dotenv_value_empty_value_returns_none(tmp_path, hook):
    env_path = tmp_path / ".env"
    env_path.write_text('RUNIR_API_KEY=\nRUNIR_USER_ID=""\n', encoding="utf-8")
    assert hook.read_dotenv_value(str(env_path), "RUNIR_API_KEY") is None
    assert hook.read_dotenv_value(str(env_path), "RUNIR_USER_ID") is None


def test_resolve_credential_prefers_process_env(tmp_path, hook):
    env_path = tmp_path / ".env"
    env_path.write_text("RUNIR_API_KEY=from-file\n", encoding="utf-8")
    env = {
        "RUNIR_API_KEY": "from-process",
        "RUNIR_ENV_FILE": str(env_path),
    }
    assert hook.resolve_credential("RUNIR_API_KEY", env) == "from-process"


def test_resolve_credential_falls_back_to_env_file(tmp_path, hook):
    env_path = tmp_path / ".env"
    env_path.write_text("RUNIR_API_KEY=from-file\n", encoding="utf-8")
    env = {"RUNIR_ENV_FILE": str(env_path)}
    assert hook.resolve_credential("RUNIR_API_KEY", env) == "from-file"


def test_resolve_credential_no_env_file_returns_none(hook):
    assert hook.resolve_credential("RUNIR_API_KEY", {}) is None
    assert hook.resolve_credential("RUNIR_API_KEY", {"RUNIR_ENV_FILE": ""}) is None


def test_resolve_credential_user_id_uses_same_path(tmp_path, hook):
    env_path = tmp_path / ".env"
    env_path.write_text("RUNIR_USER_ID=owner-from-file\n", encoding="utf-8")
    env = {"RUNIR_ENV_FILE": str(env_path)}
    assert hook.resolve_credential("RUNIR_USER_ID", env) == "owner-from-file"


def test_api_key_resolves_when_only_env_file_is_set(tmp_path, hook):
    """Regression: live Grok hooks set RUNIR_ENV_FILE only — no process RUNIR_API_KEY."""
    env_path = tmp_path / ".env"
    env_path.write_text(
        "RUNIR_USER_ID=owner\nRUNIR_API_KEY=only-from-env-file\n",
        encoding="utf-8",
    )
    env = {"RUNIR_ENV_FILE": str(env_path)}
    assert "RUNIR_API_KEY" not in env
    assert hook.resolve_credential("RUNIR_API_KEY", env) == "only-from-env-file"
    assert hook.resolve_credential("RUNIR_USER_ID", env) == "owner"
