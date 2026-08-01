#!/usr/bin/env python3
"""Install the embed-warm LaunchAgent from plugin SoT → ~/Library/LaunchAgents/.

Source of truth: plugins/runir-grok/launchd/com.runir.embed-warm.plist
Sibling of install_hooks.py / install_skill.py — does not touch hooks.
Idempotent: content compare, .bak on first overwrite, launchctl bootstrap only
when the plist changed or the agent is not loaded.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

LABEL = "com.runir.embed-warm"


def plugin_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user",
        action="store_true",
        help="Install to ~/Library/LaunchAgents/",
    )
    parser.add_argument(
        "--agents-dir",
        type=Path,
        help="Override LaunchAgents directory (writes plist inside; for tests)",
    )
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="Bootout and remove the installed plist (idempotent)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print summary without writing or launchctl",
    )
    parser.add_argument(
        "--no-load",
        action="store_true",
        help="Skip all launchctl calls (tests / offline)",
    )
    parser.add_argument(
        "--plugin-root",
        type=Path,
        help="Override plugin root (default: parent of scripts/)",
    )
    return parser.parse_args()


def domain() -> str:
    return f"gui/{os.getuid()}"


def launchctl_print_loaded(label: str) -> bool:
    """Return True when launchctl print domain/label succeeds."""
    try:
        result = subprocess.run(
            ["launchctl", "print", f"{domain()}/{label}"],
            capture_output=True,
            timeout=10,
            check=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def launchctl_bootout(label: str) -> None:
    """Best-effort bootout; not-loaded is fine."""
    try:
        subprocess.run(
            ["launchctl", "bootout", f"{domain()}/{label}"],
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def launchctl_bootstrap(dest: Path) -> tuple[bool, str]:
    """Bootstrap the plist into the user gui domain. Returns (ok, stderr)."""
    try:
        result = subprocess.run(
            ["launchctl", "bootstrap", domain(), str(dest)],
            capture_output=True,
            timeout=10,
            check=False,
            text=True,
        )
        err = (result.stderr or "").strip()
        return result.returncode == 0, err
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, type(exc).__name__


def main() -> int:
    args = parse_args()
    if not args.user and not args.agents_dir:
        print("error: pass --user or --agents-dir", file=sys.stderr)
        return 2

    root = (args.plugin_root or plugin_root()).resolve()
    source = root / "launchd" / f"{LABEL}.plist"
    if not source.is_file():
        print(f"error: missing LaunchAgent SoT {source}", file=sys.stderr)
        return 2

    agents_dir = (
        args.agents_dir.expanduser().resolve()
        if args.agents_dir
        else (Path.home() / "Library" / "LaunchAgents")
    )
    dest = agents_dir / f"{LABEL}.plist"
    do_launchctl = not args.dry_run and not args.no_load

    summary: dict[str, Any] = {
        "pluginRoot": str(root),
        "source": str(source),
        "dest": str(dest),
        "label": LABEL,
        "dryRun": bool(args.dry_run),
        "changed": False,
        "loaded": False,
        "reloaded": False,
        "uninstalled": bool(args.uninstall),
        "removed": False,
    }

    if args.uninstall:
        if do_launchctl:
            launchctl_bootout(LABEL)
        if dest.is_file():
            if not args.dry_run:
                dest.unlink()
            summary["removed"] = True
        summary["loaded"] = launchctl_print_loaded(LABEL) if do_launchctl else False
        print(json.dumps(summary, indent=2))
        # Nonzero when final launchd state ≠ requested (must not stay loaded).
        if do_launchctl and summary["loaded"]:
            return 1
        return 0

    desired = source.read_bytes()
    previous = dest.read_bytes() if dest.is_file() else b""
    changed = desired != previous
    summary["changed"] = changed

    if args.dry_run:
        if do_launchctl:
            summary["loaded"] = launchctl_print_loaded(LABEL)
        print(json.dumps(summary, indent=2))
        return 0

    agents_dir.mkdir(parents=True, exist_ok=True)
    if changed:
        if dest.is_file():
            bak = dest.with_suffix(dest.suffix + ".bak")
            if not bak.exists():
                shutil.copy2(dest, bak)
                summary["backup"] = str(bak)
            else:
                summary["backup"] = str(bak)
                summary["backupNote"] = "existing .bak left in place"
        dest.write_bytes(desired)

    reloaded = False
    if do_launchctl:
        currently_loaded = launchctl_print_loaded(LABEL)
        if changed or not currently_loaded:
            launchctl_bootout(LABEL)
            ok, err = launchctl_bootstrap(dest)
            if not ok:
                summary["loaded"] = False
                summary["reloaded"] = False
                summary["bootstrapError"] = err or "bootstrap failed"
                print(json.dumps(summary, indent=2))
                return 1
            reloaded = True
        summary["loaded"] = launchctl_print_loaded(LABEL)
        summary["reloaded"] = reloaded
    else:
        summary["loaded"] = False
        summary["reloaded"] = False

    print(json.dumps(summary, indent=2))
    # Nonzero when launchctl was used and agent is not loaded after install.
    if do_launchctl and not summary["loaded"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
