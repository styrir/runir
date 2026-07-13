#!/usr/bin/env python3
"""Install Rúnir Codex companion hooks into a chosen hooks.json/config.toml pair."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple

COMPANION_FILENAMES = (
    "runir_session_start.py",
    "runir_user_prompt.py",
    "runir_stop_capture.py",
    "gitnexus-hook.cjs",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope", choices=("project", "user"), required=True)
    parser.add_argument("--plugin-name", default="runir-codex")
    parser.add_argument("--marketplace-file")
    parser.add_argument("--hooks-file")
    parser.add_argument("--config-file")
    return parser.parse_args()


def json_text(value: Dict[str, Any]) -> str:
    return json.dumps(value, indent=2) + "\n"


def default_scope_paths(scope: str) -> Tuple[Path, Path]:
    if scope == "project":
        return (Path.cwd() / ".codex/hooks.json", Path.cwd() / ".codex/config.toml")
    home = Path.home()
    return (home / ".codex/hooks.json", home / ".codex/config.toml")


def load_json(path: Path, fallback: Dict[str, Any] | None = None) -> Dict[str, Any]:
    if not path.exists():
        return fallback.copy() if fallback else {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else (fallback.copy() if fallback else {})
    except Exception:
        return fallback.copy() if fallback else {}


def normalize_codex_hooks_document(existing: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any], list[str]]:
    """Return a Codex hooks.json document with only schema-supported root keys."""
    hooks = existing.get("hooks") if isinstance(existing, dict) else {}
    if not isinstance(hooks, dict):
        hooks = {}
    dropped_keys = sorted(key for key in existing.keys() if key != "hooks") if isinstance(existing, dict) else []
    return {"hooks": hooks}, hooks, dropped_keys


def resolve_relative(base: Path, relative_path: str) -> Path:
    rel = Path(relative_path)
    candidates: Iterable[Path] = (
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
    data = load_json(marketplace_file, fallback={"plugins": []})
    plugins = data.get("plugins")
    if not isinstance(plugins, list):
        raise SystemExit(f"invalid marketplace file: {marketplace_file}")

    for entry in plugins:
        if not isinstance(entry, dict) or entry.get("name") != plugin_name:
            continue
        source = entry.get("source")
        if isinstance(source, str):
            candidate = Path(source)
            return (candidate if candidate.is_absolute() else resolve_relative(marketplace_file, source)).resolve()
        if isinstance(source, dict):
            path_value = source.get("path")
            if isinstance(path_value, str) and path_value:
                candidate = Path(path_value)
                return (candidate if candidate.is_absolute() else resolve_relative(marketplace_file, path_value)).resolve()
        raise SystemExit(f"plugin {plugin_name} has no resolvable local source path in {marketplace_file}")

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


def render_template(template_path: Path, plugin_root: Path) -> Dict[str, Any]:
    rendered = template_path.read_text(encoding="utf-8").replace("__PLUGIN_ROOT__", str(plugin_root))
    return json.loads(rendered)


def is_companion_group(group: Any) -> bool:
    if not isinstance(group, dict):
        return False
    hooks = group.get("hooks")
    if not isinstance(hooks, list):
        return False
    for hook in hooks:
        command = hook.get("command") if isinstance(hook, dict) else None
        if isinstance(command, str) and any(filename in command for filename in COMPANION_FILENAMES):
            return True
    return False


def merge_event_groups(existing: Any, desired: Any) -> list:
    existing_groups = existing if isinstance(existing, list) else []
    desired_groups = desired if isinstance(desired, list) else []
    preserved = [group for group in existing_groups if not is_companion_group(group)]
    return desired_groups + preserved


def ensure_codex_hooks_flag(config_path: Path) -> bool:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    existing = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    if re.search(r"(?m)^\s*hooks\s*=\s*true\s*$", existing):
        return False
    if re.search(r"(?m)^\s*hooks\s*=\s*false\s*$", existing):
        updated = re.sub(r"(?m)^\s*hooks\s*=\s*false\s*$", "hooks = true", existing, count=1)
    elif "[features]" in existing:
        updated = existing.replace("[features]", "[features]\nhooks = true", 1)
    else:
        updated = existing.rstrip()
        if updated:
            updated += "\n\n"
        updated += "[features]\nhooks = true\n"
    config_path.write_text(updated, encoding="utf-8")
    return updated != existing


def main() -> int:
    args = parse_args()
    hooks_path, config_path = default_scope_paths(args.scope)
    if args.hooks_file:
        hooks_path = Path(args.hooks_file)
    if args.config_file:
        config_path = Path(args.config_file)

    marketplace_file = Path(args.marketplace_file).resolve() if args.marketplace_file else detect_marketplace_file(args.plugin_name)
    plugin_root = resolve_plugin_root(marketplace_file, args.plugin_name)
    template_name = "project-hooks.json" if args.scope == "project" else "user-hooks.json"
    desired = render_template(plugin_root / "templates" / template_name, plugin_root)

    hooks_path.parent.mkdir(parents=True, exist_ok=True)
    existing = load_json(hooks_path, fallback={"hooks": {}})
    normalized, hooks, dropped_top_level_keys = normalize_codex_hooks_document(existing)

    changed = False
    desired_hooks = desired.get("hooks", {})
    for event_name, desired_groups in desired_hooks.items():
        merged = merge_event_groups(hooks.get(event_name), desired_groups)
        if hooks.get(event_name) != merged:
            hooks[event_name] = merged
            changed = True

    serialized = json_text(normalized)
    previous_text = hooks_path.read_text(encoding="utf-8") if hooks_path.exists() else ""
    if serialized != previous_text:
        hooks_path.write_text(serialized, encoding="utf-8")
        changed = True

    config_changed = ensure_codex_hooks_flag(config_path)
    summary = {
        "scope": args.scope,
        "pluginName": args.plugin_name,
        "pluginRoot": str(plugin_root),
        "marketplaceFile": str(marketplace_file),
        "hooksFile": str(hooks_path),
        "configFile": str(config_path),
        "changed": changed or config_changed,
        "hooksChanged": changed,
        "configChanged": config_changed,
        "droppedTopLevelKeys": dropped_top_level_keys,
    }
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
