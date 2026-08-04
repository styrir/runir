#!/usr/bin/env python3
"""Install Rúnir Grok hooks into ~/.grok/hooks/runir-grok.json (user scope).

Grok has no marketplace: plugin root is derived from this script's location
(Path(__file__).resolve().parents[1]). Renders templates/user-hooks.json with
__PLUGIN_ROOT__ and optional __ENV_WIRING__ (RUNIR_ENV_FILE=…), then writes the
user hooks JSON. Backs up existing file to .bak on first mutation. Idempotent:
second run reports changed=false.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import shutil
import sys
from pathlib import Path
from typing import Any

# Default path only — never hardcode credential values.
DEFAULT_ENV_FILE = Path.home() / "Code" / "runir" / ".env"


def plugin_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user",
        action="store_true",
        help="Install to ~/.grok/hooks/runir-grok.json (required for machine-local deploy).",
    )
    parser.add_argument(
        "--hooks-file",
        type=Path,
        help="Override destination hooks JSON path.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print desired document and diff summary without writing.",
    )
    parser.add_argument(
        "--plugin-root",
        type=Path,
        help="Override plugin root (default: parent of scripts/).",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help=(
            "Path to dotenv file wired as RUNIR_ENV_FILE into hook commands "
            f"(default: {DEFAULT_ENV_FILE}). Path only — never embeds secrets."
        ),
    )
    parser.add_argument(
        "--no-env-file",
        action="store_true",
        help="Omit RUNIR_ENV_FILE wiring (process env only).",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def resolve_env_file(args: argparse.Namespace) -> Path | None:
    """Return absolute env-file path, or None when wiring is disabled."""
    if args.no_env_file:
        return None
    return args.env_file.expanduser().resolve()


def env_wiring_fragment(env_file: Path | None) -> str:
    """Value for __ENV_WIRING__ (JSON-template text; includes trailing space).

    Uses shlex.quote so the path is single-quoted in the final shell command
    (no $()/backtick expansion at hook runtime). The returned text is also
    JSON-escaped for safe insertion into templates/user-hooks.json before
    json.loads — after loads, command contains: RUNIR_ENV_FILE='/abs/path'.
    """
    if env_file is None:
        return ""
    # Shell-safe assignment (typically single-quoted path).
    assignment = f"RUNIR_ENV_FILE={shlex.quote(str(env_file))} "
    # Escape for embedding inside a JSON double-quoted command string.
    return assignment.replace("\\", "\\\\").replace('"', '\\"')


def render_template(
    template_path: Path, root: Path, env_file: Path | None = None
) -> dict[str, Any]:
    wiring = env_wiring_fragment(env_file)
    text = (
        template_path.read_text(encoding="utf-8")
        .replace("__PLUGIN_ROOT__", str(root))
        .replace("__ENV_WIRING__", wiring)
    )
    # Collapse double space when wiring is empty: "/usr/bin/env  python3" → single space.
    text = re.sub(r"/usr/bin/env  +", "/usr/bin/env ", text)
    data = json.loads(text)
    if not isinstance(data, dict):
        raise SystemExit(f"template root must be object: {template_path}")
    return data


def json_text(value: dict[str, Any]) -> str:
    return json.dumps(value, indent=2) + "\n"


def extract_matcher(doc: dict[str, Any] | None) -> str | None:
    """Legacy helper: PreToolUse matcher (retired; always None on current template)."""
    if not doc:
        return None
    hooks = doc.get("hooks")
    if not isinstance(hooks, dict):
        return None
    groups = hooks.get("PreToolUse")
    if not isinstance(groups, list) or not groups:
        return None
    group = groups[0]
    if not isinstance(group, dict):
        return None
    matcher = group.get("matcher")
    return matcher if isinstance(matcher, str) else None


def is_runir_owned_group(group: dict[str, Any], root: Path) -> bool:
    """True when every command in the group points at this plugin's hook SoT."""
    sot = str((root / "hooks" / "runir-grok.py").resolve())
    hooks = group.get("hooks")
    if not isinstance(hooks, list) or not hooks:
        return False
    saw = False
    for hook in hooks:
        if not isinstance(hook, dict):
            continue
        command = hook.get("command")
        if not isinstance(command, str) or not command:
            continue
        saw = True
        if "runir-grok.py" not in command and sot not in command:
            return False
    return saw


def prune_runir_pre_tool_use(doc: dict[str, Any], root: Path) -> list[str]:
    """Audit PreToolUse groups in a copy of the previous dedicated document.

    The copy retains non-Rúnir groups only so notes can distinguish ownership;
    installation replaces the entire dedicated document with the clean template.
    """
    notes: list[str] = []
    hooks = doc.get("hooks")
    if not isinstance(hooks, dict):
        return notes
    groups = hooks.get("PreToolUse")
    if not isinstance(groups, list) or not groups:
        if "PreToolUse" in hooks:
            del hooks["PreToolUse"]
            notes.append("removed empty PreToolUse key")
        return notes
    kept: list[Any] = []
    removed = 0
    for group in groups:
        if isinstance(group, dict) and is_runir_owned_group(group, root):
            removed += 1
            continue
        kept.append(group)
    if removed:
        notes.append(f"pruned {removed} Rúnir-owned PreToolUse group(s)")
    if kept:
        hooks["PreToolUse"] = kept
        notes.append(
            f"identified {len(kept)} non-Rúnir PreToolUse group(s); "
            "dedicated hook document replacement removes them too"
        )
    else:
        hooks.pop("PreToolUse", None)
    return notes


def extract_commands(doc: dict[str, Any] | None) -> list[str]:
    if not doc:
        return []
    hooks = doc.get("hooks")
    if not isinstance(hooks, dict):
        return []
    commands: list[str] = []
    for _event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict):
                continue
            for hook in group.get("hooks") or []:
                if isinstance(hook, dict) and isinstance(hook.get("command"), str):
                    commands.append(hook["command"])
    return commands


def warn_legacy_copies(root: Path) -> list[str]:
    warnings: list[str] = []
    legacy_py = Path.home() / ".grok" / "hooks" / "runir-grok.py"
    sot = (root / "hooks" / "runir-grok.py").resolve()
    if legacy_py.exists() and legacy_py.resolve() != sot:
        warnings.append(
            f"legacy copy remains at {legacy_py} (inert once JSON command points at plugin SoT; not deleted)"
        )
    pycache = Path.home() / ".grok" / "hooks" / "__pycache__"
    if pycache.is_dir():
        for pyc in pycache.glob("runir-grok*.pyc"):
            warnings.append(f"stale bytecode present: {pyc} (not deleted)")
    return warnings


def main() -> int:
    args = parse_args()
    if not args.user and not args.hooks_file:
        print("error: pass --user or --hooks-file", file=sys.stderr)
        return 2

    root = (args.plugin_root or plugin_root()).resolve()
    template = root / "templates" / "user-hooks.json"
    if not template.is_file():
        print(f"error: missing template {template}", file=sys.stderr)
        return 2
    hook_py = root / "hooks" / "runir-grok.py"
    if not hook_py.is_file():
        print(f"error: missing hook SoT {hook_py}", file=sys.stderr)
        return 2

    try:
        env_file = resolve_env_file(args)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    dest = (
        args.hooks_file.expanduser().resolve()
        if args.hooks_file
        else (Path.home() / ".grok" / "hooks" / "runir-grok.json")
    )
    desired = render_template(template, root, env_file=env_file)
    # This destination is a dedicated Rúnir hook document. Installation replaces
    # it with the clean template; audit notes describe every prior PreToolUse
    # group that replacement removes. A first-overwrite backup preserves the old
    # document for recovery.
    existing = load_json(dest)
    prune_notes: list[str] = []
    if isinstance(existing, dict):
        # Report what would be pruned from the previous document (audit only).
        audit = json.loads(json.dumps(existing))  # deep copy via JSON
        prune_notes = prune_runir_pre_tool_use(audit, root)
    desired_text = json_text(desired)
    previous_text = dest.read_text(encoding="utf-8") if dest.exists() else ""
    changed = desired_text != previous_text

    summary: dict[str, Any] = {
        "pluginRoot": str(root),
        "hooksFile": str(dest),
        "envFile": str(env_file) if env_file else None,
        "dryRun": bool(args.dry_run),
        "changed": changed,
        "matcher": extract_matcher(desired),
        "previousMatcher": extract_matcher(existing),
        "preToolUseReplacement": prune_notes,
        "events": sorted(
            (desired.get("hooks") or {}).keys()
            if isinstance(desired.get("hooks"), dict)
            else []
        ),
        "commands": extract_commands(desired),
        "warnings": warn_legacy_copies(root),
        "diffKeys": {
            "matcherChanged": extract_matcher(existing) != extract_matcher(desired),
            "commandRepath": extract_commands(existing) != extract_commands(desired),
            "preToolUseRemoved": extract_matcher(existing) is not None
            and extract_matcher(desired) is None,
        },
    }

    if args.dry_run:
        print(json.dumps(summary, indent=2))
        print("--- desired ---")
        print(desired_text, end="")
        return 0

    dest.parent.mkdir(parents=True, exist_ok=True)
    if changed:
        if dest.exists():
            bak = dest.with_suffix(dest.suffix + ".bak")
            if not bak.exists():
                shutil.copy2(dest, bak)
                summary["backup"] = str(bak)
            else:
                # Rotate: keep existing .bak, write fresh content only.
                summary["backup"] = str(bak)
                summary["backupNote"] = "existing .bak left in place"
        dest.write_text(desired_text, encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
