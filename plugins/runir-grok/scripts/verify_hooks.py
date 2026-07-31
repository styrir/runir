#!/usr/bin/env python3
"""Verify Rúnir Grok hooks installation at ~/.grok/hooks/runir-grok.json.

Exit 0 when:
- UserPromptSubmit, PreToolUse, Stop are present
- command path resolves to an existing file (plugin SoT)
- PreToolUse matcher is non-empty and != ".*"
- timeouts meet floors: UPS >= 15, PreToolUse >= 5, Stop >= 5
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import sys
from pathlib import Path
from typing import Any

EXPECTED_EVENTS = ("UserPromptSubmit", "PreToolUse", "Stop")
TIMEOUT_FLOORS = {
    "UserPromptSubmit": 15,
    "PreToolUse": 5,
    "Stop": 5,
}


def plugin_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user", action="store_true", help="Verify ~/.grok/hooks/runir-grok.json"
    )
    parser.add_argument("--hooks-file", type=Path, help="Override hooks JSON path")
    parser.add_argument(
        "--plugin-root", type=Path, help="Expected plugin root for command path"
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def first_hook(groups: Any) -> dict[str, Any] | None:
    if not isinstance(groups, list) or not groups:
        return None
    group = groups[0]
    if not isinstance(group, dict):
        return None
    hooks = group.get("hooks")
    if not isinstance(hooks, list) or not hooks:
        return None
    hook = hooks[0]
    return hook if isinstance(hook, dict) else None


def command_script_path(command: str) -> Path | None:
    """Extract the quoted python script path from a command string."""
    if not command:
        return None
    # Prefer last double-quoted path ending in .py
    matches = re.findall(r'"([^"]+\.py)"', command)
    if matches:
        return Path(matches[-1])
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    for part in reversed(parts):
        if part.endswith(".py"):
            return Path(part)
    return None


def main() -> int:
    args = parse_args()
    if not args.user and not args.hooks_file:
        print("error: pass --user or --hooks-file", file=sys.stderr)
        return 2

    root = (args.plugin_root or plugin_root()).resolve()
    hooks_file = (
        args.hooks_file.expanduser().resolve()
        if args.hooks_file
        else (Path.home() / ".grok" / "hooks" / "runir-grok.json")
    )
    expected_script = (root / "hooks" / "runir-grok.py").resolve()
    data = load_json(hooks_file)
    hooks = data.get("hooks") if isinstance(data.get("hooks"), dict) else {}

    errors: list[str] = []
    details: dict[str, Any] = {
        "hooksFile": str(hooks_file),
        "pluginRoot": str(root),
        "expectedScript": str(expected_script),
        "events": {},
    }

    for event in EXPECTED_EVENTS:
        groups = hooks.get(event)
        hook = first_hook(groups)
        event_detail: dict[str, Any] = {"present": hook is not None}
        if hook is None:
            errors.append(f"missing event {event}")
            details["events"][event] = event_detail
            continue
        command = hook.get("command")
        timeout = hook.get("timeout")
        event_detail["command"] = command
        event_detail["timeout"] = timeout
        if not isinstance(command, str) or not command:
            errors.append(f"{event}: empty command")
        else:
            script = command_script_path(command)
            event_detail["scriptPath"] = str(script) if script else None
            if script is None or not script.is_file():
                errors.append(
                    f"{event}: command path does not resolve to existing file: {command}"
                )
            else:
                resolved = script.resolve()
                event_detail["scriptResolved"] = str(resolved)
                if resolved != expected_script:
                    errors.append(
                        f"{event}: command script {resolved} != plugin SoT {expected_script}"
                    )
        floor = TIMEOUT_FLOORS[event]
        if not isinstance(timeout, (int, float)) or float(timeout) < floor:
            errors.append(f"{event}: timeout {timeout!r} below floor {floor}")
        details["events"][event] = event_detail

    # PreToolUse matcher
    matcher = None
    ptu_groups = hooks.get("PreToolUse")
    if isinstance(ptu_groups, list) and ptu_groups and isinstance(ptu_groups[0], dict):
        matcher = ptu_groups[0].get("matcher")
    details["matcher"] = matcher
    if not isinstance(matcher, str) or not matcher.strip():
        errors.append("PreToolUse matcher missing or empty")
    elif matcher == ".*":
        errors.append('PreToolUse matcher must not be ".*"')
    else:
        try:
            re.compile(matcher)
            details["matcherCompiles"] = True
        except re.error as exc:
            errors.append(f"PreToolUse matcher does not compile: {exc}")
            details["matcherCompiles"] = False

    ok = not errors
    summary = {
        "ok": ok,
        "errors": errors,
        **details,
    }
    print(json.dumps(summary, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
