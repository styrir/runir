#!/usr/bin/env python3
"""Secrecy-safe provenance sidecar for restart-validation kits.

Records launch method, Grok session identity, and first-prompt ordering
without contaminating the blind first prompt. Operator fills after the
blind turn or via an external sidecar process.

Never injects text into blind-prompt templates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import common  # noqa: E402

LAUNCH_METHODS = frozenset(
    {
        "fresh_quit_relaunch",
        "slash_new",
        "unknown",
    }
)

BLIND_PROMPT_NAMES = (
    "blind-prompt.txt",
    "blind-prompt.template.txt",
    "ambient.blind-prompt.txt",
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def session_digest(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def load_provenance(kit_dir: Path) -> dict[str, Any]:
    data = common.read_json(kit_dir / "provenance.json")
    return data if isinstance(data, dict) else {}


def blind_prompt_snapshot(kit_dir: Path) -> dict[str, str]:
    """sha256 of any blind prompt files (to prove provenance did not alter them)."""
    out: dict[str, str] = {}
    for name in BLIND_PROMPT_NAMES:
        path = kit_dir / name
        if path.is_file():
            try:
                out[name] = common.content_sha256(path.read_bytes())
            except OSError:
                pass
    return out


def update_provenance(
    kit_dir: Path,
    *,
    launch_method: str | None = None,
    grok_session_id: str | None = None,
    grok_session_digest: str | None = None,
    first_prompt_is_blind_ambient: bool | None = None,
    blind_prompt_ordinal: int | None = None,
    recorded_by: str = "operator",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    kit_dir = Path(kit_dir).expanduser().resolve()
    kit_dir.mkdir(parents=True, exist_ok=True)

    before_prompts = blind_prompt_snapshot(kit_dir)
    data = load_provenance(kit_dir)

    if launch_method is not None:
        if launch_method not in LAUNCH_METHODS and launch_method != "":
            # Allow extension values but keep a warning flag
            data["launchMethodWarning"] = "non_standard"
        data["launchMethod"] = launch_method or "unknown"

    if grok_session_id is not None:
        # Store digest by default; full id only if explicitly short/non-secret.
        data["grokSessionDigest"] = session_digest(grok_session_id)
        # Optional short id retention when operator opts in via digest-only path
        if grok_session_digest is None:
            # Do not store raw session id unless it looks like a UUID-sized token
            # and operator set it — store digest only for secrecy.
            pass
        data["grokSessionIdPresent"] = bool(grok_session_id.strip())

    if grok_session_digest is not None:
        data["grokSessionDigest"] = grok_session_digest.strip()

    if first_prompt_is_blind_ambient is not None:
        data["firstPromptIsBlindAmbient"] = bool(first_prompt_is_blind_ambient)

    if blind_prompt_ordinal is not None:
        data["blindPromptOrdinal"] = int(blind_prompt_ordinal)
        # Ambient gate validity: ordinal must be 1
        data["ambientGateProtocolValid"] = (
            int(blind_prompt_ordinal) == 1
            and data.get("firstPromptIsBlindAmbient") is True
        )

    data["recordedAt"] = _utc_now()
    data["recordedBy"] = recorded_by
    data["redacted"] = True
    data["contaminatesBlindPrompt"] = False

    if extra:
        for k, v in extra.items():
            if k in ("answer", "plaintext", "memory", "apiKey", "RUNIR_API_KEY"):
                continue
            data[k] = v

    common.write_private_json(kit_dir / "provenance.json", data)

    after_prompts = blind_prompt_snapshot(kit_dir)
    if before_prompts != after_prompts:
        # Should never happen — fail loud.
        data["contaminatesBlindPrompt"] = True
        data["errors"] = data.get("errors") or []
        if isinstance(data["errors"], list):
            data["errors"].append("blind_prompt_mutated")
        common.write_private_json(kit_dir / "provenance.json", data)
        raise RuntimeError("provenance write mutated blind prompt files")

    data["_blindPromptDigests"] = after_prompts
    return data


def parse_set_args(pairs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in pairs:
        if "=" not in raw:
            raise SystemExit(f"invalid --set (expected key=value): {raw}")
        k, v = raw.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--kit-dir", type=Path, required=True)
    p.add_argument(
        "--set",
        action="append",
        default=[],
        dest="sets",
        help="key=value (launchMethod, grokSessionId, grokSessionDigest, "
        "firstPromptIsBlindAmbient, blindPromptOrdinal, recordedBy)",
    )
    p.add_argument(
        "--show",
        action="store_true",
        help="Print current provenance.json (secrecy-safe fields only)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    kit_dir = Path(args.kit_dir).expanduser().resolve()

    if args.show and not args.sets:
        data = load_provenance(kit_dir)
        print(json.dumps(data, separators=(",", ":")))
        return 0

    pairs = parse_set_args(args.sets)
    launch_method = pairs.pop("launchMethod", None)
    grok_session_id = pairs.pop("grokSessionId", None)
    grok_session_digest = pairs.pop("grokSessionDigest", None)
    recorded_by = pairs.pop("recordedBy", "operator")

    first_prompt = pairs.pop("firstPromptIsBlindAmbient", None)
    first_prompt_bool: bool | None = None
    if first_prompt is not None:
        first_prompt_bool = first_prompt.lower() in ("1", "true", "yes")

    ordinal_raw = pairs.pop("blindPromptOrdinal", None)
    ordinal: int | None = None
    if ordinal_raw is not None:
        ordinal = int(ordinal_raw)

    data = update_provenance(
        kit_dir,
        launch_method=launch_method,
        grok_session_id=grok_session_id,
        grok_session_digest=grok_session_digest,
        first_prompt_is_blind_ambient=first_prompt_bool,
        blind_prompt_ordinal=ordinal,
        recorded_by=recorded_by,
        extra=pairs or None,
    )
    # Drop internal-only key from stdout
    data.pop("_blindPromptDigests", None)
    print(json.dumps(data, separators=(",", ":")))
    return 0 if not data.get("contaminatesBlindPrompt") else 1


if __name__ == "__main__":
    raise SystemExit(main())
