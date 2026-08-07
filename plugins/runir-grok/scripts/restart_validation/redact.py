#!/usr/bin/env python3
"""Post-self-test redactor for restart-validation kits.

- Remove or stub body-bearing dumps (search/get/diagnostic/expected dual surface)
- Force mode 0600 on every retained file
- Emit secrecy-safe redact-receipt.json (0600)
- Never print canary plaintext
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import common  # noqa: E402


def _stub_or_remove(
    path: Path,
    *,
    dry_run: bool,
    remove: bool,
) -> tuple[str, dict[str, Any] | None]:
    """Return (action, stub_record). action in removed|redacted|skipped."""
    try:
        raw = path.read_bytes()
    except OSError:
        return "skipped", None
    digest = common.content_sha256(raw)
    if remove:
        if not dry_run:
            try:
                path.unlink()
            except OSError:
                return "skipped", None
        return "removed", {
            "pathBasename": path.name,
            "action": "removed",
            "contentSha256": digest,
        }

    stub = common.redact_stub(
        path=path,
        reason="body_bearing_or_dual_surface",
        content_sha256=digest,
    )
    if not dry_run:
        # Always write JSON stub into the same path (structural kit hygiene).
        common.write_private_json(path, stub)
    return "redacted", {
        "pathBasename": path.name,
        "action": "redacted",
        "contentSha256": digest,
    }


def _normalize_public_summary(kit_dir: Path, dry_run: bool) -> bool:
    """Drop dual expectedFile surface; keep hash-only canaries."""
    path = kit_dir / "public-summary.json"
    data = common.read_json(path)
    if not isinstance(data, dict):
        return False
    changed = False
    if data.get("expectedFile") not in (None, ""):
        data["expectedFile"] = None
        changed = True
    # Ensure canaries stay hash/id/label only — drop accidental plaintext keys.
    canaries = data.get("canaries")
    if isinstance(canaries, dict):
        cleaned: dict[str, Any] = {}
        for kind, row in canaries.items():
            if not isinstance(row, dict):
                continue
            safe_row: dict[str, Any] = {}
            for key in (
                "label",
                "memoryId",
                "sha256",
                "answerSha256",
                "hash",
                "query",
                "owner",
                "canaryOwner",
                "kind",
            ):
                if key in row:
                    safe_row[key] = row[key]
            # Drop known plaintext-capable keys if present
            for bad in (
                "answer",
                "plaintext",
                "value",
                "memory",
                "body",
                "text",
                "content",
            ):
                if bad in row:
                    changed = True
            if safe_row != row:
                changed = True
            cleaned[str(kind)] = safe_row
        data["canaries"] = cleaned
    data["redacted"] = True
    if changed and not dry_run:
        common.write_private_json(path, data)
    elif not dry_run:
        # Still force 0600 / redacted flag
        common.write_private_json(path, data)
        changed = True
    return changed


def redact_kit(
    kit_dir: Path,
    *,
    dry_run: bool = False,
    remove_body: bool = True,
) -> dict[str, Any]:
    kit_dir = Path(kit_dir).expanduser().resolve()
    if not kit_dir.is_dir():
        return {
            "ok": False,
            "kitDir": str(kit_dir),
            "errors": ["kit_dir_missing"],
            "counts": {
                "removed": 0,
                "redacted": 0,
                "chmodFixed": 0,
                "remainingPublic": 0,
                "remainingPrivate": 0,
            },
        }

    removed = 0
    redacted = 0
    chmod_fixed = 0
    actions: list[dict[str, Any]] = []
    errors: list[str] = []

    # 1) Body-bearing files → remove or stub
    for path in list(common.iter_kit_files(kit_dir)):
        name = path.name
        if name in common.PUBLIC_ALLOWLIST:
            continue
        if name in (
            "canary-owners.json",
            "blind-prompt.txt",
            "blind-prompt.template.txt",
        ):
            continue
        if name.endswith(".answer.txt") or name.endswith(".validator.json"):
            continue
        if name == "redact-receipt.json":
            continue

        if common.is_body_bearing_name(name):
            action, rec = _stub_or_remove(path, dry_run=dry_run, remove=remove_body)
            if action == "removed":
                removed += 1
            elif action == "redacted":
                redacted += 1
            if rec:
                actions.append(rec)
            continue

        # Attempt streams: keep but force mode (and optionally truncate to id-only)
        if common.ATTEMPT_STREAM_RE.search(name):
            # Do not expand residual content; just ensure mode.
            pass

    # 2) Drop expected.json dual surface specifically if still present
    expected = kit_dir / "expected.json"
    if expected.is_file():
        action, rec = _stub_or_remove(expected, dry_run=dry_run, remove=True)
        if action == "removed":
            removed += 1
        elif action == "redacted":
            redacted += 1
        if rec:
            actions.append(rec)

    # 3) Normalize public-summary
    _normalize_public_summary(kit_dir, dry_run=dry_run)

    # 4) chmod 0600 everything remaining
    for path in common.iter_kit_files(kit_dir):
        try:
            before = common.file_mode(path)
            if before != 0o600:
                if not dry_run:
                    os.chmod(path, 0o600)
                chmod_fixed += 1
                actions.append(
                    {
                        "pathBasename": path.name,
                        "action": "chmod_0600",
                        "modeBefore": oct(before),
                    }
                )
        except OSError:
            errors.append(f"chmod_failed:{path.name}")

    # 5) Verify no world/group readable remain
    world_readable = []
    if not dry_run:
        for path in common.iter_kit_files(kit_dir):
            if common.is_world_or_group_readable(path):
                world_readable.append(path.name)
                errors.append(f"still_readable:{path.name}")

    remaining_public = [
        p.name
        for p in common.iter_kit_files(kit_dir)
        if p.name in common.PUBLIC_ALLOWLIST
    ]
    remaining_private = [
        p.name
        for p in common.iter_kit_files(kit_dir)
        if p.name not in common.PUBLIC_ALLOWLIST
    ]

    # Residual body-bearing names check
    residual_body = [
        p.name
        for p in common.iter_kit_files(kit_dir)
        if common.is_body_bearing_name(p.name) and p.name not in common.PUBLIC_ALLOWLIST
    ]
    # Stubs that are still named body-bearing but contain redacted:true are OK if
    # remove_body was False; with remove_body True residual should be empty.
    if remove_body and residual_body:
        # If stubs left as same names, inspect for redacted flag
        still_bad: list[str] = []
        for name in residual_body:
            path = kit_dir / name
            data = common.read_json(path)
            if isinstance(data, dict) and data.get("redacted") is True:
                continue
            still_bad.append(name)
        residual_body = still_bad
        for name in residual_body:
            errors.append(f"body_residual:{name}")

    receipt: dict[str, Any] = {
        "ok": not errors and not world_readable,
        "kitDir": str(kit_dir),
        "redacted": True,
        "counts": {
            "removed": removed,
            "redacted": redacted,
            "chmodFixed": chmod_fixed,
            "remainingPublic": len(remaining_public),
            "remainingPrivate": len(remaining_private),
        },
        "remainingPublic": sorted(remaining_public),
        "remainingPrivate": sorted(remaining_private),
        "actions": actions[:200],  # bound receipt size
        "errors": errors,
    }

    if not dry_run:
        common.write_private_json(kit_dir / "redact-receipt.json", receipt)
        # Ensure receipt itself is 0600
        try:
            os.chmod(kit_dir / "redact-receipt.json", 0o600)
        except OSError:
            pass

    return receipt


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--kit-dir", type=Path, required=True, help="Kit directory to redact"
    )
    p.add_argument(
        "--dry-run", action="store_true", help="Report actions without writing"
    )
    p.add_argument(
        "--stub-body",
        action="store_true",
        help="Replace body dumps with redacted stubs instead of deleting them",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    receipt = redact_kit(
        args.kit_dir,
        dry_run=args.dry_run,
        remove_body=not args.stub_body,
    )
    # Secrecy-safe summary only
    print(
        json.dumps(
            {
                "ok": receipt.get("ok"),
                "kitDir": receipt.get("kitDir"),
                "counts": receipt.get("counts"),
                "errors": receipt.get("errors"),
            },
            separators=(",", ":"),
        )
    )
    return 0 if receipt.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
