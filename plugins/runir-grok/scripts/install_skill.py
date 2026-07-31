#!/usr/bin/env python3
"""Install the /runir Grok skill from plugin SoT → ~/.grok/skills/runir/.

Source of truth: plugins/runir-grok/skills/runir/SKILL.md
Does not touch install_hooks.py. Backs up existing SKILL.md to .bak on first
overwrite (matching install_hooks.py behavior).
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
        help="Install to ~/.grok/skills/runir/SKILL.md",
    )
    parser.add_argument(
        "--dest",
        type=Path,
        help="Override destination directory (writes SKILL.md inside)",
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


def main() -> int:
    args = parse_args()
    if not args.user and not args.dest:
        print("error: pass --user or --dest", file=sys.stderr)
        return 2

    root = (args.plugin_root or plugin_root()).resolve()
    source = root / "skills" / "runir" / "SKILL.md"
    if not source.is_file():
        print(f"error: missing skill SoT {source}", file=sys.stderr)
        return 2

    dest_dir = (
        args.dest.expanduser().resolve()
        if args.dest
        else (Path.home() / ".grok" / "skills" / "runir")
    )
    dest = dest_dir / "SKILL.md"
    desired = source.read_text(encoding="utf-8")
    previous = dest.read_text(encoding="utf-8") if dest.is_file() else ""
    changed = desired != previous

    summary: dict[str, Any] = {
        "pluginRoot": str(root),
        "source": str(source),
        "dest": str(dest),
        "dryRun": bool(args.dry_run),
        "changed": changed,
    }

    if args.dry_run:
        print(json.dumps(summary, indent=2))
        return 0

    dest_dir.mkdir(parents=True, exist_ok=True)
    if changed:
        if dest.is_file():
            bak = dest.with_suffix(dest.suffix + ".bak")
            if not bak.exists():
                shutil.copy2(dest, bak)
                summary["backup"] = str(bak)
            else:
                summary["backup"] = str(bak)
                summary["backupNote"] = "existing .bak left in place"
        dest.write_text(desired, encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
