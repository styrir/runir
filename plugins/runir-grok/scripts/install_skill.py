#!/usr/bin/env python3
"""Install Grok skills from plugin SoT → ~/.grok/skills/<name>/.

Sources of truth: plugins/runir-grok/skills/<name>/SKILL.md
Default installs every skill under skills/ (currently: runir, runir-recall);
narrow with --skill. Does not touch install_hooks.py. Backs up an existing
SKILL.md to .bak on first overwrite (matching install_hooks.py behavior).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


def plugin_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user",
        action="store_true",
        help="Install to ~/.grok/skills/<name>/SKILL.md",
    )
    parser.add_argument(
        "--dest",
        type=Path,
        help="Override destination root (writes <name>/SKILL.md inside)",
    )
    parser.add_argument(
        "--skill",
        action="append",
        help="Skill name to install (repeatable; default: all under skills/)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print summary without writing",
    )
    parser.add_argument(
        "--plugin-root",
        type=Path,
        help="Override plugin root (default: parent of scripts/)",
    )
    return parser.parse_args()


def discover_skills(root: Path) -> list[str]:
    skills_dir = root / "skills"
    if not skills_dir.is_dir():
        return []
    return sorted(
        child.name
        for child in skills_dir.iterdir()
        if (child / "SKILL.md").is_file()
    )


def install_one(
    root: Path, name: str, dest_root: Path, dry_run: bool
) -> dict[str, Any]:
    source = root / "skills" / name / "SKILL.md"
    dest_dir = dest_root / name
    dest = dest_dir / "SKILL.md"
    desired = source.read_text(encoding="utf-8")
    previous = dest.read_text(encoding="utf-8") if dest.is_file() else ""
    changed = desired != previous
    entry: dict[str, Any] = {
        "skill": name,
        "source": str(source),
        "dest": str(dest),
        "changed": changed,
    }
    if dry_run:
        return entry
    dest_dir.mkdir(parents=True, exist_ok=True)
    if changed:
        if dest.is_file():
            bak = dest.with_suffix(dest.suffix + ".bak")
            if not bak.exists():
                shutil.copy2(dest, bak)
                entry["backup"] = str(bak)
            else:
                entry["backup"] = str(bak)
                entry["backupNote"] = "existing .bak left in place"
        dest.write_text(desired, encoding="utf-8")
    return entry


def main() -> int:
    args = parse_args()
    if not args.user and not args.dest:
        print("error: pass --user or --dest", file=sys.stderr)
        return 2

    root = (args.plugin_root or plugin_root()).resolve()
    names = args.skill or discover_skills(root)
    if not names:
        print(f"error: no skills found under {root / 'skills'}", file=sys.stderr)
        return 2
    for name in names:
        source = root / "skills" / name / "SKILL.md"
        if not source.is_file():
            print(f"error: missing skill SoT {source}", file=sys.stderr)
            return 2

    dest_root = (
        args.dest.expanduser().resolve()
        if args.dest
        else (Path.home() / ".grok" / "skills")
    )

    summary: dict[str, Any] = {
        "pluginRoot": str(root),
        "destRoot": str(dest_root),
        "dryRun": bool(args.dry_run),
        "skills": [
            install_one(root, name, dest_root, args.dry_run) for name in names
        ],
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
