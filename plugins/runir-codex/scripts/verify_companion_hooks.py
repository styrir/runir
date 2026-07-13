#!/usr/bin/env python3
"""Report the active Rúnir Codex companion hook installation mode."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict

EXPECTED_EVENT_FILENAMES = {
    "SessionStart": "runir_session_start.py",
    "UserPromptSubmit": "runir_user_prompt.py",
    "Stop": "runir_stop_capture.py",
    "PreToolUse": "gitnexus-hook.cjs",
    "PostToolUse": "gitnexus-hook.cjs",
}
SUPPORTED_HOOKS_JSON_ROOT_KEYS = {"hooks"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-name", default="runir-codex")
    parser.add_argument("--marketplace-file")
    parser.add_argument("--project-hooks-file", default=str(Path.cwd() / ".codex/hooks.json"))
    parser.add_argument("--project-config-file", default=str(Path.cwd() / ".codex/config.toml"))
    parser.add_argument("--user-hooks-file", default=str(Path.home() / ".codex/hooks.json"))
    parser.add_argument("--user-config-file", default=str(Path.home() / ".codex/config.toml"))
    return parser.parse_args()


def load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def unsupported_top_level_keys(data: Dict[str, Any]) -> list[str]:
    return sorted(key for key in data.keys() if key not in SUPPORTED_HOOKS_JSON_ROOT_KEYS)


def resolve_relative(base: Path, relative_path: str) -> Path:
    rel = Path(relative_path)
    candidates = (
        base.parent / rel,
        base.parent.parent / rel,
        base.parent.parent.parent / rel,
        Path.cwd() / rel,
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return (base.parent / rel).resolve()


def resolve_plugin_root(marketplace_file: Path, plugin_name: str) -> Path:
    data = load_json(marketplace_file)
    plugins = data.get("plugins", [])
    for entry in plugins:
        if not isinstance(entry, dict) or entry.get("name") != plugin_name:
            continue
        source = entry.get("source")
        if isinstance(source, str):
            candidate = Path(source)
            return (candidate if candidate.is_absolute() else resolve_relative(marketplace_file, source)).resolve()
        if isinstance(source, dict):
            path_value = source.get("path")
            if isinstance(path_value, str):
                candidate = Path(path_value)
                return (candidate if candidate.is_absolute() else resolve_relative(marketplace_file, path_value)).resolve()
    raise SystemExit(f"plugin {plugin_name} not found in {marketplace_file}")


def detect_marketplace_file(plugin_name: str) -> Path:
    candidates = (
        Path.home() / ".codex/.tmp/plugins/.agents/plugins/marketplace.json",
        Path.cwd() / ".agents/plugins/marketplace.json",
    )
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            resolve_plugin_root(candidate.resolve(), plugin_name)
            return candidate.resolve()
        except SystemExit:
            continue
    raise SystemExit(f"could not find a marketplace file for plugin {plugin_name}")


def _expected_command_suffix(plugin_root: Path, filename: str) -> str:
    return str((plugin_root / "hooks" / filename).resolve())


def _command_matches_expected(command: str, plugin_root: Path, filename: str) -> bool:
    return _expected_command_suffix(plugin_root, filename) in command


def hooks_installed(path: Path, plugin_root: Path) -> bool:
    data = load_json(path)
    if unsupported_top_level_keys(data):
        return False
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return False
    for event_name, filename in EXPECTED_EVENT_FILENAMES.items():
        event_groups = hooks.get(event_name)
        if not isinstance(event_groups, list):
            return False
        matched = False
        for group in event_groups:
            if not isinstance(group, dict):
                continue
            hook_items = group.get("hooks")
            if not isinstance(hook_items, list):
                continue
            for hook in hook_items:
                command = hook.get("command") if isinstance(hook, dict) else None
                if isinstance(command, str) and _command_matches_expected(command, plugin_root, filename):
                    matched = True
                    break
            if matched:
                break
        if not matched:
            return False
    return True


def hooks_enabled(config_path: Path) -> bool:
    if not config_path.exists():
        return False
    config = config_path.read_text(encoding="utf-8")
    return re.search(r"(?m)^\s*(?:hooks|codex_hooks)\s*=\s*true\s*$", config) is not None


def main() -> int:
    args = parse_args()
    marketplace_file = Path(args.marketplace_file).resolve() if args.marketplace_file else detect_marketplace_file(args.plugin_name)
    plugin_root = resolve_plugin_root(marketplace_file, args.plugin_name)

    project_hooks_file = Path(args.project_hooks_file)
    project_config_file = Path(args.project_config_file)
    user_hooks_file = Path(args.user_hooks_file)
    user_config_file = Path(args.user_config_file)

    project_installed = hooks_installed(project_hooks_file, plugin_root)
    user_installed = hooks_installed(user_hooks_file, plugin_root)
    project_unsupported_keys = unsupported_top_level_keys(load_json(project_hooks_file))
    user_unsupported_keys = unsupported_top_level_keys(load_json(user_hooks_file))

    mode = "none"
    if project_installed and user_installed:
        mode = "both"
    elif project_installed:
        mode = "project"
    elif user_installed:
        mode = "user"

    summary = {
        "pluginName": args.plugin_name,
        "pluginRoot": str(plugin_root),
        "mode": mode,
        "warnings": (
            (["both project and user hooks are active"] if mode == "both" else [])
            + ([f"project hooks file has unsupported top-level keys: {', '.join(project_unsupported_keys)}"] if project_unsupported_keys else [])
            + ([f"user hooks file has unsupported top-level keys: {', '.join(user_unsupported_keys)}"] if user_unsupported_keys else [])
        ),
        "project": {
            "hooksFile": str(project_hooks_file),
            "configFile": str(project_config_file),
            "hooksInstalled": project_installed,
            "hooksEnabled": hooks_enabled(project_config_file),
            "unsupportedTopLevelKeys": project_unsupported_keys,
        },
        "user": {
            "hooksFile": str(user_hooks_file),
            "configFile": str(user_config_file),
            "hooksInstalled": user_installed,
            "hooksEnabled": hooks_enabled(user_config_file),
            "unsupportedTopLevelKeys": user_unsupported_keys,
        },
    }
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
