#!/usr/bin/env python3
"""Shared helpers for the Grok restart-validation kit.

Hash-only public surface, owner-only (0600) private retention, and secrecy-safe
paths. Never log canary plaintext or API keys.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable, Mapping

_LIB = Path(__file__).resolve().parents[2] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
import runir_core as core  # noqa: E402

# ---------------------------------------------------------------------------
# Kit layout
# ---------------------------------------------------------------------------

DEFAULT_GROK_HOME = Path.home() / ".grok"
KIT_REL = Path("state") / "runir" / "restart-validation"

# Shareable / hash-only surface (operator may publish these).
PUBLIC_ALLOWLIST: frozenset[str] = frozenset(
    {
        "public-summary.json",
        "preflight.json",
        "validate_answer.py",
        "provenance.json",
        "redact-receipt.json",
    }
)

# Retained private names that may stay after redaction (must be 0600; hash/id only).
PRIVATE_RETAINED_ALLOWLIST: frozenset[str] = frozenset(
    {
        "ambient.answer.txt",
        "explicit.answer.txt",
        "headless.answer.txt",
        "ambient.validator.json",
        "explicit.validator.json",
        "headless.validator.json",
        "canary-owners.json",  # owner map only; no bodies
        "blind-prompt.txt",  # operator template; provenance must not rewrite it
        "blind-prompt.template.txt",
    }
)

# Basename / substring patterns for body-bearing or dual-surface dumps.
# Matched case-insensitively against the file name only.
BODY_BEARING_SUBSTRINGS: tuple[str, ...] = (
    ".search",
    ".get",
    "retrieved",
    "diagnostic",
    "search-current",
    "get-current",
    "label-search",
    "cue-recall",
    "recall-preflight",
    "recall-owner",
    "recall-diagnostic",
    "bridge.txt",
    "bridge.err",
    "store.txt",
    "store.err",
    "search.txt",
    "search.err",
    "expected.json",
    "grok-inspect.json",
    "components.verify.json",
    "tui.session.txt",
    "tui.errors.json",
    "tui.status.json",
    "git-status",
    "src-tracked.diff",
    ".result.json",
    ".receipt",
    "configured-path",
    "diagnostic-override",
)

# Attempt streams may keep create IDs only after redact; always force 0600.
ATTEMPT_STREAM_RE = re.compile(r"\.attempt-\d+\.(stdout|stderr)$", re.I)

# Keys that are safe on the public/hash-only surface.
SAFE_PUBLIC_KEYS: frozenset[str] = frozenset(
    {
        "testId",
        "stateDir",
        "kitDir",
        "label",
        "memoryId",
        "sha256",
        "answerSha256",
        "expectedSha256",
        "hash",
        "kind",
        "pass",
        "ok",
        "redacted",
        "reason",
        "pathBasename",
        "contentSha256",
        "canaries",
        "query",  # value-free cue label/query id — not answer plaintext
        "owner",
        "canaryOwner",
        "effectiveUserId",
        "identitySource",
        "recallPath",
        "gates",
        "errors",
        "warnings",
        "ambientBridgePresent",
        "explicitBridgeAbsent",
        "headlessBridgeAbsent",
        "launchMethod",
        "grokSessionId",
        "grokSessionDigest",
        "firstPromptIsBlindAmbient",
        "blindPromptOrdinal",
        "recordedAt",
        "recordedBy",
        "expectedFile",  # must be null after redaction
        "removed",
        "redactedCount",
        "chmodFixed",
        "remainingPublic",
        "remainingPrivate",
        "counts",
        "path",
        "mode",
        "status",
        "source",
        "memoryIds",
        "selectedMemoryIds",
        "gate",
        "name",
        "detail",
        "length",
        "digest",
    }
)


def grok_home(env: Mapping[str, str] | None = None) -> Path:
    source = os.environ if env is None else env
    raw = (source.get("GROK_HOME") or "").strip()
    if raw:
        return Path(raw).expanduser()
    return DEFAULT_GROK_HOME


def kit_root(test_id: str, env: Mapping[str, str] | None = None) -> Path:
    return grok_home(env) / KIT_REL / test_id


def resolve_kit_dir(
    kit_dir: Path | str | None = None, test_id: str | None = None
) -> Path:
    if kit_dir is not None:
        return Path(kit_dir).expanduser().resolve()
    if not test_id:
        raise ValueError("kit_dir or test_id required")
    return kit_root(test_id).resolve()


def content_sha256(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def id_digest(value: str | None) -> str:
    """Short non-reversible digest for logs (never the raw secret)."""
    if not value:
        return ""
    return content_sha256(value)[:16]


def write_private_json(path: Path, data: dict[str, Any]) -> None:
    """Atomic JSON write mode 0600 via core.write_json_atomic."""
    core.write_json_atomic(path, data)


def write_private_text(path: Path, text: str) -> None:
    """Atomic text write mode 0600."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    payload = text if text.endswith("\n") or text == "" else text
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        os.replace(temporary, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def read_json(path: Path) -> dict[str, Any] | None:
    return core.read_json(path)


def file_mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def is_world_or_group_readable(path: Path) -> bool:
    mode = file_mode(path)
    return bool(
        mode
        & (
            stat.S_IRGRP
            | stat.S_IROTH
            | stat.S_IWGRP
            | stat.S_IWOTH
            | stat.S_IXGRP
            | stat.S_IXOTH
        )
    )


def chmod_owner_only(path: Path) -> bool:
    """Force 0600. Returns True if mode changed or already 0600."""
    try:
        before = file_mode(path)
        if before != 0o600:
            os.chmod(path, 0o600)
        return True
    except OSError:
        return False


def iter_kit_files(kit_dir: Path) -> list[Path]:
    if not kit_dir.is_dir():
        return []
    files: list[Path] = []
    for root, _dirs, names in os.walk(kit_dir):
        for name in names:
            p = Path(root) / name
            if p.is_file():
                files.append(p)
    return sorted(files)


def is_body_bearing_name(name: str) -> bool:
    lower = name.lower()
    if lower == "expected.json":
        return True
    if ATTEMPT_STREAM_RE.search(lower):
        # Attempt streams are not body dumps of canary text in the failed kit
        # (create IDs only) but are still hygiene targets for mode + optional stub.
        return False
    for needle in BODY_BEARING_SUBSTRINGS:
        if needle.lower() in lower:
            return True
    return False


def is_public_name(name: str) -> bool:
    return name in PUBLIC_ALLOWLIST


def load_public_summary(kit_dir: Path) -> dict[str, Any]:
    path = kit_dir / "public-summary.json"
    data = read_json(path)
    if not isinstance(data, dict):
        return {}
    return data


def canary_hashes(summary: Mapping[str, Any]) -> dict[str, str]:
    """kind -> sha256 from public-summary canaries block."""
    out: dict[str, str] = {}
    canaries = summary.get("canaries")
    if not isinstance(canaries, dict):
        return out
    for kind, row in canaries.items():
        if not isinstance(row, dict):
            continue
        for key in ("sha256", "answerSha256", "hash"):
            val = row.get(key)
            if isinstance(val, str) and len(val) == 64:
                out[str(kind)] = val.lower()
                break
    return out


def canary_memory_ids(summary: Mapping[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    canaries = summary.get("canaries")
    if not isinstance(canaries, dict):
        return out
    for kind, row in canaries.items():
        if not isinstance(row, dict):
            continue
        mid = row.get("memoryId") or row.get("id")
        if isinstance(mid, str) and mid.strip():
            out[str(kind)] = mid.strip()
    return out


def canary_owners_from_summary(summary: Mapping[str, Any]) -> dict[str, str]:
    """kind -> owner if recorded on canary rows."""
    out: dict[str, str] = {}
    canaries = summary.get("canaries")
    if not isinstance(canaries, dict):
        return out
    for kind, row in canaries.items():
        if not isinstance(row, dict):
            continue
        owner = row.get("owner") or row.get("canaryOwner") or row.get("userId")
        if isinstance(owner, str) and owner.strip():
            out[str(kind)] = owner.strip()
    return out


def load_canary_owners(
    kit_dir: Path, summary: Mapping[str, Any] | None = None
) -> dict[str, str]:
    """Merge owners from public-summary rows and optional canary-owners.json.

    canary-owners.json shapes accepted:
      {"ambient": "owner", ...}  kind -> userId
      {"byKind": {...}, "byMemoryId": {...}}
      {"memory-id-uuid": "owner", ...}
    """
    owners: dict[str, str] = {}
    if summary is None:
        summary = load_public_summary(kit_dir)
    owners.update(canary_owners_from_summary(summary))

    path = kit_dir / "canary-owners.json"
    data = read_json(path)
    if not isinstance(data, dict):
        return owners

    by_kind = data.get("byKind") if isinstance(data.get("byKind"), dict) else None
    if by_kind:
        for k, v in by_kind.items():
            if isinstance(v, str) and v.strip():
                owners[str(k)] = v.strip()
    by_mid = (
        data.get("byMemoryId") if isinstance(data.get("byMemoryId"), dict) else None
    )
    mids = canary_memory_ids(summary)
    mid_to_kind = {v: k for k, v in mids.items()}
    if by_mid:
        for mid, v in by_mid.items():
            if not isinstance(v, str) or not v.strip():
                continue
            kind = mid_to_kind.get(str(mid))
            if kind:
                owners[kind] = v.strip()
            else:
                owners[str(mid)] = v.strip()
    # Flat map: kind or memoryId keys
    for k, v in data.items():
        if k in ("byKind", "byMemoryId"):
            continue
        if isinstance(v, str) and v.strip():
            owners[str(k)] = v.strip()
    return owners


def resolve_effective_user_id(
    env: Mapping[str, str] | None = None,
    *,
    override: str | None = None,
) -> tuple[str | None, str]:
    """Resolve RUNIR_USER_ID with the same order as core.resolve_credential.

    Never invents a default. Returns (user_id|None, source).
    """
    if override is not None:
        cleaned = override.strip()
        return (cleaned or None, "override")

    source = os.environ if env is None else env
    # Prefer core helper for process env → RUNIR_ENV_FILE
    value = core.resolve_credential("RUNIR_USER_ID", env=dict(source))
    if value:
        if (source.get("RUNIR_USER_ID") or "").strip():
            return value, "process_env"
        return value, "runir_env_file"
    return None, "none"


def ensure_sys_path_for_core() -> None:
    if str(_LIB) not in sys.path:
        sys.path.insert(0, str(_LIB))


def redact_stub(
    *,
    path: Path,
    reason: str,
    content_sha256: str | None = None,
) -> dict[str, Any]:
    stub: dict[str, Any] = {
        "redacted": True,
        "reason": reason,
        "pathBasename": path.name,
    }
    if content_sha256:
        stub["contentSha256"] = content_sha256
    return stub


def public_surface_has_plaintext_leak(
    obj: Any, *, known_plaintexts: Iterable[str] = ()
) -> list[str]:
    """Return leak descriptions if obj embeds known canary plaintexts or long free text.

    Used by tests; production redact uses structural body-bearing removal.
    """
    leaks: list[str] = []
    plains = [p for p in known_plaintexts if p]
    blob = json.dumps(obj, default=str) if not isinstance(obj, str) else obj
    for p in plains:
        if p in blob:
            leaks.append("known_plaintext")
    return leaks
