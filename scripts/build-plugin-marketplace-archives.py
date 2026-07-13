#!/usr/bin/env python3
"""Build clean marketplace-root transport archives for the Claude and Codex plugins."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

EXCLUDED_DIR_NAMES = {"__pycache__", ".pytest_cache"}
EXCLUDED_FILE_NAMES = {".DS_Store"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default="dist/plugins")
    return parser.parse_args()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def should_include(path: Path) -> bool:
    if any(part in EXCLUDED_DIR_NAMES for part in path.parts):
        return False
    if path.name in EXCLUDED_FILE_NAMES:
        return False
    if path.suffix in EXCLUDED_SUFFIXES:
        return False
    return True


def iter_files(root: Path):
    for candidate in sorted(root.rglob("*")):
        if candidate.is_file() and should_include(candidate.relative_to(root)):
            yield candidate


def add_tree(zf: ZipFile, root: Path, arc_prefix: str) -> None:
    for file_path in iter_files(root):
        rel = file_path.relative_to(root)
        zf.write(file_path, f"{arc_prefix}/{rel.as_posix()}")


def build_archive(
    output_dir: Path,
    editor: str,
    plugin_name: str,
    version: str,
    marketplace_file: Path,
    plugin_root: Path,
) -> dict:
    archive_name = f"{plugin_name}-{editor}-marketplace-v{version}.zip"
    archive_path = output_dir / archive_name
    with ZipFile(archive_path, "w", compression=ZIP_DEFLATED) as zf:
        marketplace_rel = (
            ".claude-plugin/marketplace.json" if editor == "claude" else ".agents/plugins/marketplace.json"
        )
        zf.write(marketplace_file, marketplace_rel)
        add_tree(zf, plugin_root, f"plugins/{plugin_name}")

    return {
        "editor": editor,
        "pluginName": plugin_name,
        "version": version,
        "archiveName": archive_name,
        "archivePath": str(archive_path.resolve()),
        "sourcePluginPath": str(plugin_root.resolve()),
        "marketplaceFile": str(marketplace_file.resolve()),
    }


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    output_dir = (repo_root / args.output_dir).resolve() if not Path(args.output_dir).is_absolute() else Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    claude_plugin_root = repo_root / "plugins/runir-claudecode"
    codex_plugin_root = repo_root / "plugins/runir-codex"
    claude_manifest = read_json(claude_plugin_root / ".claude-plugin/plugin.json")
    codex_manifest = read_json(codex_plugin_root / ".codex-plugin/plugin.json")

    archives = [
        build_archive(
            output_dir,
            "claude",
            "runir-claudecode",
            claude_manifest["version"],
            repo_root / ".claude-plugin/marketplace.json",
            claude_plugin_root,
        ),
        build_archive(
            output_dir,
            "codex",
            "runir-codex",
            codex_manifest["version"],
            repo_root / ".agents/plugins/marketplace.json",
            codex_plugin_root,
        ),
    ]

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "outputDir": str(output_dir),
        "archives": archives,
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputDir": str(output_dir), "manifestPath": str(manifest_path), "archives": archives}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
