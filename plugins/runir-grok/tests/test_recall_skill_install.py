"""Rúnir-6l9: runir-recall skill content + install_skill.py multi-skill install."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import PLUGIN_ROOT, load_script_module  # noqa: E402

SKILL_PATH = PLUGIN_ROOT / "skills" / "runir-recall" / "SKILL.md"
INSPECT_SKILL_PATH = PLUGIN_ROOT / "skills" / "runir" / "SKILL.md"

REQUIRED_VERBS = ["search", "get", "lineage", "traces rate", "store"]
FORBIDDEN_VERBS = ["forget", "think", "graph", "restore"]
# Hook-plumbing commands must not appear as taught commands (code spans).
# Prose uses of the word "recall" are fine; backticked verbs are not.
PLUMBING_CODE_SPAN = re.compile(r"`(recall|capture|session-end)\b")


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


def _split_frontmatter(text: str) -> tuple[str, str]:
    assert text.startswith("---\n"), "frontmatter must open the file"
    end = text.index("\n---", 4)
    return text[4:end], text[end + 4 :]


def test_recall_skill_frontmatter_model_invocable():
    text = SKILL_PATH.read_text(encoding="utf-8")
    frontmatter, _body = _split_frontmatter(text)
    assert "disable-model-invocation" not in frontmatter
    assert "name: runir-recall" in frontmatter
    assert "description:" in frontmatter
    # Frontmatter parses as YAML if available; otherwise the structural
    # asserts above stand alone.
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(frontmatter)
        assert data["name"] == "runir-recall"
        assert "disable-model-invocation" not in data
    except ModuleNotFoundError:
        pass


def test_recall_skill_teaches_five_verbs_only():
    text = SKILL_PATH.read_text(encoding="utf-8")
    _frontmatter, body = _split_frontmatter(text)
    for verb in REQUIRED_VERBS:
        assert verb in body, f"missing verb: {verb}"
    for verb in FORBIDDEN_VERBS:
        assert not re.search(rf"\b{verb}\b", body), f"forbidden verb: {verb}"
    # Plumbing verbs must not be taught (not even as prohibitions — naming
    # them primes the model to try them).
    assert not PLUMBING_CODE_SPAN.search(body), "plumbing verb in code span"
    assert "cli/index.ts" in body, "must state the working invocation"
    assert "RUNIR_URL" in body and "RUNIR_API_KEY" in body


def test_inspect_skill_discloses_prompt_retention():
    text = INSPECT_SKILL_PATH.read_text(encoding="utf-8")
    assert "latest original prompt" in text
    assert "owner-only (`0600`)" in text
    assert "no automatic TTL" in text
    assert "No secrets, prompts" not in text


def test_install_skill_installs_both(tmp_path):
    install = load_script_module("install_skill.py")
    dest_root = tmp_path / "skills"
    code, out = _run_main(
        install,
        [
            "install_skill.py",
            "--dest",
            str(dest_root),
            "--plugin-root",
            str(PLUGIN_ROOT),
        ],
    )
    assert code == 0, out
    summary = json.loads(out)
    names = [s["skill"] for s in summary["skills"]]
    assert "runir" in names and "runir-recall" in names
    for name in names:
        assert (dest_root / name / "SKILL.md").is_file()
    recall_text = (dest_root / "runir-recall" / "SKILL.md").read_text(encoding="utf-8")
    assert "disable-model-invocation" not in recall_text


def test_install_skill_dry_run_writes_nothing(tmp_path):
    install = load_script_module("install_skill.py")
    dest_root = tmp_path / "skills"
    code, out = _run_main(
        install,
        [
            "install_skill.py",
            "--dest",
            str(dest_root),
            "--plugin-root",
            str(PLUGIN_ROOT),
            "--dry-run",
        ],
    )
    assert code == 0, out
    assert not dest_root.exists()
