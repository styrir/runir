#!/usr/bin/env python3
"""Hash-only canary answer validator for restart-validation kits.

Loads expected SHA-256 from kit public-summary.json (or --hashes-file).
Never echoes the answer plaintext. Exit 0 on pass, 1 on fail.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping

# Allow running as a script from any cwd.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import common  # noqa: E402

KINDS = ("ambient", "explicit", "headless")

# Frozen optional fallback for the 2026-08-05 testId only (hash-only; no plaintext).
FROZEN_HASHES: dict[str, str] = {
    "ambient": "d0c7f88c6bfad88dc575fd87d7fbda61aa1db7f6184bf527a0bfd967fdc964a1",
    "explicit": "569ef7d3f1946719d7f8235ff2565f87915ba36608ed03d8e1a8f09bdac74e27",
    "headless": "6c46c4d58c06d9e240fdce2ce74765b8ad6710e05617108a183604445b2c3f00",
}


def load_hashes(
    *,
    kit_dir: Path | None,
    hashes_file: Path | None,
    allow_frozen_fallback: bool = True,
) -> dict[str, str]:
    if hashes_file is not None:
        data = common.read_json(hashes_file)
        if not isinstance(data, dict):
            raise SystemExit(f"hashes-file is not a JSON object: {hashes_file}")
        return _extract_hashes(data)

    if kit_dir is not None:
        summary = common.load_public_summary(kit_dir)
        hashes = common.canary_hashes(summary)
        if hashes:
            return hashes
        # Nested top-level hashes map
        if isinstance(summary.get("hashes"), dict):
            nested = _extract_hashes(summary["hashes"])
            if nested:
                return nested

    if allow_frozen_fallback:
        return dict(FROZEN_HASHES)
    raise SystemExit(
        "no canary hashes found (public-summary or --hashes-file required)"
    )


def _extract_hashes(data: Mapping[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    # Direct kind -> sha
    for kind in KINDS:
        val = data.get(kind)
        if isinstance(val, str) and len(val) == 64:
            out[kind] = val.lower()
        elif isinstance(val, dict):
            for key in ("sha256", "answerSha256", "hash"):
                h = val.get(key)
                if isinstance(h, str) and len(h) == 64:
                    out[kind] = h.lower()
                    break
    if out:
        return out
    # canaries block
    canaries = data.get("canaries")
    if isinstance(canaries, dict):
        return common.canary_hashes({"canaries": canaries})
    return out


def answer_sha256(answer: str) -> str:
    return hashlib.sha256(answer.strip().encode("utf-8")).hexdigest()


def validate(
    kind: str,
    answer: str,
    hashes: Mapping[str, str],
) -> dict[str, Any]:
    if kind not in hashes:
        return {
            "kind": kind,
            "pass": False,
            "answerSha256": answer_sha256(answer),
            "expectedSha256": "",
            "error": f"no expected hash for kind={kind}",
        }
    got = answer_sha256(answer)
    expected = hashes[kind].lower()
    return {
        "kind": kind,
        "pass": got == expected,
        "answerSha256": got,
        "expectedSha256": expected,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Validate a blind Rúnir restart canary answer using SHA-256 only."
    )
    p.add_argument("--kind", choices=list(KINDS), required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--answer", help="Answer string (prefer --answer-file in operators)")
    g.add_argument("--answer-file", type=Path, help="Path to answer file")
    p.add_argument(
        "--kit-dir", type=Path, help="Kit directory containing public-summary.json"
    )
    p.add_argument(
        "--hashes-file",
        type=Path,
        help="JSON file with kind→sha256 or public-summary-shaped canaries",
    )
    p.add_argument(
        "--no-frozen-fallback",
        action="store_true",
        help="Fail if hashes cannot be loaded from kit/hashes-file",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.answer is not None:
        answer = args.answer
    else:
        answer = Path(args.answer_file).read_text(encoding="utf-8")

    kit_dir = Path(args.kit_dir).expanduser().resolve() if args.kit_dir else None
    hashes = load_hashes(
        kit_dir=kit_dir,
        hashes_file=Path(args.hashes_file).expanduser() if args.hashes_file else None,
        allow_frozen_fallback=not args.no_frozen_fallback,
    )
    result = validate(args.kind, answer, hashes)
    # Never include answer plaintext in output.
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result.get("pass") else 1


if __name__ == "__main__":
    raise SystemExit(main())
